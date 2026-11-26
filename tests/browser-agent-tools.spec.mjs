/** 验证 @mydsh/browser-automation/tools 在完整 Cordis 环境下的权限守卫、确认卡、人工接管与多模态截图链路。 */
/* oxlint-disable no-await-in-loop -- Cordis 插件注册与测试夹具释放按顺序执行。 */
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
import * as BrowserTools from '../packages/automation/browser/lib/tools.js'

const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

const cleanups = []
afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()()
  }
})

function parseJsonText(result) {
  const first = Array.isArray(result.content) ? result.content[0] : null
  return first && first.type === 'text' ? JSON.parse(first.text) : null
}

async function createBrowserToolFixture(options = {}) {
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

  const status = {
    embedded: {
      enabled: options.embeddedEnabled ?? true,
      allowLocalhostWithoutConfirm: true,
      allowedOrigins: [],
      blockedOrigins: ['https://blocked.example.com'],
    },
    external: {
      enabled: options.externalEnabled ?? false,
      mode: options.externalMode ?? 'managed',
      executablePath: null,
      attachPort: options.attachPort ?? 9222,
      allowedOrigins: [],
      connected: false,
      targetLabel: null,
    },
    takeover: { active: false, kind: null, stepCount: 0 },
  }

  let snapshotCalls = 0
  let nextError = null
  const calls = []
  ctx.provide('mydshAutomationSystem', {
    call: vi.fn(async (method, payload) => {
      calls.push({ method, payload })
      if (method === 'automation.browser.status') return status
      if (nextError) {
        const err = nextError
        nextError = null
        throw err
      }
      if (method.endsWith('.navigate')) {
        return {
          tabId: payload.tabId ?? 'default',
          url: payload.url,
          title: '测试页',
          loading: false,
        }
      }
      if (method.endsWith('.snapshot')) {
        snapshotCalls += 1
        if (options.captchaOnFirstSnapshot && snapshotCalls === 1) {
          return {
            tabId: 'default',
            snapshotId: 'snap_1',
            url: 'https://example.com/verify',
            title: '安全验证',
            viewport: { width: 1280, height: 800 },
            elementsCount: 0,
            truncated: false,
            tree: 'URL: https://example.com/verify',
            handoff: {
              required: true,
              category: 'captcha',
              reason: '页面包含人机验证',
              url: 'https://example.com/verify',
            },
          }
        }
        return {
          tabId: 'default',
          snapshotId: `snap_${snapshotCalls}`,
          url: 'http://127.0.0.1:4173/',
          title: '本地开发页',
          viewport: { width: 1280, height: 800 },
          elementsCount: 1,
          truncated: false,
          tree: 'URL: http://127.0.0.1:4173/\n@e1 [button] "提交" (x=100, y=50)',
        }
      }
      if (method.endsWith('.screenshot')) {
        return {
          tabId: 'default',
          base64: TINY_PNG_BASE64,
          mediaType: 'image/png',
          width: 1,
          height: 1,
          viewportWidth: 1280,
          viewportHeight: 800,
          url: 'http://127.0.0.1:4173/',
          title: '本地开发页',
        }
      }
      return { tabId: 'default', ok: true }
    }),
  })

  const savedImages = []
  ctx.provide('attachments', {
    saveImage: vi.fn(async input => {
      const ref = {
        attachmentId: `att_${savedImages.length + 1}`,
        mediaType: input.mediaType,
        bytes: input.data.byteLength,
        width: 1,
        height: 1,
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
  let promptDecision = 'once'
  ctx.on('user-questions/request', async request => {
    prompts.push(request)
    const q = request.questions[0]
    if (promptDecision === 'deny') {
      const denyOpt = q.options.find(item => item.label === '拒绝' || item.label.includes('取消'))
      return { answers: [{ id: q.id, selected: [denyOpt.label] }] }
    }
    if (promptDecision === 'session') {
      const sessOpt = q.options.find(item => item.label.includes('本次会话'))
      return { answers: [{ id: q.id, selected: [(sessOpt ?? q.options[0]).label] }] }
    }
    return { answers: [{ id: q.id, selected: [q.options[0].label] }] }
  })

  const createAgent = (sessionId = `browser-session-${randomUUID()}`, meta = {}) =>
    ctx.agentLoop.createAgent(ctx, {
      sessionId,
      meta: { cwd: process.cwd(), ...meta },
      agentOptions: { provider: 'mock', model: 'mock-vision' },
      setup: async agentCtx => {
        await agentCtx.plugin(BrowserTools).await()
      },
    })

  const handle = await createAgent()
  cleanups.push(async () => {
    await ctx.fiber.dispose()
  })

  const runTool = async (name, args = {}, caller = handle.agent) =>
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
    status,
    calls,
    prompts,
    savedImages,
    setDecision(next) {
      promptDecision = next
    },
    setNextError(err) {
      nextError = err
    },
    runTool,
    parseJsonText,
  }
}

describe('@mydsh/browser-automation/tools 集成测试', () => {
  it('注册全部 12 个工具，本机 localhost 免弹窗放行，公网域名走确认卡并支持会话授权与黑名单拦截', async () => {
    const fixture = await createBrowserToolFixture()
    const toolNames = fixture.ctx.tools.schemas(fixture.handle.agent).map(item => item.name)
    for (const name of [
      'browser_status',
      'browser_tabs',
      'browser_navigate',
      'browser_snapshot',
      'browser_screenshot',
      'browser_click',
      'browser_type',
      'browser_press_key',
      'browser_scroll',
      'browser_select',
      'browser_wait',
      'browser_diagnostics',
    ]) {
      expect(toolNames).toContain(name)
    }

    // localhost 自动放行
    const localNav = await fixture.runTool('browser_navigate', { url: 'http://127.0.0.1:4173/app' })
    expect(localNav.isError).toBeFalsy()
    expect(fixture.parseJsonText(localNav).authorization).toBe('auto-allowed')
    expect(fixture.prompts).toHaveLength(0)

    // 黑名单域名直接拒绝
    const blockedRes = await fixture.runTool('browser_navigate', {
      url: 'https://blocked.example.com/secret',
    })
    expect(blockedRes.isError).toBe(true)
    expect(blockedRes.content[0].text).toContain('PERMISSION_DENIED')

    // 公网域名首次弹确认卡并选择「本次会话允许该域名」
    fixture.setDecision('session')
    const publicFirst = await fixture.runTool('browser_navigate', {
      url: 'https://docs.example.org/a',
    })
    expect(publicFirst.isError).toBeFalsy()
    expect(fixture.parseJsonText(publicFirst).authorization).toBe('approved-session')
    expect(fixture.prompts).toHaveLength(1)
    expect(fixture.prompts[0].questions[0].id).toMatch(/^mydsh-automation-consent:/u)

    // 同会话再次访问同一域名免重复弹窗
    const publicSecond = await fixture.runTool('browser_navigate', {
      url: 'https://docs.example.org/b',
    })
    expect(publicSecond.isError).toBeFalsy()
    expect(fixture.parseJsonText(publicSecond).authorization).toBe('auto-allowed')
    expect(fixture.prompts).toHaveLength(1)

    // 拒绝新域名
    fixture.setDecision('deny')
    const denied = await fixture.runTool('browser_navigate', { url: 'https://other.example.net/' })
    expect(denied.isError).toBe(true)
    expect(denied.content[0].text).toContain('USER_REJECTED')
  })

  it('支持多模态截图通过 ctx.attachments 返回 image 块，纯文本模型给出明确引导', async () => {
    const visionFixture = await createBrowserToolFixture({ visionModel: true })
    const shot = await visionFixture.runTool('browser_screenshot', {})
    expect(shot.isError).toBeFalsy()
    expect(visionFixture.savedImages).toHaveLength(1)
    expect(shot.content).toHaveLength(2)
    expect(shot.content[0].type).toBe('text')
    expect(shot.content[1].type).toBe('image')
    expect(shot.content[1].attachment.attachmentId).toBe('att_1')

    const textOnlyFixture = await createBrowserToolFixture({ visionModel: false })
    const failed = await textOnlyFixture.runTool('browser_screenshot', {})
    expect(failed.isError).toBe(true)
    expect(failed.content[0].text).toContain('MODEL_NO_VISION')
  })

  it('遇到验证码时弹出人工接管卡，用户确认完成后自动复拍快照，并拒绝子 Agent 调用', async () => {
    const fixture = await createBrowserToolFixture({ captchaOnFirstSnapshot: true })
    fixture.setDecision('once')
    const snap = await fixture.runTool('browser_snapshot', {})
    expect(snap.isError).toBeFalsy()
    expect(fixture.prompts).toHaveLength(1)
    expect(fixture.prompts[0].questions[0].header).toBe('人工接管提示')
    const parsed = fixture.parseJsonText(snap)
    expect(parsed.handoff_required).toBe(false)
    expect(parsed.snapshot_id).toBe('snap_2')

    // 子 Agent 被 ConnectionAccess 拒绝
    const sub = await fixture.createAgent(`sub-session-${randomUUID()}`, {
      parentSession: fixture.handle.agent.id,
      origin: 'subagent',
    })
    const denied = await fixture.runTool('browser_status', {}, sub.agent)
    expect(denied.isError).toBe(true)
    expect(denied.content[0].text).toContain('NOT_AUTHORIZED')
  })

  it('取消人工接管时报错且不泄露页面快照，急停后撤销会话授权，并拒绝未知参数字段', async () => {
    const fixture = await createBrowserToolFixture({ captchaOnFirstSnapshot: true })
    fixture.setDecision('deny')
    const canceled = await fixture.runTool('browser_snapshot', {})
    expect(canceled.isError).toBe(true)
    expect(canceled.content[0].text).toContain('USER_REJECTED')
    expect(canceled.content[0].text).not.toContain('https://example.com/verify')

    // 正常快照内容被非信任网页边界标记包裹
    const cleanSnap = await fixture.runTool('browser_snapshot', {})
    expect(cleanSnap.isError).toBeFalsy()
    expect(fixture.parseJsonText(cleanSnap).tree).toContain('<<<UNTRUSTED_WEB_PAGE>>>')

    // 急停（AUTOMATION_STOPPED）自动撤销会话级域名授权，后续访问同一域名必须重新确认
    fixture.setDecision('session')
    const okFirst = await fixture.runTool('browser_navigate', {
      url: 'https://revoke.example.org/',
    })
    expect(okFirst.isError).toBeFalsy()
    const promptsAfterGrant = fixture.prompts.length

    fixture.setNextError(new Error('AUTOMATION_STOPPED：用户按下急停'))
    const stopped = await fixture.runTool('browser_navigate', {
      url: 'https://revoke.example.org/step2',
    })
    expect(stopped.isError).toBe(true)
    expect(stopped.content[0].text).toContain('AUTOMATION_STOPPED')

    const afterStop = await fixture.runTool('browser_navigate', {
      url: 'https://revoke.example.org/step3',
    })
    expect(afterStop.isError).toBeFalsy()
    expect(fixture.prompts.length).toBe(promptsAfterGrant + 1)

    // 拒绝未知参数字段
    const badArgs = await fixture.runTool('browser_status', { unexpected_flag: true })
    expect(badArgs.isError).toBe(true)
    expect(badArgs.content[0].text).toContain('不支持未知参数')
  })
})
