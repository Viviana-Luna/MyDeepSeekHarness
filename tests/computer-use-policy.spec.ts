/** 测试桌面 Computer Use 坐标归一化（Retina/Windows DPI/副屏负坐标）、单窗口越界、敏感应用黑名单与禁键守卫。 */
import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_BLOCKED_APPS,
  formatKillSwitchLabel,
  resolveKillSwitchShortcut,
} from '../src/shared/automation.ts'
import {
  assertPointInsideRect,
  assertSystemKeyComboAllowed,
  buildCaptureMapping,
  detectUserMouseOverride,
  findWindowAtPoint,
  intersectRect,
  isWindowBlocked,
  mapCapturePointToSystem,
} from '../src/main/automation/computer-use-policy.ts'

vi.mock('electron', () => ({
  shell: { openExternal: vi.fn() },
}))

import { resolvePlatformKey } from '../src/main/automation/computer-use-native.ts'

describe('桌面 Computer Use 坐标归一与安全策略', () => {
  it('在 macOS Retina 2x、Windows 150% DPI 与左侧负坐标副屏下精确还原系统逻辑坐标', () => {
    // macOS 1512x982 逻辑主屏（Retina 2x 物理 3024x1964），缩放到 1280x831 截图
    const macMapping = buildCaptureMapping({
      captureId: 'cap_mac',
      displayId: 1,
      scope: 'display',
      displayBounds: { x: 0, y: 0, width: 1512, height: 982 },
      imageWidth: 1280,
      imageHeight: 831,
    })
    const macCenter = mapCapturePointToSystem(macMapping, 640, 415.5)
    expect(macCenter).toEqual({ x: 756, y: 491 })

    // 左侧副屏（负坐标 x = -1920，Windows 150% DPI 逻辑 1280x720）
    const secondaryMapping = buildCaptureMapping({
      captureId: 'cap_win_sec',
      displayId: 2,
      scope: 'display',
      displayBounds: { x: -1920, y: 100, width: 1280, height: 720 },
      imageWidth: 640,
      imageHeight: 360,
    })
    expect(mapCapturePointToSystem(secondaryMapping, 320, 180)).toEqual({ x: -1280, y: 460 })
    expect(() => mapCapturePointToSystem(secondaryMapping, 700, 100)).toThrow(
      'COORDINATE_OUT_OF_RANGE',
    )
  })

  it('单窗口模式按窗口裁剪区换算坐标并严格拦截越界操作', () => {
    const clip = intersectRect(
      { x: 0, y: 0, width: 1440, height: 900 },
      { x: 200, y: 120, width: 800, height: 600 },
    )
    expect(clip).toEqual({ x: 200, y: 120, width: 800, height: 600 })
    const mapping = buildCaptureMapping({
      captureId: 'cap_win',
      displayId: 1,
      scope: 'window',
      displayBounds: { x: 0, y: 0, width: 1440, height: 900 },
      windowClipBounds: clip!,
      windowPid: 12345,
      windowAppName: 'TextEdit',
      imageWidth: 800,
      imageHeight: 600,
    })
    expect(mapCapturePointToSystem(mapping, 100, 50)).toEqual({ x: 300, y: 170 })
    expect(() => mapCapturePointToSystem(mapping, -1, 50)).toThrow('COORDINATE_OUT_OF_RANGE')
    expect(() => mapCapturePointToSystem(mapping, 801, 50)).toThrow('COORDINATE_OUT_OF_RANGE')
  })

  it('拦截 MyDSH 自身窗口、密码管理器与系统安全授权弹窗，并检测用户手动抢夺鼠标', () => {
    expect(
      isWindowBlocked({
        window: { pid: 9999, appName: 'Electron', bundleId: 'com.mydsh.desktop', title: 'MyDSH' },
        blockedApps: DEFAULT_BLOCKED_APPS,
        selfPid: 9999,
      }).blocked,
    ).toBe(true)

    for (const sensitive of [
      {
        pid: 101,
        appName: 'Keychain Access',
        bundleId: 'com.apple.keychainaccess',
        title: '钥匙串访问',
      },
      { pid: 102, appName: '1Password', bundleId: 'com.1password.1password', title: '1Password' },
      { pid: 103, appName: 'SecurityAgent', bundleId: 'com.apple.SecurityAgent', title: '授权' },
      {
        pid: 104,
        appName: 'CredentialUIBroker.exe',
        bundleId: 'CredentialUIBroker.exe',
        title: 'Windows 安全',
      },
    ]) {
      expect(
        isWindowBlocked({ window: sensitive, blockedApps: DEFAULT_BLOCKED_APPS, selfPid: 9999 })
          .blocked,
      ).toBe(true)
    }

    expect(
      isWindowBlocked({
        window: { pid: 200, appName: 'Notes', bundleId: 'com.apple.Notes', title: '备忘录' },
        blockedApps: DEFAULT_BLOCKED_APPS,
        selfPid: 9999,
      }).blocked,
    ).toBe(false)

    expect(detectUserMouseOverride({ x: 100, y: 100 }, { x: 120, y: 110 })).toBe(false)
    expect(detectUserMouseOverride({ x: 100, y: 100 }, { x: 400, y: 100 })).toBe(true)

    const stacked = [
      {
        windowId: 1,
        pid: 9999,
        appName: 'MyDSH',
        bundleId: 'com.mydsh.desktop',
        title: 'MyDSH',
        bounds: { x: 0, y: 0, width: 600, height: 600 },
        layer: 0,
        isFrontmost: true,
      },
      {
        windowId: 2,
        pid: 200,
        appName: 'Notes',
        bundleId: 'com.apple.Notes',
        title: '备忘录',
        bounds: { x: 200, y: 0, width: 800, height: 600 },
        layer: 0,
        isFrontmost: false,
      },
    ]
    expect(findWindowAtPoint(stacked, 300, 300)?.windowId).toBe(1)
    expect(findWindowAtPoint(stacked, 750, 300)?.windowId).toBe(2)
    expect(findWindowAtPoint(stacked, 1300, 300)).toBeUndefined()
  })

  it('拦截系统级高危组合键并正确映射 macOS 与 Windows 双端虚拟键码', () => {
    for (const forbidden of [
      'Control+Alt+Delete',
      'Command+Option+Escape',
      'Command+Control+Q',
      'Meta+L',
      'Command+Shift+Escape',
      'Ctrl+Shift+Esc',
      'Control+Shift+F12',
    ]) {
      expect(() => assertSystemKeyComboAllowed(forbidden)).toThrow('SECURITY_BLOCK')
    }
    expect(() => assertSystemKeyComboAllowed('Command+C')).not.toThrow()
    expect(() => assertSystemKeyComboAllowed('Control+V')).not.toThrow()
    expect(resolveKillSwitchShortcut('darwin')).toBe('Command+Shift+Escape')
    expect(resolveKillSwitchShortcut('win32')).toBe('Control+Shift+F12')
    expect(formatKillSwitchLabel('Control+Shift+F12')).toBe('Ctrl+Shift+F12')

    expect(resolvePlatformKey('Command+V', [], 'darwin')).toEqual({ keyCode: 9, modifierMask: 4 })
    expect(resolvePlatformKey('Command++', [], 'darwin')).toEqual({ keyCode: 24, modifierMask: 12 })
    expect(resolvePlatformKey('+', [], 'win32')).toEqual({ keyCode: 0xbb, modifierMask: 8 })
    expect(resolvePlatformKey('Enter', [], 'darwin')).toEqual({ keyCode: 36, modifierMask: 0 })
    expect(resolvePlatformKey('Control+V', [], 'win32')).toEqual({ keyCode: 86, modifierMask: 2 })
    expect(resolvePlatformKey('Enter', [], 'win32')).toEqual({ keyCode: 0x0d, modifierMask: 0 })
    // 禁止通过原型链键名绕过键码表查询
    expect(() => resolvePlatformKey('constructor', [], 'darwin')).toThrow('暂不支持该按键名称')
    expect(() => resolvePlatformKey('__proto__', [], 'win32')).toThrow('暂不支持该按键名称')

    expect(() =>
      assertPointInsideRect({ x: 150, y: 150 }, { x: 100, y: 100, width: 200, height: 100 }),
    ).not.toThrow()
    expect(() =>
      assertPointInsideRect({ x: 301, y: 150 }, { x: 100, y: 100, width: 200, height: 100 }),
    ).toThrow('WINDOW_SCOPE_VIOLATION')
    expect(() =>
      assertPointInsideRect({ x: 99, y: 150 }, { x: 100, y: 100, width: 200, height: 100 }),
    ).toThrow('WINDOW_SCOPE_VIOLATION')
  })
})
