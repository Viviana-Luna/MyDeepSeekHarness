/** 验证自动化设置契约、持久化原子写、损坏配置降级及主进程急停中断传播。 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createDefaultAutomationSettings,
  isLocalhostOrigin,
  normalizeAutomationSettings,
  normalizeOriginRule,
} from '../src/shared/automation.ts'
import { createAutomationSettingsStore } from '../src/main/automation/automation-settings.ts'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  globalShortcut: { register: vi.fn(() => true), unregister: vi.fn() },
  screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 800 } }) },
  BrowserWindow: vi.fn(),
}))

import { createAutomationSystem } from '../src/main/automation/automation-system.ts'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

function tempSettingsPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mydsh-automation-settings-'))
  tempDirs.push(dir)
  return join(dir, 'automation.json')
}

describe('自动化设置校验与持久化', () => {
  it('默认全部关闭，正确规范化 Origin 并拒绝非法协议、端口或字段', () => {
    const defaults = createDefaultAutomationSettings()
    expect(defaults.embeddedBrowser.enabled).toBe(false)
    expect(defaults.externalBrowser.enabled).toBe(false)
    expect(defaults.computerUse.enabled).toBe(false)

    expect(normalizeOriginRule('https://Docs.Example.com/path?a=1')).toBe(
      'https://docs.example.com',
    )
    expect(isLocalhostOrigin('http://localhost:3000/app')).toBe(true)
    expect(isLocalhostOrigin('http://127.0.0.1:5173')).toBe(true)
    expect(isLocalhostOrigin('https://example.com')).toBe(false)

    expect(() => normalizeOriginRule('file:///etc/passwd')).toThrow('http:// 或 https://')
    expect(() => normalizeAutomationSettings({ externalBrowser: { attachPort: 80 } })).toThrow(
      '1024 至 65535',
    )
    expect(() => normalizeAutomationSettings({ computerUse: { maxImageLongEdge: 2560 } })).toThrow(
      '640 至 2048',
    )
    expect(() => normalizeAutomationSettings({ unknownSection: true })).toThrow('未知顶级字段')
  })

  it('支持原子持久化并在配置文件损坏时安全回退默认关闭状态', () => {
    const filePath = tempSettingsPath()
    const store = createAutomationSettingsStore(filePath)
    const updated = store.update({
      embeddedBrowser: { enabled: true, allowedOrigins: ['https://example.com/foo'] },
      externalBrowser: { mode: 'attached', attachPort: 9333 },
    })
    expect(updated.embeddedBrowser.enabled).toBe(true)
    expect(updated.embeddedBrowser.allowedOrigins).toEqual(['https://example.com'])
    expect(updated.externalBrowser.attachPort).toBe(9333)

    const reloaded = createAutomationSettingsStore(filePath).read()
    expect(reloaded.embeddedBrowser.enabled).toBe(true)
    expect(reloaded.externalBrowser.attachPort).toBe(9333)

    writeFileSync(filePath, '{corrupted json', 'utf8')
    const degraded = createAutomationSettingsStore(filePath).read()
    expect(degraded.embeddedBrowser.enabled).toBe(false)
    expect(degraded.warning).toContain('配置文件损坏')
  })
})

describe('主进程自动化总控与急停传播', () => {
  it('默认拒绝未开启的驱动调用，开启后支持执行追踪与全局急停立即中止', async () => {
    const system = createAutomationSystem({ settingsPath: tempSettingsPath(), headless: true })
    const releaseInputs = vi.fn()
    await expect(
      system.handleRuntimeCall(
        'automation.browser.embedded.snapshot',
        {},
        new AbortController().signal,
      ),
    ).rejects.toThrow('PERMISSION_DENIED')

    system.updateSettings({ computerUse: { enabled: true } })
    let capturedSignal: AbortSignal | undefined
    system.registerDrivers({
      releaseInputs,
      callComputerUse: async (_action, _payload, signal) => {
        capturedSignal = signal
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      },
    })

    const running = system.handleRuntimeCall(
      'automation.computer.click',
      { sessionId: 's-1', targetLabel: 'Notes' },
      new AbortController().signal,
    )
    await vi.waitFor(() => expect(system.getTakeoverState().active).toBe(true))
    expect(system.getTakeoverState().targetLabel).toBe('Notes')
    expect(system.getTakeoverState().stepCount).toBe(1)

    await system.stopTakeover('触发急停测试')
    await expect(running).rejects.toThrow('AUTOMATION_STOPPED')
    expect(capturedSignal?.aborted).toBe(true)
    expect(releaseInputs).toHaveBeenCalledOnce()
    expect(system.getTakeoverState().active).toBe(false)

    // 关闭内置浏览器开关时立即中止该类型任务并触发 stopEmbedded
    const stopEmbedded = vi.fn(async () => {})
    const stopExternal = vi.fn(async () => {})
    system.registerDrivers({
      stopEmbedded,
      stopExternal,
      callEmbeddedBrowser: async (_action, _payload, signal) => {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      },
    })
    system.updateSettings({
      embeddedBrowser: { enabled: true },
      externalBrowser: { enabled: true },
    })
    const embeddedRun = system.handleRuntimeCall(
      'automation.browser.embedded.snapshot',
      { sessionId: 's-2' },
      new AbortController().signal,
    )
    await vi.waitFor(() => expect(system.getTakeoverState().kind).toBe('embedded-browser'))
    system.updateSettings({ embeddedBrowser: { enabled: false } })
    await expect(embeddedRun).rejects.toThrow('AUTOMATION_STOPPED')
    expect(stopEmbedded).toHaveBeenCalledOnce()

    system.updateSettings({ externalBrowser: { enabled: false } })
    expect(stopExternal).toHaveBeenCalledOnce()
    await system.dispose()
  })
})
