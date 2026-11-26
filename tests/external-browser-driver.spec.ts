/** 测试外置浏览器纯 CDP 驱动：防 SSRF 校验、双端浏览器探测、模拟 WebSocket CDP 附着与不误杀保证。 */
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { WebSocketServer } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import { createDefaultAutomationSettings } from '../src/shared/automation.ts'
import {
  assertLoopbackDebugUrl,
  detectInstalledBrowsers,
  parseDevToolsListeningUrl,
} from '../src/main/automation/external-browser-discovery.ts'
import { createExternalBrowserDriver } from '../src/main/automation/external-browser-driver.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop()
    if (fn) await fn()
  }
})

async function createMockCdpServer() {
  let browserCloseCalls = 0
  let createdTargets = 0
  let currentUrl = 'about:blank'
  const pages = new Map<string, { id: string; title: string; url: string }>()
  pages.set('user-tab-1', {
    id: 'user-tab-1',
    title: '用户私有标签页',
    url: 'https://mail.example.com/',
  })

  const httpServer = createServer((req, res) => {
    const port = (httpServer.address() as { port: number }).port
    if (req.url === '/json/version') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          Browser: 'MockChrome/130.0',
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/root`,
        }),
      )
      return
    }
    if (req.url === '/json/list') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify(
          [...pages.values()].map(page => ({
            id: page.id,
            type: 'page',
            title: page.title,
            url: page.url,
            webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${page.id}`,
          })),
        ),
      )
      return
    }
    res.writeHead(404)
    res.end()
  })

  const wss = new WebSocketServer({ server: httpServer })
  wss.on('connection', (ws, req) => {
    const pageId = req.url?.startsWith('/devtools/page/')
      ? req.url.slice('/devtools/page/'.length)
      : null
    ws.on('message', raw => {
      const msg = JSON.parse(raw.toString()) as {
        id: number
        method: string
        params?: Record<string, unknown>
      }
      if (msg.method === 'Browser.close') {
        browserCloseCalls += 1
        ws.send(JSON.stringify({ id: msg.id, result: {} }))
        return
      }
      if (msg.method === 'Target.createTarget') {
        const id = `agent-tab-${++createdTargets}`
        const url = typeof msg.params?.url === 'string' ? msg.params.url : 'about:blank'
        pages.set(id, { id, title: '新建页', url })
        ws.send(JSON.stringify({ id: msg.id, result: { targetId: id } }))
        return
      }
      if (msg.method === 'Target.closeTarget') {
        if (typeof msg.params?.targetId === 'string') pages.delete(msg.params.targetId)
        ws.send(JSON.stringify({ id: msg.id, result: { success: true } }))
        return
      }
      if (msg.method === 'Page.navigate' && pageId) {
        currentUrl = String(msg.params?.url ?? '')
        pages.set(pageId, { id: pageId, title: '测试页', url: currentUrl })
        ws.send(JSON.stringify({ id: msg.id, result: { frameId: 'main' } }))
        ws.send(
          JSON.stringify({ method: 'Page.loadEventFired', params: { timestamp: Date.now() } }),
        )
        return
      }
      if (msg.method === 'Runtime.evaluate') {
        const expr = String(msg.params?.expression ?? '')
        if (expr.includes('MAX_ITEMS')) {
          ws.send(
            JSON.stringify({
              id: msg.id,
              result: {
                result: {
                  value: {
                    url: currentUrl,
                    title: '外置测试页',
                    viewport: { width: 1280, height: 800 },
                    scroll: { x: 0, y: 0 },
                    headings: ['外置标题'],
                    bodySnippet: '外置正文',
                    signals: { hasCaptcha: false, hasPasswordInput: false },
                    elements: [
                      {
                        tag: 'button',
                        role: 'button',
                        name: '执行查询',
                        inViewport: true,
                        rect: { x: 10, y: 20, width: 100, height: 32 },
                        center: { x: 60, y: 36 },
                      },
                    ],
                  },
                },
              },
            }),
          )
          return
        }
      }
      ws.send(JSON.stringify({ id: msg.id, result: {} }))
    })
  })

  httpServer.listen(0, '127.0.0.1')
  await once(httpServer, 'listening')
  const port = (httpServer.address() as { port: number }).port
  cleanups.push(async () => {
    wss.close()
    await new Promise<void>(resolve => httpServer.close(() => resolve()))
  })
  return { port, getBrowserCloseCalls: () => browserCloseCalls }
}

describe('外置浏览器纯 CDP 驱动与安全边界', () => {
  it('严格拒绝非 loopback 调试地址防止 SSRF，并正确解析 DevTools stderr 与双端路径', () => {
    expect(assertLoopbackDebugUrl('ws://127.0.0.1:9222/devtools/browser/abc').port).toBe('9222')
    expect(assertLoopbackDebugUrl('http://localhost:9333/json/version').hostname).toBe('localhost')
    expect(() =>
      assertLoopbackDebugUrl('ws://127.0.0.1:9333/devtools/browser/abc', { expectedPort: 9222 }),
    ).toThrow('SECURITY_BLOCK')
    expect(() =>
      assertLoopbackDebugUrl('ws://127.0.0.1:9222/other/path', { requireDevToolsPath: true }),
    ).toThrow('SECURITY_BLOCK')
    for (const bad of [
      'ws://192.168.1.5:9222/devtools/browser/abc',
      'http://10.0.0.1:9222/json/version',
      'ws://0.0.0.0:9222/devtools/browser/abc',
      'wss://127.0.0.1:9222/devtools/browser/abc',
      'http://user:pass@127.0.0.1:9222/json/version',
    ]) {
      expect(() => assertLoopbackDebugUrl(bad)).toThrow('SECURITY_BLOCK')
    }
    expect(
      parseDevToolsListeningUrl(
        'DevTools listening on ws://127.0.0.1:54321/devtools/browser/uuid-1\n',
      ),
    ).toBe('ws://127.0.0.1:54321/devtools/browser/uuid-1')

    const macFound = detectInstalledBrowsers({
      platform: 'darwin',
      exists: p => p.includes('Google Chrome.app'),
      home: '/Users/tester',
    })
    expect(macFound).toHaveLength(1)
    expect(macFound[0]?.id).toBe('chrome')

    const winFound = detectInstalledBrowsers({
      platform: 'win32',
      exists: p => p.endsWith('msedge.exe'),
      env: { PROGRAMFILES: 'C:\\Program Files' },
    })
    expect(winFound).toHaveLength(1)
    expect(winFound[0]?.id).toBe('edge')
  })

  it('附着模式默认新建受管标签、隔离用户私有标签页，并通过共享 CDP 引擎完成导航与快照，断开绝不关闭浏览器', async () => {
    const server = await createMockCdpServer()
    const tempDir = mkdtempSync(join(tmpdir(), 'mydsh-ext-test-'))
    cleanups.push(async () => {
      rmSync(tempDir, { recursive: true, force: true })
    })
    const driver = createExternalBrowserDriver({ profileDirectory: tempDir, headless: true })
    cleanups.push(() => driver.dispose())

    const settings = createDefaultAutomationSettings()
    settings.externalBrowser.enabled = true
    settings.externalBrowser.mode = 'attached'
    settings.externalBrowser.attachPort = server.port

    const probe = await driver.testConnection(settings)
    expect(probe.ok).toBe(true)
    expect(probe.browser).toBe('MockChrome/130.0')
    expect(driver.status().connected).toBe(true)

    // 附着模式下拒绝直接操控、切换或关闭用户未授权的原始标签页
    await expect(
      driver.call('snapshot', { tabId: 'user-tab-1' }, AbortSignal.timeout(5000), settings),
    ).rejects.toThrow('PERMISSION_DENIED')
    await expect(
      driver.call(
        'tabs',
        { operation: 'switch', tabId: 'user-tab-1' },
        AbortSignal.timeout(5000),
        settings,
      ),
    ).rejects.toThrow('PERMISSION_DENIED')
    await expect(
      driver.call(
        'tabs',
        { operation: 'close', tabId: 'user-tab-1' },
        AbortSignal.timeout(5000),
        settings,
      ),
    ).rejects.toThrow('PERMISSION_DENIED')

    // 主进程黑名单同样拦截外置浏览器导航
    settings.embeddedBrowser.blockedOrigins = ['https://blocked.example.com']
    await expect(
      driver.call(
        'navigate',
        { mode: 'url', url: 'https://blocked.example.com/secret' },
        AbortSignal.timeout(5000),
        settings,
      ),
    ).rejects.toThrow('SECURITY_BLOCK')

    // 未指定 tabId 时新建受管标签页完成导航与快照
    const nav = (await driver.call(
      'navigate',
      { mode: 'url', url: 'http://127.0.0.1:4173/ext' },
      AbortSignal.timeout(5000),
      settings,
    )) as { tabId: string; url: string }
    expect(nav.tabId).toBe('agent-tab-1')
    expect(nav.url).toBe('http://127.0.0.1:4173/ext')

    const snap = (await driver.call(
      'snapshot',
      { tabId: nav.tabId },
      AbortSignal.timeout(5000),
      settings,
    )) as { tree: string; elementsCount: number }
    expect(snap.elementsCount).toBe(1)
    expect(snap.tree).toContain('@e1 [button] "执行查询"')

    await driver.stop()
    expect(driver.status().connected).toBe(false)
    // 附着模式断开连接绝不发送 Browser.close
    expect(server.getBrowserCloseCalls()).toBe(0)
  })
})
