/**
 * `@mydsh/computer-use/tools` 插件入口：向后台 Runtime 注册 8 个受控系统级桌面操控工具。
 * 所有操作均执行参数白名单预校验、透明摘要展示、主会话隔离、单窗口/黑名单守卫、确认卡授权与全局急停护栏。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { renderConnectionOutput, runConnectionTool } from '@mydsh/connection-access/output'
import {
  assertAllowedFields,
  createComputerSessionGrantStore,
  type ComputerSessionGrantStore,
} from './policy.ts'
import {
  COMPUTER_SCREENSHOT_OUTPUT_SCHEMA,
  renderComputerScreenshotOutput,
} from './screenshot-output.ts'
import {
  executeComputerFocusWindow,
  executeComputerInputAction,
  executeComputerScreenshot,
  executeComputerStatus,
} from './tools-handlers.ts'

const JSON_OUTPUT = { type: 'json' as const }

function formatTypeSummary(input: Record<string, unknown>): string {
  const text = typeof input.text === 'string' ? input.text : ''
  const preview =
    text.length > 1200 ? `${text.slice(0, 1200)}…（共 ${text.length} 字符，已截断预览）` : text
  const flags: string[] = []
  if (typeof input.ref === 'string' && input.ref) flags.push(`控件 ${input.ref}`)
  if (input.clear === true) flags.push('先清空')
  if (input.submit === true) flags.push('输入后按 Enter 提交')
  const suffix = flags.length > 0 ? ` [${flags.join('，')}]` : ''
  return `输入文本（${text.length} 字符）${suffix}：${JSON.stringify(preview)}`
}

function formatKeySummary(
  key: string,
  modifiers: readonly string[],
): {
  summary: string
  highRisk: boolean
} {
  const combo = modifiers.length > 0 ? `${modifiers.join('+')}+${key}` : key
  const lowered = combo.toLowerCase()
  const highRisk =
    /(?:meta|cmd|command|win|super|alt).*\+(?:q|w|f4|backspace|delete)/iu.test(lowered) ||
    /(?:ctrl|control).*\+(?:w|q)/iu.test(lowered)
  return { summary: `发送按键：${combo}`, highRisk }
}

function formatClickSummary(input: Record<string, unknown>): string {
  const targetText =
    typeof input.ref === 'string' && input.ref
      ? `控件 ${input.ref}`
      : `坐标 (${String(input.x)}, ${String(input.y)})`
  const details: string[] = []
  if (input.button === 'right') details.push('右键')
  else if (input.button === 'middle') details.push('中键')
  if (typeof input.click_count === 'number' && input.click_count > 1) {
    details.push(`${input.click_count} 连击`)
  }
  if (Array.isArray(input.modifiers) && input.modifiers.length > 0) {
    details.push(`修饰键 ${input.modifiers.join('+')}`)
  }
  return details.length > 0 ? `点击 ${targetText}（${details.join('，')}）` : `点击 ${targetText}`
}

function registerInspectionAndWindowTools(ctx: Context, grants: ComputerSessionGrantStore): void {
  ctx.tools.register(
    defineTool({
      name: 'computer_status',
      description:
        '查看当前平台（macOS/Windows）桌面 Computer Use 启用状态、系统权限（辅助功能/屏幕录制）、显示器清单与过滤敏感应用后的可见窗口列表。',
      parameters: {},
      output: { schema: JSON_OUTPUT, render: (_a, v) => renderConnectionOutput(v) },
      execute(args, exec) {
        return runConnectionTool(() => {
          assertAllowedFields(args as Record<string, unknown>, new Set(), 'computer_status')
          return executeComputerStatus(ctx, exec)
        })
      },
    }),
  )
  ctx.tools.register(
    defineTool({
      name: 'computer_screenshot',
      description:
        '截取已授权显示器或指定窗口的桌面画面并返回 capture_id 与多模态图片附件；macOS 下指定 window_id/pid 可直接抓取后台非焦点窗口画面（即使被遮挡也不必切焦点），后续坐标操作将自动定向该后台窗口。需要视觉模型支持。',
      parameters: {
        display_id: { type: 'integer', description: '可选显示器 ID（来自 computer_status）。' },
        window_id: {
          type: 'integer',
          description: '可选窗口 ID；推荐优先指定以便在后台无焦点定向操作目标窗口。',
        },
        pid: { type: 'integer', description: '可选应用进程 PID。' },
      },
      output: {
        schema: COMPUTER_SCREENSHOT_OUTPUT_SCHEMA,
        render: (_args, value) => renderComputerScreenshotOutput(value),
      },
      execute(args, exec) {
        return runConnectionTool(() => {
          assertAllowedFields(
            args as Record<string, unknown>,
            new Set(['display_id', 'window_id', 'pid']),
            'computer_screenshot',
          )
          return executeComputerScreenshot(
            ctx,
            exec,
            grants,
            args as Parameters<typeof executeComputerScreenshot>[3],
          )
        })
      },
    }),
  )
  ctx.tools.register(
    defineTool({
      name: 'computer_focus_window',
      description:
        '可选工具：仅当目标应用不支持后台无焦点事件、或明确需要把窗口置前时调用；macOS 下普通后台操作无需先调用本工具抢焦点。禁止聚焦钥匙串/密码管理器或 MyDSH 自身窗口。',
      parameters: {
        window_id: { type: 'integer', description: '目标窗口 ID（来自 computer_status）。' },
        pid: { type: 'integer', description: '目标进程 PID（与 window_id 至少提供一个）。' },
      },
      output: { schema: JSON_OUTPUT, render: (_a, v) => renderConnectionOutput(v) },
      execute(args, exec) {
        return runConnectionTool(() => {
          assertAllowedFields(
            args as Record<string, unknown>,
            new Set(['window_id', 'pid']),
            'computer_focus_window',
          )
          return executeComputerFocusWindow(
            ctx,
            exec,
            grants,
            args as Parameters<typeof executeComputerFocusWindow>[3],
          )
        })
      },
    }),
  )
}

function registerMouseTools(ctx: Context, grants: ComputerSessionGrantStore): void {
  ctx.tools.register(
    defineTool({
      name: 'computer_click',
      description:
        '点击目标桌面控件：优先传入 computer_screenshot 返回的无障碍控件编号 ref（如 "@u3"，零坐标偏移并支持 macOS 纯后台 AX 直达），或传入截图坐标系 (x, y)（自动补偿窗口位移与 Retina/DPI 缩放，需要时瞬时微激活并自动还原焦点与原鼠标）。',
      parameters: {
        capture_id: {
          type: 'string',
          required: true,
          description: 'computer_screenshot 返回的 capture_id。',
        },
        ref: {
          type: 'string',
          description:
            '优先使用：computer_screenshot 控件索引中的 @uN 编号（提供 ref 时可省略 x/y）。',
        },
        x: { type: 'number', description: '截图图片内的横坐标（未提供 ref 时必填）。' },
        y: { type: 'number', description: '截图图片内的纵坐标（未提供 ref 时必填）。' },
        button: {
          type: 'string',
          enum: ['left', 'right', 'middle'],
          description: '鼠标按键（默认 left）。',
        },
        click_count: { type: 'integer', description: '点击次数（1 至 3，默认 1）。' },
        modifiers: {
          type: 'array',
          items: { type: 'string' },
          description: '可选修饰键，如 ["Shift"]。',
        },
      },
      output: { schema: JSON_OUTPUT, render: (_a, v) => renderConnectionOutput(v) },
      execute(args, exec) {
        return runConnectionTool(() => {
          const input = args as Record<string, unknown>
          assertAllowedFields(
            input,
            new Set(['capture_id', 'ref', 'x', 'y', 'button', 'click_count', 'modifiers']),
            'computer_click',
          )
          const hasRef = typeof input.ref === 'string' && input.ref.trim().length > 0
          const hasPoint =
            typeof input.x === 'number' &&
            Number.isFinite(input.x) &&
            typeof input.y === 'number' &&
            Number.isFinite(input.y)
          if (!hasRef && !hasPoint) {
            throw new Error('computer_click 必须提供控件编号 ref 或有效的有限坐标 (x, y)')
          }
          return executeComputerInputAction(ctx, exec, grants, {
            action: 'click',
            summary: formatClickSummary(input),
            payload: {
              captureId: input.capture_id,
              ...(hasRef ? { ref: input.ref } : {}),
              ...(typeof input.x === 'number' ? { x: input.x } : {}),
              ...(typeof input.y === 'number' ? { y: input.y } : {}),
              ...(typeof input.button === 'string' ? { button: input.button } : {}),
              ...(typeof input.click_count === 'number' ? { clickCount: input.click_count } : {}),
              ...(Array.isArray(input.modifiers) ? { modifiers: input.modifiers } : {}),
            },
          })
        })
      },
    }),
  )
  ctx.tools.register(
    defineTool({
      name: 'computer_drag',
      description:
        '在指定 capture_id 截图坐标系中按左键从 (from_x, from_y) 平滑拖拽到 (to_x, to_y)。',
      parameters: {
        capture_id: {
          type: 'string',
          required: true,
          description: 'computer_screenshot 返回的 capture_id。',
        },
        from_x: { type: 'number', required: true, description: '起点横坐标。' },
        from_y: { type: 'number', required: true, description: '起点纵坐标。' },
        to_x: { type: 'number', required: true, description: '终点横坐标。' },
        to_y: { type: 'number', required: true, description: '终点纵坐标。' },
        steps: { type: 'integer', description: '插值步数（2 至 30，默认 12）。' },
      },
      output: { schema: JSON_OUTPUT, render: (_a, v) => renderConnectionOutput(v) },
      execute(args, exec) {
        return runConnectionTool(() => {
          const input = args as Record<string, unknown>
          assertAllowedFields(
            input,
            new Set(['capture_id', 'from_x', 'from_y', 'to_x', 'to_y', 'steps']),
            'computer_drag',
          )
          return executeComputerInputAction(ctx, exec, grants, {
            action: 'drag',
            summary: `拖拽 (${String(input.from_x)}, ${String(input.from_y)}) → (${String(input.to_x)}, ${String(input.to_y)})`,
            payload: {
              captureId: input.capture_id,
              fromX: input.from_x,
              fromY: input.from_y,
              toX: input.to_x,
              toY: input.to_y,
              ...(typeof input.steps === 'number' ? { steps: input.steps } : {}),
            },
          })
        })
      },
    }),
  )
  ctx.tools.register(
    defineTool({
      name: 'computer_scroll',
      description: '在指定 capture_id 截图坐标位置滚动鼠标滚轮（delta_y > 0 向下滚动）。',
      parameters: {
        capture_id: {
          type: 'string',
          required: true,
          description: 'computer_screenshot 返回的 capture_id。',
        },
        x: { type: 'number', required: true, description: '滚动位置横坐标。' },
        y: { type: 'number', required: true, description: '滚动位置纵坐标。' },
        delta_x: { type: 'number', description: '水平滚动量（默认 0）。' },
        delta_y: { type: 'number', description: '垂直滚动量（默认 240）。' },
      },
      output: { schema: JSON_OUTPUT, render: (_a, v) => renderConnectionOutput(v) },
      execute(args, exec) {
        return runConnectionTool(() => {
          const input = args as Record<string, unknown>
          assertAllowedFields(
            input,
            new Set(['capture_id', 'x', 'y', 'delta_x', 'delta_y']),
            'computer_scroll',
          )
          return executeComputerInputAction(ctx, exec, grants, {
            action: 'scroll',
            summary: `在 (${String(input.x)}, ${String(input.y)}) 滚动 (${String(input.delta_x ?? 0)}, ${String(input.delta_y ?? 240)})`,
            payload: {
              captureId: input.capture_id,
              x: input.x,
              y: input.y,
              ...(typeof input.delta_x === 'number' ? { deltaX: input.delta_x } : {}),
              ...(typeof input.delta_y === 'number' ? { deltaY: input.delta_y } : {}),
            },
          })
        })
      },
    }),
  )
}

function registerKeyboardTools(ctx: Context, grants: ComputerSessionGrantStore): void {
  ctx.tools.register(
    defineTool({
      name: 'computer_type',
      description:
        '向目标桌面应用窗口写入任意 UTF-8 文本（支持中文与多行）；可传 capture_id + ref="@uN" 直接定位输入框，macOS 仅在 clear=true 时走回读校验的纯后台 AX 覆写，否则安全粘贴并自动恢复原焦点与剪贴板。',
      parameters: {
        text: { type: 'string', required: true, description: '要输入的文本（上限 8192 字符）。' },
        capture_id: { type: 'string', description: '可选：与 ref 搭配使用的截图标识。' },
        ref: { type: 'string', description: '可选：目标输入框控件编号（如 "@u2"）。' },
        clear: { type: 'boolean', description: '写入前是否清空原输入框内容（默认 false）。' },
        submit: { type: 'boolean', description: '输入完成后是否发送 Enter 键（默认 false）。' },
        window_id: { type: 'integer', description: '可选目标窗口 ID（缺省沿用最近操作的窗口）。' },
        pid: { type: 'integer', description: '可选目标进程 PID。' },
      },
      output: { schema: JSON_OUTPUT, render: (_a, v) => renderConnectionOutput(v) },
      execute(args, exec) {
        return runConnectionTool(() => {
          const input = args as Record<string, unknown>
          assertAllowedFields(
            input,
            new Set(['text', 'capture_id', 'ref', 'clear', 'submit', 'window_id', 'pid']),
            'computer_type',
          )
          const text = typeof input.text === 'string' ? input.text : ''
          if (!text) throw new Error('输入文本不能为空')
          if (text.length > 8192) throw new Error('单次桌面输入文本长度不能超过 8192 字符')
          return executeComputerInputAction(ctx, exec, grants, {
            action: 'type',
            summary: formatTypeSummary(input),
            payload: {
              text,
              clear: input.clear === true,
              submit: input.submit === true,
              ...(typeof input.capture_id === 'string' && input.capture_id
                ? { captureId: input.capture_id }
                : {}),
              ...(typeof input.ref === 'string' && input.ref ? { ref: input.ref } : {}),
              ...(typeof input.window_id === 'number' ? { windowId: input.window_id } : {}),
              ...(typeof input.pid === 'number' ? { pid: input.pid } : {}),
            },
          })
        })
      },
    }),
  )
  ctx.tools.register(
    defineTool({
      name: 'computer_key',
      description:
        '向目标桌面应用发送单个按键或组合键（如 Command+C、Control+S、Enter、Escape）；macOS 下支持无焦点后台定向投递，自动拦截锁屏、强制退出与急停快捷键。',
      parameters: {
        key: { type: 'string', required: true, description: '按键名或组合键表达式。' },
        modifiers: { type: 'array', items: { type: 'string' }, description: '可选修饰键列表。' },
        window_id: { type: 'integer', description: '可选目标窗口 ID（缺省沿用最近操作的窗口）。' },
        pid: { type: 'integer', description: '可选目标进程 PID。' },
      },
      output: { schema: JSON_OUTPUT, render: (_a, v) => renderConnectionOutput(v) },
      execute(args, exec) {
        return runConnectionTool(() => {
          const input = args as Record<string, unknown>
          assertAllowedFields(
            input,
            new Set(['key', 'modifiers', 'window_id', 'pid']),
            'computer_key',
          )
          const rawKey = typeof input.key === 'string' ? input.key.trim() : ''
          if (!rawKey) throw new Error('按键名不能为空')
          const modifiers = Array.isArray(input.modifiers)
            ? input.modifiers.filter((item): item is string => typeof item === 'string')
            : []
          const { summary, highRisk } = formatKeySummary(rawKey, modifiers)
          return executeComputerInputAction(ctx, exec, grants, {
            action: 'key',
            summary,
            ...(highRisk ? { forcePerCall: true } : {}),
            payload: {
              key: rawKey,
              modifiers,
              ...(typeof input.window_id === 'number' ? { windowId: input.window_id } : {}),
              ...(typeof input.pid === 'number' ? { pid: input.pid } : {}),
            },
          })
        })
      },
    }),
  )
}

/** 依赖由宿主统一注入；`attachments` 与 `llm` 按需读取。 */
export const inject = ['tools', 'mydshAutomationSystem', 'mydshConnectionAccess', 'userQuestions']

/** 注册 8 个系统级桌面操控工具并在会话结束时自动撤销授权。 */
export function apply(ctx: Context): void {
  const grants = createComputerSessionGrantStore(ctx)
  registerInspectionAndWindowTools(ctx, grants)
  registerMouseTools(ctx, grants)
  registerKeyboardTools(ctx, grants)
}
