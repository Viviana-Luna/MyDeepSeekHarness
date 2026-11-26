/** 测试统一 CDP 页面引擎的 `@eN` 快照、过期失效、点击、中文输入、脱敏诊断与敏感页人工接管识别。 */
import { describe, expect, it } from 'vitest'
import { createCdpPageEngine } from '../src/main/automation/cdp-engine.ts'
import type { CdpTransport } from '../src/main/automation/cdp-transport.ts'

const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

function createMockCdpTransport(options?: {
  rawSnapshot?: Record<string, unknown>
  axNodes?: unknown[]
  pointInspectResult?: Record<string, unknown> | null
  activeIsPassword?: boolean
}) {
  const commands: Array<{ method: string; params?: Record<string, unknown> }> = []
  const listeners = new Map<string, Set<(params: Record<string, unknown>) => void>>()
  let currentSnapshot = options?.rawSnapshot ?? {
    url: 'http://127.0.0.1:4173/demo',
    title: '演示表单',
    viewport: { width: 1280, height: 800 },
    scroll: { x: 0, y: 0 },
    headings: ['演示标题'],
    bodySnippet: '欢迎使用演示页面',
    signals: { hasCaptcha: false, hasPasswordInput: false },
    elements: [
      {
        tag: 'input',
        role: 'text',
        name: '用户名',
        value: '',
        inputType: 'text',
        inViewport: true,
        rect: { x: 100, y: 120, width: 200, height: 32 },
        center: { x: 200, y: 136 },
      },
      {
        tag: 'button',
        role: 'button',
        name: '确认支付',
        inViewport: true,
        rect: { x: 100, y: 200, width: 120, height: 36 },
        center: { x: 160, y: 218 },
      },
      {
        tag: 'input',
        role: 'password',
        name: '密码',
        value: '',
        inputType: 'password',
        inViewport: true,
        rect: { x: 100, y: 260, width: 200, height: 32 },
        center: { x: 200, y: 276 },
      },
      {
        tag: 'button',
        role: 'button',
        name: '普通提交',
        inViewport: false,
        rect: { x: 100, y: 1400, width: 120, height: 36 },
        center: { x: 160, y: 1418 },
      },
    ],
  }
  let closed = false

  const transport: CdpTransport = {
    async sendCommand<T>(method: string, params?: Record<string, unknown>): Promise<T> {
      commands.push({ method, ...(params ? { params } : {}) })
      if (method === 'Runtime.evaluate') {
        const expr = String(params?.expression ?? '')
        if (expr.includes('MAX_ITEMS')) return { result: { value: currentSnapshot } } as T
        if (expr.includes('document.activeElement')) {
          return { result: { value: options?.activeIsPassword === true } } as T
        }
        if (expr.includes('elementFromPoint') && expr.includes('closest')) {
          return { result: { value: options?.pointInspectResult ?? null } } as T
        }
        if (expr.includes('window.scrollTo')) {
          return { result: { value: { x: 0, y: 1000 } } } as T
        }
        if (expr.includes('innerText.includes')) return { result: { value: true } } as T
        if (expr.includes('SELECT')) {
          return {
            result: { value: { ok: true, selectedValue: 'zh', selectedLabel: '简体中文' } },
          } as T
        }
        return {
          result: {
            value: {
              url: currentSnapshot.url,
              title: currentSnapshot.title,
              width: 1280,
              height: 800,
            },
          },
        } as T
      }
      if (method === 'Accessibility.getFullAXTree') {
        return {
          nodes: options?.axNodes ?? [
            { role: { value: 'main' }, name: { value: '主区域' } },
            { role: { value: 'navigation' }, name: { value: '顶部导航' } },
          ],
        } as T
      }
      if (method === 'Page.captureScreenshot') {
        return { data: TINY_PNG_BASE64 } as T
      }
      return {} as T
    },
    onEvent(method, listener) {
      let bucket = listeners.get(method)
      if (!bucket) {
        bucket = new Set()
        listeners.set(method, bucket)
      }
      bucket.add(listener)
      return () => {
        bucket?.delete(listener)
      }
    },
    async close() {
      closed = true
    },
    isAlive: () => !closed,
  }

  const emit = (method: string, params: Record<string, unknown>) => {
    for (const listener of listeners.get(method) ?? []) listener(params)
  }

  return {
    transport,
    commands,
    emit,
    setSnapshot(next: Record<string, unknown>) {
      currentSnapshot = next
    },
    isClosed: () => closed,
  }
}

describe('统一 CDP 页面引擎', () => {
  it('按视口优先生成 @eN 快照、支持中文输入与点击，并在导航后拒绝过期 snapshotId', async () => {
    const mock = createMockCdpTransport()
    const engine = createCdpPageEngine({ transport: mock.transport })
    try {
      const snap = await engine.snapshot()
      expect(snap.elementsCount).toBe(4)
      expect(snap.tree).toContain('@e1 [text] "用户名"')
      expect(snap.tree).toContain('Accessibility Landmarks:')
      expect(snap.handoff).toBeUndefined()

      // 输入中文文本并回车提交
      const typed = await engine.type({
        ref: '@e1',
        snapshotId: snap.snapshotId,
        text: '测试中文账号',
        clear: true,
        submit: true,
      })
      expect(typed.ok).toBe(true)
      expect(typed.typedLength).toBe(6)
      expect(
        mock.commands.some(
          cmd => cmd.method === 'Input.insertText' && cmd.params?.text === '测试中文账号',
        ),
      ).toBe(true)

      // 离屏元素 @e4 先滚动再点击
      const clicked = await engine.click({ ref: '@e4', snapshotId: snap.snapshotId })
      expect(clicked.ok).toBe(true)
      expect(clicked.y).toBe(418)

      // 错误的 snapshotId 直接拒绝
      await expect(engine.click({ ref: '@e1', snapshotId: 'snap_expired' })).rejects.toThrow(
        'STALE_SNAPSHOT',
      )

      // 页面发生主框架导航后自动作废旧快照
      mock.emit('Page.frameNavigated', { frame: { url: 'http://127.0.0.1:4173/next' } })
      await expect(engine.click({ ref: '@e1', snapshotId: snap.snapshotId })).rejects.toThrow(
        'STALE_SNAPSHOT',
      )
    } finally {
      await engine.dispose()
    }
    expect(mock.isClosed()).toBe(true)
  })

  it('拦截支付按钮点击、密码框输入与验证码页面并返回人工接管信号', async () => {
    const mock = createMockCdpTransport()
    const engine = createCdpPageEngine({ transport: mock.transport })
    try {
      const snap = await engine.snapshot()
      const payAttempt = await engine.click({ ref: '@e2', snapshotId: snap.snapshotId })
      expect(payAttempt.ok).toBe(false)
      expect(payAttempt.handoff?.required).toBe(true)
      expect(payAttempt.handoff?.category).toBe('payment')

      const pwdAttempt = await engine.type({
        ref: '@e3',
        snapshotId: snap.snapshotId,
        text: 'secret123',
      })
      expect(pwdAttempt.ok).toBe(false)
      expect(pwdAttempt.handoff?.category).toBe('auth')

      mock.setSnapshot({
        url: 'https://example.com/verify',
        title: '请完成安全验证',
        viewport: { width: 1280, height: 800 },
        headings: [],
        bodySnippet: 'Verify you are human',
        signals: { hasCaptcha: true, hasPasswordInput: false },
        elements: [],
      })
      const captchaSnap = await engine.snapshot()
      expect(captchaSnap.handoff?.required).toBe(true)
      expect(captchaSnap.handoff?.category).toBe('captcha')
    } finally {
      await engine.dispose()
    }
  })

  it('采集脱敏后的 Console 与网络请求诊断并支持截图返回', async () => {
    const mock = createMockCdpTransport()
    const engine = createCdpPageEngine({ transport: mock.transport })
    try {
      await engine.init()
      mock.emit('Runtime.consoleAPICalled', {
        type: 'error',
        args: [{ value: 'Authorization Bearer supersecrettoken12345 failed sk-1234567890abcdef' }],
      })
      mock.emit('Network.requestWillBeSent', {
        requestId: 'req-1',
        type: 'Fetch',
        request: {
          method: 'GET',
          url: 'https://api.example.com/v1/items?token=topsecret&page=2',
        },
      })
      mock.emit('Network.responseReceived', {
        requestId: 'req-1',
        response: { status: 200 },
      })
      mock.emit('Network.loadingFinished', { requestId: 'req-1' })

      const diag = engine.diagnostics({ clear: true })
      expect(diag.console).toHaveLength(1)
      expect(diag.console[0]?.text).not.toContain('supersecrettoken12345')
      expect(diag.console[0]?.text).not.toContain('sk-1234567890abcdef')
      expect(diag.network[0]?.url).toContain('token=%5BREDACTED%5D')
      expect(diag.network[0]?.status).toBe(200)
      expect(engine.diagnostics().console).toHaveLength(0)

      const shot = await engine.screenshot()
      expect(shot.mediaType).toBe('image/png')
      expect(shot.width).toBe(1)
      expect(shot.height).toBe(1)
    } finally {
      await engine.dispose()
    }
  })

  it('拦截坐标点击敏感支付/密码控件、无 ref 密码框输入，脱敏 Hash/Cookie/JWT，并拒绝原型链键名', async () => {
    const mock = createMockCdpTransport({
      pointInspectResult: { tag: 'button', name: '确认支付', inputType: '' },
      activeIsPassword: true,
    })
    const engine = createCdpPageEngine({ transport: mock.transport })
    try {
      const coordClick = await engine.click({ x: 160, y: 218 })
      expect(coordClick.ok).toBe(false)
      expect(coordClick.handoff?.required).toBe(true)
      expect(coordClick.handoff?.category).toBe('payment')

      const reflessType = await engine.type({ text: 'secret-pass' })
      expect(reflessType.ok).toBe(false)
      expect(reflessType.handoff?.required).toBe(true)
      expect(reflessType.handoff?.category).toBe('auth')

      mock.emit('Runtime.consoleAPICalled', {
        type: 'log',
        args: [
          {
            value:
              'Basic dXNlcjpwYXNz; Cookie: sid=abc123; eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3OCJ9.signature123456',
          },
        ],
      })
      mock.emit('Network.requestWillBeSent', {
        requestId: 'req-hash',
        type: 'Document',
        request: {
          method: 'GET',
          url: 'https://app.example.com/cb#access_token=secret999&state=ok',
        },
      })
      mock.emit('Network.loadingFinished', { requestId: 'req-hash' })
      const diag = engine.diagnostics()
      expect(diag.console[0]?.text).not.toContain('dXNlcjpwYXNz')
      expect(diag.console[0]?.text).not.toContain('sid=abc123')
      expect(diag.console[0]?.text).toContain('[REDACTED_JWT]')
      expect(diag.network[0]?.url).not.toContain('secret999')

      await expect(engine.pressKey({ key: 'constructor' })).rejects.toThrow('不支持的按键名称')
    } finally {
      await engine.dispose()
    }
  })
})
