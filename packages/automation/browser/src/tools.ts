/**
 * `@mydsh/browser-automation/tools` 插件入口：向后台 Runtime 注册 12 个统一 CDP 浏览器控制工具。
 * 所有工具均受主会话隔离、域名守卫、人工接管与全局急停保护，内置与外置浏览器通过 `target` 无缝切换。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { renderConnectionOutput, runConnectionTool } from '@mydsh/connection-access/output'
import {
  assertAllowedFields,
  createBrowserSessionGrantStore,
  type BrowserSessionGrantStore,
} from './policy.ts'
import {
  BROWSER_SCREENSHOT_OUTPUT_SCHEMA,
  renderBrowserScreenshotOutput,
} from './screenshot-output.ts'
import {
  executeBrowserInteraction,
  executeBrowserNavigate,
  executeBrowserScreenshot,
  executeBrowserSnapshot,
  executeBrowserStatus,
  executeBrowserTabs,
} from './tools-handlers.ts'

const TARGET_PARAM = {
  type: 'string' as const,
  enum: ['embedded', 'external'] as const,
  description:
    '可选目标浏览器：embedded（内置浏览器）或 external（外置 Chrome/Edge CDP）；省略时自动选用已开启项。',
}

const TAB_ID_PARAM = {
  type: 'string' as const,
  description: '可选标签页标识；省略时操作当前活跃受管标签页。',
}

const SNAPSHOT_REF_PARAMS = {
  ref: {
    type: 'string' as const,
    description: '由 browser_snapshot 返回的元素编号（如 @e1、@e2）。',
  },
  snapshot_id: {
    type: 'string' as const,
    description: '对应 browser_snapshot 返回的 snapshot_id，用于防止页面变化后误点过期元素。',
  },
}

const ANY_OBJECT_OUTPUT = { type: 'json' as const }

function registerInspectionTools(ctx: Context, grants: BrowserSessionGrantStore): void {
  ctx.tools.register(
    defineTool({
      name: 'browser_status',
      description: '查看内置浏览器与外置浏览器（CDP）的启用状态、授权域名、连接情况与当前接管态。',
      parameters: {},
      output: { schema: ANY_OBJECT_OUTPUT, render: (_a, v) => renderConnectionOutput(v) },
      execute(args, exec) {
        return runConnectionTool(() => {
          assertAllowedFields(args as Record<string, unknown>, new Set(), 'browser_status')
          return executeBrowserStatus(ctx, exec)
        })
      },
    }),
  )
  ctx.tools.register(
    defineTool({
      name: 'browser_tabs',
      description: '列出、新建、切换或关闭内置/外置浏览器的受管标签页。',
      parameters: {
        target: TARGET_PARAM,
        operation: {
          type: 'string',
          enum: ['list', 'new', 'switch', 'close'],
          description: '标签页操作：list（默认）、new、switch 或 close。',
        },
        tab_id: TAB_ID_PARAM,
        url: { type: 'string', description: 'operation 为 new 时可选初始打开的 http/https 网址。' },
      },
      output: { schema: ANY_OBJECT_OUTPUT, render: (_a, v) => renderConnectionOutput(v) },
      execute(args, exec) {
        return runConnectionTool(() => {
          assertAllowedFields(
            args as Record<string, unknown>,
            new Set(['target', 'operation', 'tab_id', 'url']),
            'browser_tabs',
          )
          return executeBrowserTabs(
            ctx,
            exec,
            grants,
            args as Parameters<typeof executeBrowserTabs>[3],
          )
        })
      },
    }),
  )
  ctx.tools.register(
    defineTool({
      name: 'browser_navigate',
      description:
        '在内置或外置浏览器中打开网址，或执行后退、前进、刷新。仅允许 http/https 网址；首次访问非白名单公网域名会弹出确认卡。',
      parameters: {
        target: TARGET_PARAM,
        tab_id: TAB_ID_PARAM,
        mode: {
          type: 'string',
          enum: ['url', 'back', 'forward', 'reload'],
          description: '导航动作：url（默认）、back、forward 或 reload。',
        },
        url: { type: 'string', description: 'mode 为 url 时要打开的目标网址。' },
      },
      output: { schema: ANY_OBJECT_OUTPUT, render: (_a, v) => renderConnectionOutput(v) },
      execute(args, exec) {
        return runConnectionTool(() => {
          assertAllowedFields(
            args as Record<string, unknown>,
            new Set(['target', 'tab_id', 'mode', 'url']),
            'browser_navigate',
          )
          return executeBrowserNavigate(
            ctx,
            exec,
            grants,
            args as Parameters<typeof executeBrowserNavigate>[3],
          )
        })
      },
    }),
  )
  ctx.tools.register(
    defineTool({
      name: 'browser_snapshot',
      description:
        '优先用于感知网页：获取当前页面的紧凑交互元素编号树（@e1、@e2…）、视口尺寸与页面正文摘录；遇到验证码、支付或密码框会暂停并请求人工接管。',
      parameters: { target: TARGET_PARAM, tab_id: TAB_ID_PARAM },
      output: { schema: ANY_OBJECT_OUTPUT, render: (_a, v) => renderConnectionOutput(v) },
      execute(args, exec) {
        return runConnectionTool(() => {
          assertAllowedFields(
            args as Record<string, unknown>,
            new Set(['target', 'tab_id']),
            'browser_snapshot',
          )
          return executeBrowserSnapshot(
            ctx,
            exec,
            grants,
            args as Parameters<typeof executeBrowserSnapshot>[3],
          )
        })
      },
    }),
  )
  ctx.tools.register(
    defineTool({
      name: 'browser_screenshot',
      description:
        '截取当前浏览器页面并以多模态图片附件返回，适合验证页面视觉排版与图形元素；日常定位交互元素请优先使用 browser_snapshot。需要当前模型支持图片输入。',
      parameters: {
        target: TARGET_PARAM,
        tab_id: TAB_ID_PARAM,
        full_page: {
          type: 'boolean',
          description: '是否截取完整滚动页面（默认 false，仅当前视口）。',
        },
      },
      output: {
        schema: BROWSER_SCREENSHOT_OUTPUT_SCHEMA,
        render: (_args, value) => renderBrowserScreenshotOutput(value),
      },
      execute(args, exec) {
        return runConnectionTool(() => {
          assertAllowedFields(
            args as Record<string, unknown>,
            new Set(['target', 'tab_id', 'full_page']),
            'browser_screenshot',
          )
          return executeBrowserScreenshot(
            ctx,
            exec,
            grants,
            args as Parameters<typeof executeBrowserScreenshot>[3],
          )
        })
      },
    }),
  )
  ctx.tools.register(
    defineTool({
      name: 'browser_diagnostics',
      description:
        '读取当前标签页最近脱敏后的 Console 日志与网络请求摘要（不含 Cookie 与鉴权头），便于前端排错。',
      parameters: {
        target: TARGET_PARAM,
        tab_id: TAB_ID_PARAM,
        console_limit: {
          type: 'integer',
          description: '返回的 Console 日志条数（默认 50，上限 200）。',
        },
        network_limit: {
          type: 'integer',
          description: '返回的网络请求条数（默认 50，上限 200）。',
        },
        clear: { type: 'boolean', description: '读取后是否清空缓冲区（默认 false）。' },
      },
      output: { schema: ANY_OBJECT_OUTPUT, render: (_a, v) => renderConnectionOutput(v) },
      execute(args, exec) {
        return runConnectionTool(() => {
          const input = args as Record<string, unknown>
          assertAllowedFields(
            input,
            new Set(['target', 'tab_id', 'console_limit', 'network_limit', 'clear']),
            'browser_diagnostics',
          )
          return executeBrowserInteraction(ctx, exec, grants, {
            action: 'diagnostics',
            ...(typeof input.target === 'string' ? { target: input.target } : {}),
            payload: {
              ...(typeof input.tab_id === 'string' ? { tabId: input.tab_id } : {}),
              ...(typeof input.console_limit === 'number'
                ? { consoleLimit: input.console_limit }
                : {}),
              ...(typeof input.network_limit === 'number'
                ? { networkLimit: input.network_limit }
                : {}),
              clear: input.clear === true,
            },
          })
        })
      },
    }),
  )
}

function registerPointerAndInputTools(ctx: Context, grants: BrowserSessionGrantStore): void {
  ctx.tools.register(
    defineTool({
      name: 'browser_click',
      description:
        '按元素编号 ref（推荐）或视口逻辑坐标 (x, y) 点击页面元素；支持双击与右键。敏感支付提交按钮会触发人工接管。',
      parameters: {
        target: TARGET_PARAM,
        tab_id: TAB_ID_PARAM,
        ...SNAPSHOT_REF_PARAMS,
        x: { type: 'number', description: '可选逻辑横坐标（未提供 ref 时使用）。' },
        y: { type: 'number', description: '可选逻辑纵坐标（未提供 ref 时使用）。' },
        button: {
          type: 'string',
          enum: ['left', 'right', 'middle'],
          description: '鼠标按键（默认 left）。',
        },
        click_count: { type: 'integer', description: '点击次数：1 单击（默认）、2 双击、3 三击。' },
      },
      output: { schema: ANY_OBJECT_OUTPUT, render: (_a, v) => renderConnectionOutput(v) },
      execute(args, exec) {
        return runConnectionTool(() => {
          const input = args as Record<string, unknown>
          assertAllowedFields(
            input,
            new Set(['target', 'tab_id', 'ref', 'snapshot_id', 'x', 'y', 'button', 'click_count']),
            'browser_click',
          )
          return executeBrowserInteraction(ctx, exec, grants, {
            action: 'click',
            ...(typeof input.target === 'string' ? { target: input.target } : {}),
            payload: {
              ...(typeof input.tab_id === 'string' ? { tabId: input.tab_id } : {}),
              ...(typeof input.ref === 'string' ? { ref: input.ref } : {}),
              ...(typeof input.snapshot_id === 'string' ? { snapshotId: input.snapshot_id } : {}),
              ...(typeof input.x === 'number' ? { x: input.x } : {}),
              ...(typeof input.y === 'number' ? { y: input.y } : {}),
              ...(typeof input.button === 'string' ? { button: input.button } : {}),
              ...(typeof input.click_count === 'number' ? { clickCount: input.click_count } : {}),
            },
          })
        })
      },
    }),
  )
  ctx.tools.register(
    defineTool({
      name: 'browser_type',
      description:
        '向指定 ref 元素或当前焦点输入文本（支持中文与特殊符号），可选先清空并按回车提交；遇到密码框自动交回人工输入。',
      parameters: {
        target: TARGET_PARAM,
        tab_id: TAB_ID_PARAM,
        ...SNAPSHOT_REF_PARAMS,
        text: { type: 'string', required: true, description: '要输入的文本内容。' },
        clear: { type: 'boolean', description: '输入前是否先全选清空原有内容（默认 false）。' },
        submit: { type: 'boolean', description: '输入完成后是否发送 Enter 键（默认 false）。' },
      },
      output: { schema: ANY_OBJECT_OUTPUT, render: (_a, v) => renderConnectionOutput(v) },
      execute(args, exec) {
        return runConnectionTool(() => {
          const input = args as Record<string, unknown>
          assertAllowedFields(
            input,
            new Set(['target', 'tab_id', 'ref', 'snapshot_id', 'text', 'clear', 'submit']),
            'browser_type',
          )
          return executeBrowserInteraction(ctx, exec, grants, {
            action: 'type',
            ...(typeof input.target === 'string' ? { target: input.target } : {}),
            payload: {
              ...(typeof input.tab_id === 'string' ? { tabId: input.tab_id } : {}),
              ...(typeof input.ref === 'string' ? { ref: input.ref } : {}),
              ...(typeof input.snapshot_id === 'string' ? { snapshotId: input.snapshot_id } : {}),
              text: typeof input.text === 'string' ? input.text : '',
              clear: input.clear === true,
              submit: input.submit === true,
            },
          })
        })
      },
    }),
  )
  ctx.tools.register(
    defineTool({
      name: 'browser_press_key',
      description:
        '向当前页面发送单个按键或组合键（例如 Enter、Escape、Tab、Control+A、ArrowDown）。',
      parameters: {
        target: TARGET_PARAM,
        tab_id: TAB_ID_PARAM,
        key: { type: 'string', required: true, description: '按键名称或组合键表达式。' },
        modifiers: {
          type: 'array',
          items: { type: 'string' },
          description: '可选修饰键列表，如 ["Shift"]、["Meta"]。',
        },
      },
      output: { schema: ANY_OBJECT_OUTPUT, render: (_a, v) => renderConnectionOutput(v) },
      execute(args, exec) {
        return runConnectionTool(() => {
          const input = args as Record<string, unknown>
          assertAllowedFields(
            input,
            new Set(['target', 'tab_id', 'key', 'modifiers']),
            'browser_press_key',
          )
          return executeBrowserInteraction(ctx, exec, grants, {
            action: 'pressKey',
            ...(typeof input.target === 'string' ? { target: input.target } : {}),
            payload: {
              ...(typeof input.tab_id === 'string' ? { tabId: input.tab_id } : {}),
              key: typeof input.key === 'string' ? input.key : '',
              modifiers: Array.isArray(input.modifiers) ? input.modifiers : [],
            },
          })
        })
      },
    }),
  )
}

function registerNavigationAndWaitTools(ctx: Context, grants: BrowserSessionGrantStore): void {
  ctx.tools.register(
    defineTool({
      name: 'browser_scroll',
      description: '在页面视口或指定 ref 容器内滚动滚轮（delta_y > 0 向下滚动，< 0 向上滚动）。',
      parameters: {
        target: TARGET_PARAM,
        tab_id: TAB_ID_PARAM,
        ...SNAPSHOT_REF_PARAMS,
        x: { type: 'number', description: '可选滚动中心横坐标。' },
        y: { type: 'number', description: '可选滚动中心纵坐标。' },
        delta_x: { type: 'number', description: '水平滚动距离（默认 0）。' },
        delta_y: { type: 'number', description: '垂直滚动距离（默认 360）。' },
      },
      output: { schema: ANY_OBJECT_OUTPUT, render: (_a, v) => renderConnectionOutput(v) },
      execute(args, exec) {
        return runConnectionTool(() => {
          const input = args as Record<string, unknown>
          assertAllowedFields(
            input,
            new Set(['target', 'tab_id', 'ref', 'snapshot_id', 'x', 'y', 'delta_x', 'delta_y']),
            'browser_scroll',
          )
          return executeBrowserInteraction(ctx, exec, grants, {
            action: 'scroll',
            ...(typeof input.target === 'string' ? { target: input.target } : {}),
            payload: {
              ...(typeof input.tab_id === 'string' ? { tabId: input.tab_id } : {}),
              ...(typeof input.ref === 'string' ? { ref: input.ref } : {}),
              ...(typeof input.snapshot_id === 'string' ? { snapshotId: input.snapshot_id } : {}),
              ...(typeof input.x === 'number' ? { x: input.x } : {}),
              ...(typeof input.y === 'number' ? { y: input.y } : {}),
              ...(typeof input.delta_x === 'number' ? { deltaX: input.delta_x } : {}),
              ...(typeof input.delta_y === 'number' ? { deltaY: input.delta_y } : {}),
            },
          })
        })
      },
    }),
  )
  ctx.tools.register(
    defineTool({
      name: 'browser_select',
      description:
        '在原生下拉选择框 <select>（通过 ref 指定）中按 value 或可见文案 label 选中选项。',
      parameters: {
        target: TARGET_PARAM,
        tab_id: TAB_ID_PARAM,
        ref: {
          type: 'string',
          required: true,
          description: '目标 <select> 的元素编号（如 @e5）。',
        },
        snapshot_id: { type: 'string', description: '对应快照标识。' },
        value: { type: 'string', description: '选项的 value 属性值。' },
        label: { type: 'string', description: '选项的可见文本标签。' },
      },
      output: { schema: ANY_OBJECT_OUTPUT, render: (_a, v) => renderConnectionOutput(v) },
      execute(args, exec) {
        return runConnectionTool(() => {
          const input = args as Record<string, unknown>
          assertAllowedFields(
            input,
            new Set(['target', 'tab_id', 'ref', 'snapshot_id', 'value', 'label']),
            'browser_select',
          )
          return executeBrowserInteraction(ctx, exec, grants, {
            action: 'select',
            ...(typeof input.target === 'string' ? { target: input.target } : {}),
            payload: {
              ...(typeof input.tab_id === 'string' ? { tabId: input.tab_id } : {}),
              ref: typeof input.ref === 'string' ? input.ref : '',
              ...(typeof input.snapshot_id === 'string' ? { snapshotId: input.snapshot_id } : {}),
              ...(typeof input.value === 'string' ? { value: input.value } : {}),
              ...(typeof input.label === 'string' ? { label: input.label } : {}),
            },
          })
        })
      },
    }),
  )
  ctx.tools.register(
    defineTool({
      name: 'browser_wait',
      description:
        '等待页面出现指定文本、匹配 CSS 选择器、网络空闲或固定延时（上限 30 秒，支持急停取消）。',
      parameters: {
        target: TARGET_PARAM,
        tab_id: TAB_ID_PARAM,
        timeout_ms: {
          type: 'integer',
          description: '超时或延时毫秒数（100 至 30000，默认 5000）。',
        },
        text: { type: 'string', description: '等待页面正文包含的文本片段。' },
        selector: { type: 'string', description: '等待匹配的 CSS 选择器。' },
        network_idle: { type: 'boolean', description: '等待在途网络请求归零并稳定 400ms。' },
      },
      output: { schema: ANY_OBJECT_OUTPUT, render: (_a, v) => renderConnectionOutput(v) },
      execute(args, exec) {
        return runConnectionTool(() => {
          const input = args as Record<string, unknown>
          assertAllowedFields(
            input,
            new Set(['target', 'tab_id', 'timeout_ms', 'text', 'selector', 'network_idle']),
            'browser_wait',
          )
          return executeBrowserInteraction(ctx, exec, grants, {
            action: 'wait',
            ...(typeof input.target === 'string' ? { target: input.target } : {}),
            payload: {
              ...(typeof input.tab_id === 'string' ? { tabId: input.tab_id } : {}),
              ...(typeof input.timeout_ms === 'number' ? { timeoutMs: input.timeout_ms } : {}),
              ...(typeof input.text === 'string' ? { text: input.text } : {}),
              ...(typeof input.selector === 'string' ? { selector: input.selector } : {}),
              networkIdle: input.network_idle === true,
            },
          })
        })
      },
    }),
  )
}

/** 依赖由宿主统一注入；`attachments` 与 `llm` 按需读取，不影响纯文本模型使用快照工具。 */
export const inject = ['tools', 'mydshAutomationSystem', 'mydshConnectionAccess', 'userQuestions']

/** 注册 12 个统一浏览器操控工具，并在会话释放时自动撤销会话域名授权。 */
export function apply(ctx: Context): void {
  const grants = createBrowserSessionGrantStore(ctx)
  registerInspectionTools(ctx, grants)
  registerPointerAndInputTools(ctx, grants)
  registerNavigationAndWaitTools(ctx, grants)
}
