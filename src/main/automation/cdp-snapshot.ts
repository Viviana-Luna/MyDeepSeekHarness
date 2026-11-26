/**
 * CDP 快照与敏感场景检测辅助：生成紧凑 `@eN` 交互元素树，并识别 CAPTCHA、支付页与密码登录。
 * 纯函数模块，不直接操作传输层，供 `cdp-engine.ts` 与单元测试共用。
 */
import type { CdpHandoffInfo, CdpSnapshotElement } from './cdp-transport.ts'

/** 注入页面读取可见交互元素与安全信号的只读脚本，不修改任何页面 DOM 状态。 */
export const COLLECT_DOM_SNAPSHOT_SCRIPT = `(() => {
  const MAX_ITEMS = 220;
  const vw = Math.max(1, window.innerWidth || document.documentElement.clientWidth || 1280);
  const vh = Math.max(1, window.innerHeight || document.documentElement.clientHeight || 800);
  const selector = [
    'a[href]',
    'button',
    'input:not([type="hidden"])',
    'textarea',
    'select',
    '[role="button"]',
    '[role="link"]',
    '[role="textbox"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="switch"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="combobox"]',
    '[contenteditable="true"]'
  ].join(',');
  const nodes = Array.from(document.querySelectorAll(selector));
  const elements = [];
  let hasPasswordInput = false;
  let hasCaptcha = false;
  const captchaHosts = ['recaptcha', 'hcaptcha', 'challenges.cloudflare.com', 'turnstile', 'arkoselabs', 'geetest'];
  for (const frame of Array.from(document.querySelectorAll('iframe'))) {
    const src = (frame.getAttribute('src') || '').toLowerCase();
    const title = (frame.getAttribute('title') || '').toLowerCase();
    if (captchaHosts.some(h => src.includes(h)) || title.includes('captcha') || title.includes('recaptcha') || title.includes('hcaptcha')) {
      hasCaptcha = true;
    }
  }
  if (!hasCaptcha && document.querySelector('.g-recaptcha, .h-captcha, .cf-turnstile, [data-sitekey]')) {
    hasCaptcha = true;
  }
  const clean = value => String(value || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
  const visible = el => {
    const style = window.getComputedStyle(el);
    if (!style || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width >= 2 && rect.height >= 2;
  };
  for (const el of nodes) {
    if (elements.length >= MAX_ITEMS) break;
    if (!visible(el)) continue;
    const tag = el.tagName.toLowerCase();
    const inputType = tag === 'input' ? String(el.type || el.getAttribute('type') || 'text').trim().toLowerCase() : undefined;
    if (inputType === 'password') hasPasswordInput = true;
    const rect = el.getBoundingClientRect();
    const inViewport = rect.bottom >= 0 && rect.right >= 0 && rect.top <= vh && rect.left <= vw;
    const ariaLabel = clean(el.getAttribute('aria-label'));
    const labelText = el.id ? clean(document.querySelector('label[for="' + CSS.escape(el.id) + '"]')?.textContent) : '';
    const text = clean(el.innerText || el.textContent || el.getAttribute('title') || el.getAttribute('alt'));
    const placeholder = clean(el.getAttribute('placeholder'));
    const name = ariaLabel || labelText || text || placeholder || tag;
    const role = clean(el.getAttribute('role')) || (tag === 'a' ? 'link' : tag === 'button' ? 'button' : tag === 'select' ? 'combobox' : tag === 'textarea' ? 'textbox' : inputType || tag);
    let value = undefined;
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      value = inputType === 'password' ? (el.value ? '••••••' : '') : clean(el.value);
    }
    const idAttr = el.id ? '#' + CSS.escape(el.id) : '';
    elements.push({
      tag,
      role,
      name,
      value,
      placeholder: placeholder || undefined,
      href: tag === 'a' ? clean(el.getAttribute('href')) : undefined,
      inputType,
      disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'),
      checked: typeof el.checked === 'boolean' && (inputType === 'checkbox' || inputType === 'radio') ? el.checked : undefined,
      inViewport,
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      center: { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) },
      selectorHint: idAttr || undefined
    });
  }
  const headings = Array.from(document.querySelectorAll('h1,h2,h3')).slice(0, 8).map(h => clean(h.textContent)).filter(Boolean);
  const bodySnippet = clean((document.body && document.body.innerText) || '').slice(0, 1200);
  return {
    url: location.href,
    title: document.title || '',
    viewport: { width: vw, height: vh },
    scroll: { x: Math.round(window.scrollX || 0), y: Math.round(window.scrollY || 0) },
    headings,
    bodySnippet,
    elements,
    signals: { hasCaptcha, hasPasswordInput }
  };
})()`

/** 原始 DOM 采集返回值类型。 */
export interface RawDomSnapshot {
  url: string
  title: string
  viewport: { width: number; height: number }
  scroll?: { x: number; y: number }
  headings: string[]
  bodySnippet: string
  elements: Omit<CdpSnapshotElement, 'ref'>[]
  signals: { hasCaptcha: boolean; hasPasswordInput: boolean }
}

const PAYMENT_URL_PATTERN =
  /(?:checkout|payment|pay\.|billing|stripe\.com|paypal\.com|alipay\.com|wx\.tenpay\.com)/iu
const CAPTCHA_TEXT_PATTERN =
  /(?:verify you are human|i am not a robot|cloudflare turnstile|人机验证|请完成安全验证|滑动拼图)/iu
const SENSITIVE_ACTION_PATTERN =
  /(?:pay now|complete purchase|place order|confirm payment|立即支付|确认付款|提交订单|确认支付|转账|结算)/iu

/** 根据页面 URL、标题与采集信号判断是否必须交回人工处理（绝不绕过验证码或自动支付）。 */
export function detectSensitiveHandoff(input: {
  url: string
  title: string
  bodySnippet?: string
  hasCaptcha?: boolean
  hasPasswordInput?: boolean
}): CdpHandoffInfo | undefined {
  if (input.hasCaptcha || CAPTCHA_TEXT_PATTERN.test(`${input.title} ${input.bodySnippet ?? ''}`)) {
    return {
      required: true,
      category: 'captcha',
      reason: '页面包含人机验证或验证码挑战，请由用户手动完成验证后再继续。',
      url: input.url,
    }
  }
  if (PAYMENT_URL_PATTERN.test(input.url)) {
    return {
      required: true,
      category: 'payment',
      reason: '当前位于支付或结算页面，涉及资金操作必须由用户亲自确认与完成。',
      url: input.url,
    }
  }
  if (input.hasPasswordInput) {
    return {
      required: true,
      category: 'auth',
      reason: '当前页面包含密码输入框，建议由用户手动完成登录凭据输入后再继续自动化。',
      url: input.url,
    }
  }
  return undefined
}

/** 判断即将点击的元素文案是否命中敏感支付提交按钮。 */
export function isSensitiveSubmitElement(
  element: Pick<CdpSnapshotElement, 'name' | 'tag' | 'role' | 'inputType'>,
): boolean {
  if (element.inputType === 'password') return true
  if (element.tag === 'button' || element.role === 'button' || element.inputType === 'submit') {
    return SENSITIVE_ACTION_PATTERN.test(element.name)
  }
  return false
}

function formatElementLine(item: CdpSnapshotElement): string {
  const flags: string[] = []
  if (item.disabled) flags.push('disabled')
  if (item.checked === true) flags.push('checked')
  if (!item.inViewport) flags.push('offscreen')
  const valuePart = item.value ? ` value=${JSON.stringify(item.value.slice(0, 40))}` : ''
  const flagPart = flags.length > 0 ? ` [${flags.join(',')}]` : ''
  return `${item.ref} [${item.role}] ${JSON.stringify(item.name)}${valuePart}${flagPart} (x=${item.center.x}, y=${item.center.y})`
}

/** 将采集到的页面元素按视口优先顺序编号为 `@e1`、`@e2`... 并裁剪到字节上限以内。 */
export function buildNumberedSnapshot(
  raw: RawDomSnapshot,
  axSummaryLines: readonly string[],
  maxBytes = 32 * 1024,
): { elements: CdpSnapshotElement[]; tree: string; truncated: boolean } {
  const ordered = [
    ...raw.elements.filter(item => item.inViewport),
    ...raw.elements.filter(item => !item.inViewport),
  ]
  const elements: CdpSnapshotElement[] = ordered.map((item, index) => ({
    ...item,
    ref: `@e${index + 1}`,
  }))
  const headerLines = [
    `URL: ${raw.url}`,
    `Title: ${raw.title || '(无标题)'}`,
    `Viewport: ${raw.viewport.width}x${raw.viewport.height}`,
    ...(raw.headings.length > 0 ? [`Headings: ${raw.headings.join(' | ')}`] : []),
    '',
    'Interactive Elements:',
  ]
  const lines = [...headerLines]
  let truncated = false
  for (const item of elements) {
    const line = formatElementLine(item)
    const candidate = `${lines.join('\n')}\n${line}`
    if (Buffer.byteLength(candidate, 'utf8') > maxBytes - 512) {
      truncated = true
      break
    }
    lines.push(line)
  }
  if (!truncated && axSummaryLines.length > 0) {
    lines.push('', 'Accessibility Landmarks:')
    for (const axLine of axSummaryLines) {
      const candidate = `${lines.join('\n')}\n${axLine}`
      if (Buffer.byteLength(candidate, 'utf8') > maxBytes - 256) {
        truncated = true
        break
      }
      lines.push(axLine)
    }
  }
  if (!truncated && raw.bodySnippet) {
    const excerpt = `\nPage Text Excerpt:\n${raw.bodySnippet}`
    if (Buffer.byteLength(`${lines.join('\n')}${excerpt}`, 'utf8') <= maxBytes) {
      lines.push(excerpt)
    } else {
      truncated = true
    }
  }
  return { elements, tree: lines.join('\n'), truncated }
}

/** 从 CDP `Accessibility.getFullAXTree` 节点中提取紧凑语义地标摘要。 */
export function summarizeAxTreeNodes(nodes: unknown): string[] {
  if (!Array.isArray(nodes)) return []
  const landmarkRoles = new Set([
    'main',
    'navigation',
    'banner',
    'contentinfo',
    'form',
    'dialog',
    'alert',
    'heading',
    'status',
  ])
  const lines: string[] = []
  for (const entry of nodes) {
    if (lines.length >= 24) break
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const roleVal = (record.role as { value?: unknown } | undefined)?.value
    const nameVal = (record.name as { value?: unknown } | undefined)?.value
    if (typeof roleVal !== 'string' || !landmarkRoles.has(roleVal.toLowerCase())) continue
    const label = typeof nameVal === 'string' ? nameVal.trim().slice(0, 80) : ''
    lines.push(`- ${roleVal}${label ? `: ${label}` : ''}`)
  }
  return lines
}

/** 构造在坐标点检查即将点击元素是否属于密码框或敏感支付提交按钮的只读脚本。 */
export function buildInspectPointElementScript(x: number, y: number): string {
  return `(() => {
    const raw = document.elementFromPoint(${Math.round(x)}, ${Math.round(y)});
    if (!raw) return null;
    const el = raw.closest('button, input, a, [role="button"]') || raw;
    const tag = el.tagName.toLowerCase();
    const inputType = tag === 'input' ? String(el.type || el.getAttribute('type') || 'text').trim().toLowerCase() : undefined;
    const role = String(el.getAttribute('role') || (tag === 'button' ? 'button' : inputType || tag)).trim().toLowerCase();
    const name = String(el.getAttribute('aria-label') || el.innerText || el.textContent || el.getAttribute('placeholder') || el.getAttribute('value') || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
    return { tag, role, name, inputType };
  })()`
}

/** 检查当前页面活跃焦点元素是否为密码输入框，拦截无 ref 绕过密码交接。 */
export const CHECK_ACTIVE_ELEMENT_PASSWORD_SCRIPT = `(() => {
  const el = document.activeElement;
  if (!el || el.tagName !== 'INPUT') return false;
  return String(el.type || el.getAttribute('type') || '').trim().toLowerCase() === 'password';
})()`

/** 构造在后台未聚焦视图下补写 `<input>`/`<textarea>` 值的兼容脚本（仅在 `Input.insertText` 未生效时触发）。 */
export function buildFallbackInputScript(options: {
  hint: string | null
  x: number
  y: number
  text: string
  clear: boolean
}): string {
  return `(() => {
    const hint = ${JSON.stringify(options.hint)};
    const el = (hint && document.querySelector(hint)) || document.elementFromPoint(${options.x}, ${options.y});
    if (!el || (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA')) return;
    if (el.tagName === 'INPUT' && String(el.type || el.getAttribute('type') || '').trim().toLowerCase() === 'password') return;
    const expected = ${JSON.stringify(options.text)};
    if (el.value && el.value.includes(expected)) return;
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    const nextValue = ${options.clear ? 'expected' : '(el.value || "") + expected'};
    if (setter) setter.call(el, nextValue);
    else el.value = nextValue;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  })()`
}

/** 构造在 `<select>` 元素上按 value 或可见文本选中选项并派发事件的脚本。 */
export function buildSelectOptionScript(options: {
  hint: string | null
  x: number
  y: number
  value?: string
  label?: string
}): string {
  return `(() => {
    const hint = ${JSON.stringify(options.hint)};
    let select = hint ? document.querySelector(hint) : null;
    if (select && select.tagName !== 'SELECT') select = select.closest('select');
    if (!select) {
      const hit = document.elementFromPoint(${options.x}, ${options.y});
      select = hit && (hit.tagName === 'SELECT' ? hit : hit.closest('select'));
    }
    if (!select) {
      select = Array.from(document.querySelectorAll('select')).find(el => {
        const r = el.getBoundingClientRect();
        return ${options.x} >= r.left - 4 && ${options.x} <= r.right + 4 && ${options.y} >= r.top - 4 && ${options.y} <= r.bottom + 4;
      }) || null;
    }
    if (!select) return { ok: false, error: '目标元素不是下拉选择框 <select>' };
    const wantValue = ${JSON.stringify(options.value ?? null)};
    const wantLabel = ${JSON.stringify(options.label ?? null)};
    const option = Array.from(select.options).find(opt =>
      (wantValue !== null && opt.value === wantValue) ||
      (wantLabel !== null && opt.text.trim() === wantLabel.trim())
    );
    if (!option) return { ok: false, error: '未在下拉列表中找到匹配选项' };
    select.value = option.value;
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, selectedValue: option.value, selectedLabel: option.text.trim() };
  })()`
}
