/** 测试系统级 Computer Use 驱动：ScreenCaptureKit 去阴影截帧、AX `@uN` 控件直达、窗口位移补偿、三层确定性投递与模拟 AI 光标。 */
import { describe, expect, it, vi } from 'vitest'
import {
  createDefaultAutomationSettings,
  type AutomationSettings,
} from '../src/shared/automation.ts'
import type { ComputerUseNativeAddon } from '../src/main/automation/computer-use-native.ts'
import type { ComputerUseWindowInfo } from '../src/main/automation/computer-use-policy.ts'
import type {
  VirtualCursorActionEvent,
  VirtualCursorOverlayController,
} from '../src/main/automation/virtual-cursor-overlay.ts'

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

const electronMocks = vi.hoisted(() => ({
  getSources: vi.fn(),
  clipboardText: '用户原剪贴板内容',
  clipboardWrite: vi.fn(),
}))

vi.mock('electron', () => ({
  clipboard: {
    readText: () => electronMocks.clipboardText,
    writeText: electronMocks.clipboardWrite,
  },
  screen: {
    getPrimaryDisplay: () => ({
      id: 1,
      label: '主屏',
      bounds: { x: 0, y: 0, width: 1440, height: 900 },
      scaleFactor: 2,
    }),
    getAllDisplays: () => [
      {
        id: 1,
        label: '主屏',
        bounds: { x: 0, y: 0, width: 1440, height: 900 },
        scaleFactor: 2,
      },
    ],
  },
  desktopCapturer: {
    getSources: electronMocks.getSources,
  },
  nativeImage: {
    createFromBuffer: () => ({
      isEmpty: () => false,
      getSize: () => ({ width: 800, height: 600 }),
      resize: () => ({ toPNG: () => TINY_PNG, toJPEG: () => TINY_PNG }),
      toPNG: () => TINY_PNG,
      toJPEG: () => TINY_PNG,
    }),
  },
  shell: { openExternal: vi.fn() },
}))

import { createComputerUseDriver } from '../src/main/automation/computer-use-driver.ts'

function makeImageStub(width: number, height: number) {
  return {
    isEmpty: () => false,
    getSize: () => ({ width, height }),
    crop: () => makeImageStub(width, height),
    resize: ({ width: nextW, height: nextH }: { width: number; height: number }) =>
      makeImageStub(nextW, nextH),
    toPNG: () => TINY_PNG,
    toJPEG: () => TINY_PNG,
  }
}

function createFixture(windowsRef: { current: ComputerUseWindowInfo[] }) {
  let cursorPos = { x: 100, y: 100 }
  const addon: ComputerUseNativeAddon = {
    checkPermissions: () => ({ accessibility: true, screenRecording: true }),
    requestPermissions: () => ({ accessibility: true, screenRecording: true }),
    listWindows: () => windowsRef.current,
    focusWindow: vi.fn(() => true),
    captureWindowPng: vi.fn((windowId: number) => {
      const win = windowsRef.current.find(w => w.windowId === windowId)
      return win ? { png: TINY_PNG, bounds: win.bounds } : null
    }),
    getUiTree: vi.fn(() => [
      {
        role: 'AXButton',
        title: '点赞',
        value: '',
        editable: false,
        pressable: true,
        bounds: { x: 260, y: 220, width: 80, height: 40 },
      },
      {
        role: 'AXTextField',
        title: '搜索框',
        value: '',
        editable: true,
        pressable: false,
        bounds: { x: 200, y: 140, width: 200, height: 32 },
      },
    ]),
    axPressAt: vi.fn(() => true),
    axSetTextAt: vi.fn(() => true),
    // 模拟真实系统光标随注入点击/移动更新，避免 Windows 非后台模式下连续点击误触发漂移拦截。
    getCursorPosition: vi.fn(() => ({ ...cursorPos })),
    mouseMove: vi.fn((x: number, y: number) => {
      cursorPos = { x, y }
      return true
    }),
    mouseClick: vi.fn((x: number, y: number) => {
      cursorPos = { x, y }
      return true
    }),
    mouseDrag: vi.fn((_fx: number, _fy: number, tx: number, ty: number) => {
      cursorPos = { x: tx, y: ty }
      return true
    }),
    mouseScroll: vi.fn(() => true),
    keyTap: vi.fn(() => true),
    typeText: vi.fn(() => true),
    releaseAllModifiers: vi.fn(() => true),
  }
  const cursorActions: VirtualCursorActionEvent[] = []
  const captureHides: boolean[] = []
  const cursorOverlay: VirtualCursorOverlayController = {
    showAction: vi.fn(async ev => {
      cursorActions.push(ev)
    }),
    setCaptureHidden: vi.fn(hidden => {
      captureHides.push(hidden)
    }),
    hide: vi.fn(),
    dispose: vi.fn(),
  }
  const defaults = createDefaultAutomationSettings()
  const settings: AutomationSettings = {
    ...defaults,
    computerUse: {
      ...defaults.computerUse,
      enabled: true,
      scope: 'display',
    },
  }
  const driver = createComputerUseDriver({
    addon,
    selfPid: 9999,
    headless: false,
    cursorOverlay,
  })
  return { addon, cursorOverlay, cursorActions, captureHides, settings, driver }
}

describe('Computer Use 去阴影截帧、AX @uN 直达与三层确定性投递', () => {
  it('优先使用 ScreenCaptureKit 截帧并返回 @uN 控件索引，纯后台 AX 直达与窗口位移补偿均准确', async () => {
    const windowsRef = {
      current: [
        {
          windowId: 1,
          pid: 9999,
          appName: 'MyDSH',
          bundleId: 'com.mydsh.desktop',
          title: 'MyDSH',
          bounds: { x: 0, y: 0, width: 700, height: 800 },
          layer: 0,
          isFrontmost: true,
        },
        {
          windowId: 42,
          pid: 2026,
          appName: 'Notes',
          bundleId: 'com.apple.Notes',
          title: '备忘录',
          bounds: { x: 100, y: 100, width: 800, height: 600 },
          layer: 0,
          isFrontmost: false,
        },
      ],
    }

    const { addon, cursorOverlay, cursorActions, captureHides, settings, driver } =
      createFixture(windowsRef)
    const signal = AbortSignal.timeout(5_000)

    // 1. 截帧走 ScreenCaptureKit（零阴影），返回 @u1/@u2 控件索引，并隐身/恢复模拟光标
    const shot = (await driver.call('screenshot', { windowId: 42 }, signal, settings)) as {
      captureId: string
      captureMethod: string
      elementsCount: number
      elementsSummary: string
    }
    expect(shot.captureMethod).toBe(
      process.platform === 'win32' ? 'win32-printwindow' : 'screencapturekit',
    )
    expect(shot.elementsCount).toBe(2)
    expect(shot.elementsSummary).toContain('@u1 [button] "点赞"')
    expect(shot.elementsSummary).toContain('@u2 [textfield] "搜索框"')
    expect(captureHides).toEqual([true, false])

    // 2. 通过 @u1 点击：macOS 走第 1 层纯后台 AXPress（不触发 HID 焦点切换）
    const axClick = (await driver.call(
      'click',
      { captureId: shot.captureId, ref: '@u1' },
      signal,
      settings,
    )) as { ok: boolean; deliveryMethod: string; systemX: number; systemY: number }
    expect(axClick.ok).toBe(true)
    expect(axClick.systemX).toBe(300)
    expect(axClick.systemY).toBe(240)
    if (process.platform === 'darwin') {
      expect(axClick.deliveryMethod).toBe('ax-background')
      expect(addon.axPressAt).toHaveBeenCalledWith(2026, 300, 240)
      expect(addon.mouseClick).not.toHaveBeenCalled()
    }
    expect(cursorActions.at(-1)).toMatchObject({
      kind: 'click',
      x: 300,
      y: 240,
      label: 'AI · 点击',
    })

    // 3. 窗口整体平移 (+50, +30) 且 AXPress 不可用时，自动补偿位移并降级到第 2 层 HID 微激活+焦点复原
    windowsRef.current = [
      windowsRef.current[0]!,
      { ...windowsRef.current[1]!, bounds: { x: 150, y: 130, width: 800, height: 600 } },
    ]
    ;(addon.axPressAt as ReturnType<typeof vi.fn>).mockReturnValueOnce(false)
    const hidClick = (await driver.call(
      'click',
      { captureId: shot.captureId, ref: '@u1' },
      signal,
      settings,
    )) as { ok: boolean; deliveryMethod: string; systemX: number; systemY: number }
    expect(hidClick.systemX).toBe(350)
    expect(hidClick.systemY).toBe(270)
    if (process.platform === 'darwin') {
      expect(hidClick.deliveryMethod).toBe('hid-micro-activate')
      expect(addon.mouseClick).toHaveBeenCalledWith(350, 270, 0, 1, 0, 2026, 42, true)
    }

    // 4. 通过 @u2 输入：先尝试验证式 AXValue 写入（不触碰剪贴板）；若只读则安全粘贴并还原原剪贴板
    electronMocks.clipboardWrite.mockClear()
    const axType = (await driver.call(
      'type',
      { captureId: shot.captureId, ref: '@u2', text: '极客湾测试', clear: true },
      signal,
      settings,
    )) as { ok: boolean; deliveryMethod: string }
    expect(axType.ok).toBe(true)
    if (process.platform === 'darwin') {
      expect(axType.deliveryMethod).toBe('ax-background')
      expect(addon.axSetTextAt).toHaveBeenCalledWith(2026, 350, 186, '极客湾测试')
      expect(electronMocks.clipboardWrite).not.toHaveBeenCalled()
    }

    ;(addon.axSetTextAt as ReturnType<typeof vi.fn>).mockReturnValueOnce(false)
    const fallbackType = (await driver.call(
      'type',
      { captureId: shot.captureId, ref: '@u2', text: '回退粘贴', submit: true },
      signal,
      settings,
    )) as { ok: boolean; deliveryMethod: string }
    expect(fallbackType.ok).toBe(true)
    expect(electronMocks.clipboardWrite).toHaveBeenCalledWith('回退粘贴')
    expect(electronMocks.clipboardWrite).toHaveBeenLastCalledWith('用户原剪贴板内容')

    // 5. 急停与销毁时立即清理模拟光标层（杜绝残留幽灵光标）
    driver.releaseInputs()
    expect(cursorOverlay.hide).toHaveBeenCalledOnce()
    await driver.dispose()
    expect(cursorOverlay.dispose).toHaveBeenCalledOnce()
  })

  it('整屏模式下按点击坐标 Z 序判定防自锁：点中 MyDSH 区域拒绝，点中旁侧浏览器放行', async () => {
    const windowsRef = {
      current: [
        {
          windowId: 1,
          pid: 9999,
          appName: 'MyDSH',
          bundleId: 'com.mydsh.desktop',
          title: 'MyDSH',
          bounds: { x: 0, y: 0, width: 700, height: 800 },
          layer: 0,
          isFrontmost: true,
        },
        {
          windowId: 88,
          pid: 3000,
          appName: 'Google Chrome',
          bundleId: 'com.google.Chrome',
          title: 'Bilibili',
          bounds: { x: 720, y: 0, width: 720, height: 800 },
          layer: 0,
          isFrontmost: false,
        },
      ],
    }
    electronMocks.getSources.mockResolvedValue([
      { id: 'screen:1:0', display_id: '1', thumbnail: makeImageStub(1440, 900) },
    ])
    const { addon, settings, driver } = createFixture(windowsRef)
    const signal = AbortSignal.timeout(5_000)
    const shot = (await driver.call('screenshot', {}, signal, settings)) as { captureId: string }

    // 点击左侧 MyDSH 区域必须命中防自锁保护
    await expect(
      driver.call('click', { captureId: shot.captureId, x: 100, y: 100 }, signal, settings),
    ).rejects.toThrow('防自锁保护')

    // 点击右侧 Chrome 区域（图像 x=960 -> 屏幕 1080）即使 MyDSH 在前台也应正常放行
    ;(addon.axPressAt as ReturnType<typeof vi.fn>).mockReturnValueOnce(false)
    const ok = (await driver.call(
      'click',
      { captureId: shot.captureId, x: 960, y: 200 },
      signal,
      settings,
    )) as { ok: boolean }
    expect(ok.ok).toBe(true)
    expect(addon.mouseClick).toHaveBeenCalled()
    await driver.dispose()
  })

  it('原生异步接口优先并行执行，且当原生防自锁门禁返回 false 时严格抛错不误报成功', async () => {
    const windowsRef = {
      current: [
        {
          windowId: 77,
          pid: 4040,
          appName: 'Safari',
          bundleId: 'com.apple.Safari',
          title: 'Safari',
          bounds: { x: 100, y: 80, width: 800, height: 600 },
          layer: 0,
          isFrontmost: false,
        },
      ],
    }
    const { addon, settings, driver } = createFixture(windowsRef)
    addon.captureWindowPngAsync = vi.fn(async () => ({
      png: TINY_PNG,
      bounds: windowsRef.current[0]!.bounds,
    }))
    addon.getUiTreeAsync = vi.fn(async () => [
      {
        role: 'AXButton',
        title: '提交',
        value: '',
        editable: false,
        pressable: true,
        bounds: { x: 200, y: 180, width: 80, height: 32 },
      },
    ])
    addon.axPressAtAsync = vi.fn(async () => false)
    addon.mouseClickAsync = vi.fn(async () => false)
    addon.keyTapAsync = vi.fn(async () => false)

    const signal = AbortSignal.timeout(5_000)
    const shot = (await driver.call('screenshot', { windowId: 77 }, signal, settings)) as {
      captureId: string
      captureMethod: string
      elementsCount: number
    }
    expect(shot.captureMethod).toBe(
      process.platform === 'win32' ? 'win32-printwindow' : 'screencapturekit',
    )
    expect(shot.elementsCount).toBe(1)
    expect(addon.captureWindowPngAsync).toHaveBeenCalledOnce()
    expect(addon.getUiTreeAsync).toHaveBeenCalledOnce()
    expect(addon.captureWindowPng).not.toHaveBeenCalled()
    expect(addon.getUiTree).not.toHaveBeenCalled()

    await expect(
      driver.call('click', { captureId: shot.captureId, ref: '@u1' }, signal, settings),
    ).rejects.toThrow('SELF_LOCK_GUARD')
    await expect(driver.call('key', { key: 'Enter' }, signal, settings)).rejects.toThrow(
      'SELF_LOCK_GUARD',
    )
    await expect(driver.call('type', { text: 'hello' }, signal, settings)).rejects.toThrow(
      'SELF_LOCK_GUARD',
    )
    await driver.dispose()
  })

  it('拦截拖拽终点落入屏蔽应用、窗口范围键盘越界，并在 dispose 后拒绝新调用', async () => {
    const windowsRef = {
      current: [
        {
          windowId: 1,
          pid: 9999,
          appName: 'MyDSH',
          bundleId: 'com.mydsh.desktop',
          title: 'MyDSH',
          bounds: { x: 0, y: 0, width: 600, height: 800 },
          layer: 0,
          isFrontmost: true,
        },
        {
          windowId: 88,
          pid: 3000,
          appName: 'Google Chrome',
          bundleId: 'com.google.Chrome',
          title: 'Chrome',
          bounds: { x: 640, y: 0, width: 800, height: 800 },
          layer: 0,
          isFrontmost: false,
        },
      ],
    }
    electronMocks.getSources.mockResolvedValue([
      { id: 'screen:1:0', display_id: '1', thumbnail: makeImageStub(1440, 900) },
    ])
    const { settings, driver } = createFixture(windowsRef)
    const signal = AbortSignal.timeout(5_000)
    const shot = (await driver.call('screenshot', {}, signal, settings)) as { captureId: string }

    // 起点在 Chrome（图像 x=960 -> 屏幕 1080），终点落入 MyDSH（图像 x=160 -> 屏幕 180），必须被安全拦截
    await expect(
      driver.call(
        'drag',
        { captureId: shot.captureId, fromX: 960, fromY: 200, toX: 160, toY: 200 },
        signal,
        settings,
      ),
    ).rejects.toThrow('防自锁保护')

    // window 范围下若尚未指定目标窗口，禁止回退到任意前台窗口发送按键
    const windowSettings: AutomationSettings = {
      ...settings,
      computerUse: { ...settings.computerUse, scope: 'window' },
    }
    await expect(driver.call('key', { key: 'Enter' }, signal, windowSettings)).rejects.toThrow(
      '仅单窗口',
    )

    // dispose 后立即拒绝新请求
    await driver.dispose()
    await expect(driver.call('status', {}, signal, settings)).rejects.toThrow('已释放')
  })
})
