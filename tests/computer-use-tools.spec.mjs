/** 验证 @mydsh/computer-use/tools 在完整 Cordis 环境下的权限确认、每步安全模式、多模态截图与子 Agent 拦截。 */
/* oxlint-disable no-await-in-loop -- Cordis 插件注册与测试夹具销毁按依赖顺序执行。 */
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LlmRuntime } from '../packages/llm/llm/lib/index.js'
import SessionStore from '../packages/core/session/lib/index.js'
import Projections from '../packages/session/session-projection/lib/index.js'
import SystemPrompt from '../packages/core/system-prompt/lib/index.js'
import Tools from '../packages/core/tools/lib/index.js'
import Agents from '../packages/core/agent/lib/index.js'
import AgentLoop from '../packages/core/agent-loop/lib/index.js'
import UserQuestions from '../packages/interaction/user-questions/lib/index.js'
import * as Spill from '../packages/spill/spill-policy/lib/index.js'
import { ConnectionAccess } from '../packages/connections/access/lib/index.js'
import * as ComputerTools from '../packages/automation/computer-use/lib/tools.js'

const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

const cleanups = []
afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()()
  }
})

function parseJson(result) {
  const first = Array.isArray(result.content) ? result.content[0] : null
  return first && first.type === 'text' ? JSON.parse(first.text) : null
}

async function createComputerFixture(options = {}) {
  const ctx = new Context()
  for (const plugin of [
    LlmRuntime,
    SessionStore,
    Projections,
    SystemPrompt,
    Tools,
    Agents,
    UserQuestions,
  ]) {
    await ctx.plugin(plugin).await()
  }
  await ctx.plugin(AgentLoop, { agents: [] }).await()
  ctx.provide('spillStore', { saveText: vi.fn(async () => ({ id: 's1', uri: 'spill://s1' })) })
  await ctx.plugin(Spill, { maxInlineBytes: 50_000 }).await()
  ctx.provide('workspaceRegistry', { archivedSessionIds: [] })
  ctx.provide('sessionController', {
    inspect: async id => {
      const meta = ctx.sessions.get(id)?.header
      if (!meta) throw new Error('会话不存在')
      return { meta, events: [], inheritedEventCount: 0 }
    },
  })

  const statusPayload = {
    permissions: {
      platform: 'darwin',
      supported: true,
      nativeLoaded: true,
      accessibility: true,
      screenRecording: true,
    },
    scope: options.scope ?? 'window',
    confirmEveryAction: options.confirmEveryAction ?? false,
    maxImageLongEdge: 1280,
    displays: [
      {
        id: 1,
        label: '内置显示器',
        bounds: { x: 0, y: 0, width: 1440, height: 900 },
        scaleFactor: 2,
        primary: true,
      },
    ],
    windows: [
      {
        windowId: 10,
        pid: 1000,
        appName: 'Notes',
        bundleId: 'com.apple.Notes',
        title: '备忘录',
        bounds: { x: 100, y: 100, width: 600, height: 400 },
        isFrontmost: true,
      },
      {
        windowId: 20,
        pid: 2000,
        appName: 'Calculator',
        bundleId: 'com.apple.calculator',
        title: '计算器',
        bounds: { x: 200, y: 120, width: 320, height: 460 },
        isFrontmost: false,
      },
    ],
  }

  let nextError = null
  ctx.provide('mydshAutomationSystem', {
    call: vi.fn(async (method, payload) => {
      if (method === 'automation.computer.status') return statusPayload
      if (nextError) {
        const err = nextError
        nextError = null
        throw err
      }
      if (method === 'automation.computer.screenshot') {
        const win =
          statusPayload.windows.find(w => w.windowId === payload.windowId) ??
          statusPayload.windows[0]
        return {
          captureId: `cap_${win.windowId}`,
          base64: TINY_PNG_BASE64,
          mediaType: 'image/png',
          width: 600,
          height: 400,
          displayId: 1,
          scope: 'window',
          logicalOrigin: { x: 100, y: 100 },
          logicalSize: { width: 600, height: 400 },
          window: {
            windowId: win.windowId,
            pid: win.pid,
            appName: win.appName,
            title: win.title,
          },
        }
      }
      if (method === 'automation.computer.focus_window') {
        const win = statusPayload.windows.find(
          w => w.windowId === payload.windowId || w.pid === payload.pid,
        )
        return { ok: true, window: win }
      }
      return { ok: true }
    }),
  })

  const savedImages = []
  ctx.provide('attachments', {
    saveImage: vi.fn(async input => {
      const ref = {
        attachmentId: `cu_att_${savedImages.length + 1}`,
        mediaType: input.mediaType,
        bytes: input.data.byteLength,
        width: 600,
        height: 400,
        name: input.name,
      }
      savedImages.push(ref)
      return ref
    }),
  })
  const inputModalities = options.visionModel === false ? ['text'] : ['text', 'image']
  ctx.llm.resolveModelInfo = vi.fn(async () => ({ inputModalities }))

  await ctx.plugin(ConnectionAccess).await()

  const prompts = []
  let decision = 'session'
  ctx.on('user-questions/request', async request => {
    prompts.push(request)
    const q = request.questions[0]
    if (decision === 'deny') return { answers: [{ id: q.id, selected: ['拒绝'] }] }
    if (decision === 'session') {
      const opt = q.options.find(item => item.label.includes('本次会话'))
      return { answers: [{ id: q.id, selected: [(opt ?? q.options[0]).label] }] }
    }
    return { answers: [{ id: q.id, selected: [q.options[0].label] }] }
  })

  const createAgent = (sessionId = `cu-session-${randomUUID()}`, meta = {}) =>
    ctx.agentLoop.createAgent(ctx, {
      sessionId,
      meta: { cwd: process.cwd(), ...meta },
      agentOptions: { provider: 'mock', model: 'mock-vision' },
      setup: async agentCtx => {
        await agentCtx.plugin(ComputerTools).await()
      },
    })

  const handle = await createAgent()
  cleanups.push(async () => {
    await ctx.fiber.dispose()
  })

  const runTool = (name, args = {}, caller = handle.agent) =>
    ctx.tools.execute({
      name,
      callId: randomUUID(),
      agent: caller,
      signal: AbortSignal.timeout(5000),
      arguments: args,
    })

  return {
    ctx,
    handle,
    createAgent,
    prompts,
    savedImages,
    setDecision(next) {
      decision = next
    },
    setNextError(err) {
      nextError = err
    },
    runTool,
  }
}

describe('@mydsh/computer-use/tools 集成测试', () => {
  it('注册全部 8 个工具，支持按应用会话授权、切换应用重新确认以及每步强制确认模式', async () => {
    const fixture = await createComputerFixture({ confirmEveryAction: false })
    const names = fixture.ctx.tools.schemas(fixture.handle.agent).map(item => item.name)
    for (const tool of [
      'computer_status',
      'computer_screenshot',
      'computer_focus_window',
      'computer_click',
      'computer_drag',
      'computer_scroll',
      'computer_type',
      'computer_key',
    ]) {
      expect(names).toContain(tool)
    }

    // 首次截图 Notes 弹出确认卡并授予会话级权限
    fixture.setDecision('session')
    const shot = await fixture.runTool('computer_screenshot', { window_id: 10 })
    expect(shot.isError).toBeFalsy()
    expect(fixture.prompts).toHaveLength(1)
    expect(shot.content).toHaveLength(2)
    expect(shot.content[1].type).toBe('image')
    expect(shot.content[1].attachment.attachmentId).toBe('cu_att_1')

    // 对同一应用 Notes 执行点击与中文输入免重复弹窗
    const clickRes = await fixture.runTool('computer_click', { capture_id: 'cap_10', x: 50, y: 40 })
    expect(clickRes.isError).toBeFalsy()
    expect(parseJson(clickRes).authorization).toBe('session-reused')
    expect(fixture.prompts).toHaveLength(1)

    // 切换到新应用 Calculator 时必须重新确认
    const focusCalc = await fixture.runTool('computer_focus_window', { window_id: 20 })
    expect(focusCalc.isError).toBeFalsy()
    expect(fixture.prompts).toHaveLength(2)

    // 每步确认模式：连续操作每次都弹确认卡
    const strictFixture = await createComputerFixture({ confirmEveryAction: true })
    strictFixture.setDecision('once')
    await strictFixture.runTool('computer_type', { text: '你好世界' })
    await strictFixture.runTool('computer_key', { key: 'Enter' })
    expect(strictFixture.prompts).toHaveLength(2)
    expect(strictFixture.prompts[0].questions[0].options).toHaveLength(2)
  })

  it('纯文本模型拒绝调用桌面截图并引导切换多模态模型，同时拒绝子 Agent 调用', async () => {
    const textOnly = await createComputerFixture({ visionModel: false })
    const shotRes = await textOnly.runTool('computer_screenshot', { window_id: 10 })
    expect(shotRes.isError).toBe(true)
    expect(shotRes.content[0].text).toContain('MODEL_NO_VISION')

    const sub = await textOnly.createAgent(`cu-sub-${randomUUID()}`, {
      parentSession: textOnly.handle.agent.id,
      origin: 'subagent',
    })
    const denied = await textOnly.runTool('computer_status', {}, sub.agent)
    expect(denied.isError).toBe(true)
    expect(denied.content[0].text).toContain('NOT_AUTHORIZED')
  })

  it('严格校验跨应用 capture_id、window_id/pid 冲突、高危组合键强制确认与急停撤销授权', async () => {
    const fixture = await createComputerFixture({ confirmEveryAction: false })
    fixture.setDecision('once')
    const calcShot = await fixture.runTool('computer_screenshot', { window_id: 20 })
    expect(calcShot.isError).toBeFalsy()
    expect(fixture.prompts).toHaveLength(1)

    // 会话级授权 Notes 后，使用 Calculator 的 capture_id 仍必须重新对 Calculator 授权
    fixture.setDecision('session')
    await fixture.runTool('computer_focus_window', { window_id: 10 })
    expect(fixture.prompts).toHaveLength(2)

    fixture.setDecision('deny')
    const crossAppClick = await fixture.runTool('computer_click', {
      capture_id: 'cap_20',
      x: 50,
      y: 40,
    })
    expect(crossAppClick.isError).toBe(true)
    expect(crossAppClick.content[0].text).toContain('USER_REJECTED')
    expect(fixture.prompts).toHaveLength(3)

    // window_id 与 pid 冲突或不存在时必须直接报错
    const mismatch = await fixture.runTool('computer_focus_window', { window_id: 10, pid: 2000 })
    expect(mismatch.isError).toBe(true)
    expect(mismatch.content[0].text).toContain('参数冲突')

    // 高危组合键（Command+Q）即使在已授权应用内也必须强制逐次确认并展示修饰键
    fixture.setDecision('once')
    const quitKey = await fixture.runTool('computer_key', { key: 'Q', modifiers: ['Command'] })
    expect(quitKey.isError).toBeFalsy()
    const keyPrompt = fixture.prompts.at(-1).questions[0]
    expect(keyPrompt.detail).toContain('Command+Q')
    expect(keyPrompt.options).toHaveLength(2)

    // 急停撤销 Notes 会话级授权，且拒绝未知参数字段
    fixture.setNextError(new Error('AUTOMATION_STOPPED：急停触发'))
    await fixture.runTool('computer_type', { text: 'abc' })
    const promptsBeforeRetry = fixture.prompts.length
    fixture.setDecision('once')
    await fixture.runTool('computer_type', { text: 'after-stop' })
    expect(fixture.prompts.length).toBe(promptsBeforeRetry + 1)

    const unknownArg = await fixture.runTool('computer_status', { bad_field: 1 })
    expect(unknownArg.isError).toBe(true)
    expect(unknownArg.content[0].text).toContain('不支持未知参数')
  })
})
