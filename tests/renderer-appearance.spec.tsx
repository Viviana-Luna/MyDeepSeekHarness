/**
 * renderer 外观系统与外观设置页单元测试：覆盖默认 12px 派生变量、固定默认通透度/间隙/无背景图投影、
 * 历史字段兼容以及步进字号输入框、Ant Design Switch 与主题色交互。
 */
// @vitest-environment jsdom

import { Provider } from '@umijs/max'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DESKTOP_FONT_SIZE_RANGE, DESKTOP_ISLAND_GAP_RANGE } from '../src/shared/appearance.ts'
import { DESKTOP_WINDOW_CORNER_RADIUS } from '../src/shared/window.ts'
import {
  AppearanceSystem,
  FONT_PRESETS,
  accentContrastColor,
  applyAppearance,
} from '../src/renderer/src/features/appearance/appearance-system.tsx'
import { AppearanceSettings } from '../src/renderer/src/features/settings/AppearanceSettings.tsx'
import useWorkspaceModel from '../src/renderer/src/models/workspace.ts'
import type {
  DesktopBridge,
  DesktopFontFamily,
  DesktopSettings,
} from '../src/renderer/src/platform/contracts.ts'

function settings(patch: Partial<DesktopSettings> = {}): DesktopSettings {
  return {
    version: 7,
    revision: 0,
    colorScheme: 'system',
    canvasColorScheme: 'follow-interface',
    fontFamily: 'system',
    fontSize: DESKTOP_FONT_SIZE_RANGE.default,
    editorFontSize: 13,
    editorLineHeight: 'standard',
    editorLigatures: false,
    islandGap: DESKTOP_ISLAND_GAP_RANGE.default,
    accentColor: '#4d6bfe',
    canvasTransparency: 0.32,
    contentScrimOpacity: 0.82,
    backgrounds: { canvas: null, sidebar: null, content: null },
    ...patch,
  }
}

function createAppearanceBridge(initial: DesktopSettings = settings()): {
  readonly bridge: DesktopBridge
  readonly updateMock: ReturnType<typeof vi.fn<DesktopBridge['settings']['update']>>
} {
  let current = initial
  const updateMock = vi.fn<DesktopBridge['settings']['update']>(async patch => {
    current = { ...current, ...patch, revision: current.revision + 1 }
    return current
  })
  const bridge: DesktopBridge = {
    version: 11,
    remote: {
      call: async () => {
        throw new Error('外观测试不调用扩展 Remote')
      },
      cancelCall: async () => {},
      follow: () => () => {},
    },
    setPluginBusyReasons: async () => {},
    getFrontendPlugins: async () => [],
    onFrontendPluginsChanged: () => () => undefined,
    host: {
      status: async () => ({ kind: 'unavailable', message: '外观测试不依赖运行核心' }),
      call: async operation => {
        if (operation === 'listSessions') return { items: [] }
        throw new Error(`外观测试未处理 Host 操作：${operation}`)
      },
      onStatusChanged: () => () => undefined,
      onSessionFrame: () => () => undefined,
      onHostFrame: () => () => undefined,
    },
    settings: {
      read: async () => current,
      update: updateMock,
      chooseBackground: async () => null,
      applyBackground: async () => current,
      cancelBackground: async () => undefined,
      clearBackground: async () => current,
      onChanged: () => () => undefined,
      onOpenRequested: () => () => undefined,
    },
  }
  return { bridge, updateMock }
}

async function renderAppearanceSettings(initial: DesktopSettings = settings()) {
  const { bridge, updateMock } = createAppearanceBridge(initial)
  window.dshDesktop = bridge
  render(
    <Provider models={{ workspace: useWorkspaceModel }}>
      <AppearanceSystem>
        <AppearanceSettings />
      </AppearanceSystem>
    </Provider>,
  )
  await screen.findByRole('spinbutton', { name: '界面字号' })
  return { updateMock }
}

beforeEach(() => {
  window.localStorage.clear()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(prefers-reduced-motion: reduce)',
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
  }))
})

afterEach(() => {
  cleanup()
  delete window.dshDesktop
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.documentElement.removeAttribute('data-theme-mode')
  document.documentElement.removeAttribute('data-color-scheme')
  document.documentElement.removeAttribute('data-canvas-color-scheme')
  document.documentElement.removeAttribute('style')
})

describe('renderer 外观系统', () => {
  it('界面字号默认基线为 12px，并与 tokens.css 初始字号变量一致', () => {
    expect(DESKTOP_FONT_SIZE_RANGE).toEqual({ minimum: 11, maximum: 18, default: 12 })
    const stylesheet = readFileSync('src/renderer/src/styles/tokens.css', 'utf8')
    expect(stylesheet).toContain('--text-caption: 11px;')
    expect(stylesheet).toContain('--text-meta: 12px;')
    expect(stylesheet).toContain('--text-control: 12px;')
    expect(stylesheet).toContain('--text-body: 12px;')
    expect(stylesheet).toContain('--text-title: 13px;')
    expect(stylesheet).toContain('--text-brand: 14px;')
  })

  it('应用三个字体预设', () => {
    const fontFamilies = [
      'system',
      'humanist',
      'monospace',
    ] as const satisfies readonly DesktopFontFamily[]
    for (const fontFamily of fontFamilies) {
      applyAppearance(settings({ fontFamily }))
      expect(document.documentElement.style.getPropertyValue('--font-ui')).toBe(
        FONT_PRESETS[fontFamily].cssValue,
      )
    }
  })

  it('从正文字号派生完整界面字号变量', () => {
    applyAppearance(settings({ fontSize: 11 }))
    expect(document.documentElement.style.getPropertyValue('--text-caption')).toBe('11px')
    expect(document.documentElement.style.getPropertyValue('--text-meta')).toBe('12px')
    expect(document.documentElement.style.getPropertyValue('--text-control')).toBe('12px')
    expect(document.documentElement.style.getPropertyValue('--text-body')).toBe('11px')
    expect(document.documentElement.style.getPropertyValue('--text-title')).toBe('12px')
    expect(document.documentElement.style.getPropertyValue('--text-brand')).toBe('13px')

    applyAppearance(settings({ fontSize: 12 }))
    expect(document.documentElement.style.getPropertyValue('--text-caption')).toBe('11px')
    expect(document.documentElement.style.getPropertyValue('--text-meta')).toBe('12px')
    expect(document.documentElement.style.getPropertyValue('--text-control')).toBe('12px')
    expect(document.documentElement.style.getPropertyValue('--text-body')).toBe('12px')
    expect(document.documentElement.style.getPropertyValue('--text-title')).toBe('13px')
    expect(document.documentElement.style.getPropertyValue('--text-brand')).toBe('14px')

    applyAppearance(settings({ fontSize: 14 }))
    expect(document.documentElement.style.getPropertyValue('--text-caption')).toBe('11px')
    expect(document.documentElement.style.getPropertyValue('--text-meta')).toBe('12px')
    expect(document.documentElement.style.getPropertyValue('--text-control')).toBe('13px')
    expect(document.documentElement.style.getPropertyValue('--text-body')).toBe('14px')
    expect(document.documentElement.style.getPropertyValue('--text-title')).toBe('15px')
    expect(document.documentElement.style.getPropertyValue('--text-brand')).toBe('16px')

    applyAppearance(settings({ fontSize: 18 }))
    expect(document.documentElement.style.getPropertyValue('--text-caption')).toBe('15px')
    expect(document.documentElement.style.getPropertyValue('--text-brand')).toBe('20px')
  })

  it('清除旧版代码排版覆盖，代码区域使用内置样式', () => {
    const root = document.documentElement
    root.style.setProperty('--code-editor-font-size', '18px')
    root.style.setProperty('--code-editor-line-height', '1.7')
    root.style.setProperty('--code-editor-font-ligatures', 'normal')
    applyAppearance(
      settings({ editorFontSize: 18, editorLineHeight: 'relaxed', editorLigatures: true }),
    )
    expect(root.style.getPropertyValue('--code-editor-font-size')).toBe('')
    expect(root.style.getPropertyValue('--code-editor-line-height')).toBe('')
    expect(root.style.getPropertyValue('--code-editor-font-ligatures')).toBe('')
    expect(root.style.getPropertyValue('--text-body')).toBe('12px')

    applyAppearance(
      settings({ editorFontSize: 11, editorLineHeight: 'compact', editorLigatures: false }),
    )
    expect(root.style.getPropertyValue('--code-editor-font-size')).toBe('')
    expect(root.style.getPropertyValue('--code-editor-line-height')).toBe('')
    expect(root.style.getPropertyValue('--code-editor-font-ligatures')).toBe('')
  })

  it('浮岛间隙固定按官方默认值 8px 投影，忽略历史脏配置', () => {
    const expectedGap = `${String(DESKTOP_ISLAND_GAP_RANGE.default)}px`
    applyAppearance(settings({ islandGap: 5 }))
    expect(document.documentElement.style.getPropertyValue('--window-gap')).toBe(expectedGap)
    expect(document.documentElement.style.getPropertyValue('--window-edge')).toBe(expectedGap)

    applyAppearance(settings({ islandGap: 20 }))
    expect(document.documentElement.style.getPropertyValue('--window-gap')).toBe(expectedGap)
    expect(document.documentElement.style.getPropertyValue('--window-edge')).toBe(expectedGap)
  })

  it('浮岛圆角由窗口外角减去边距，且不会小于零', () => {
    const stylesheet = readFileSync('src/renderer/src/styles/tokens.css', 'utf8')
    expect(stylesheet).toContain(
      `--island-radius: max(0px, calc(var(--window-outer-radius, ${DESKTOP_WINDOW_CORNER_RADIUS}px) - var(--window-edge)));`,
    )
  })

  it('画布通透度、遮罩、画布配色与背景图固定为官方默认值且兼容读取历史配置', () => {
    applyAppearance(
      settings({
        accentColor: '#c45a84',
        canvasColorScheme: 'light',
        canvasTransparency: 1,
        contentScrimOpacity: 0.15,
        backgrounds: {
          canvas: 'data:image/png;base64,Y2FudmFz',
          sidebar: 'data:image/png;base64,c2lkZWJhcg==',
          content: 'data:image/png;base64,Y29udGVudA==',
        },
      }),
    )
    const root = document.documentElement
    expect(root.dataset.themeMode).toBeUndefined()
    expect(root.dataset.canvasColorScheme).toBe('follow-interface')
    expect(root.style.getPropertyValue('--accent')).toBe('#c45a84')
    expect(root.style.getPropertyValue('--accent-contrast')).toBe(accentContrastColor('#c45a84'))
    expect(root.style.getPropertyValue('--canvas-alpha')).toBe('0.68')
    expect(root.style.getPropertyValue('--canvas-layer-bg')).toBe('var(--canvas-bg)')
    expect(root.style.getPropertyValue('--scrim-alpha')).toBe('0.84')
    expect(root.style.getPropertyValue('--island-alpha')).toBe('')
    expect(root.style.getPropertyValue('--content-alpha')).toBe('')
    expect(root.style.getPropertyValue('--canvas-image')).toBe('none')
    expect(root.style.getPropertyValue('--sidebar-image')).toBe('none')
    expect(root.style.getPropertyValue('--content-image')).toBe('none')

    applyAppearance(
      settings({ colorScheme: 'light', canvasColorScheme: 'dark', canvasTransparency: 0 }),
    )
    expect(root.dataset.canvasColorScheme).toBe('follow-interface')
    expect(root.style.getPropertyValue('--canvas-layer-bg')).toBe('var(--canvas-bg)')
    expect(root.style.getPropertyValue('--canvas-alpha')).toBe('0.68')
  })

  it('分别应用跟随系统、浅色和深色配色', () => {
    const root = document.documentElement

    applyAppearance(settings({ colorScheme: 'system' }))
    expect(root.dataset.colorScheme).toBe('system')
    expect(root.style.colorScheme).toBe('dark light')

    applyAppearance(settings({ colorScheme: 'light' }))
    expect(root.dataset.colorScheme).toBe('light')
    expect(root.style.colorScheme).toBe('light')

    applyAppearance(settings({ colorScheme: 'dark' }))
    expect(root.dataset.colorScheme).toBe('dark')
    expect(root.style.colorScheme).toBe('dark')
  })

  it('为任意主题色选择对比度更高的按钮前景', () => {
    expect(accentContrastColor('#ffffff')).toBe('#000000')
    expect(accentContrastColor('#000000')).toBe('#ffffff')
    for (const accentColor of ['#4d6bfe', '#2d8dbd', '#2f9d77', '#d97745', '#c45a84', '#8069d4']) {
      applyAppearance(settings({ accentColor }))
      expect(document.documentElement.style.getPropertyValue('--accent-contrast')).toBe(
        accentContrastColor(accentColor),
      )
    }
  })
})

describe('AppearanceSettings 外观设置页', () => {
  it('移除背景图片、背景与可读性及浮岛间隙，且不再使用 range 滑块', async () => {
    await renderAppearanceSettings()
    expect(screen.queryAllByRole('slider')).toHaveLength(0)
    expect(screen.queryByText('背景图片')).toBeNull()
    expect(screen.queryByText('背景与可读性')).toBeNull()
    expect(screen.queryByText('浮岛间隙')).toBeNull()
    expect(screen.queryByText('画布配色')).toBeNull()
    expect(screen.queryByText('画布透明度')).toBeNull()
    expect(screen.queryByText('内容可读性遮罩')).toBeNull()
    expect(screen.getByRole('spinbutton', { name: '界面字号' })).toBeTruthy()
    expect(screen.getByRole('switch', { name: '缩放胶囊常驻' })).toBeTruthy()
    expect(screen.getByRole('radiogroup', { name: '主题色' })).toBeTruthy()
    expect(screen.getByText('#4D6BFE')).toBeTruthy()
  })

  it('步进字号输入框支持按钮加减、直接键入、键盘调节、越界夹紧与非法回退', async () => {
    const { updateMock } = await renderAppearanceSettings(settings({ fontSize: 12 }))
    const input = screen.getByRole<HTMLInputElement>('spinbutton', { name: '界面字号' })
    const decrease = screen.getByRole<HTMLButtonElement>('button', { name: '减小界面字号' })
    const increase = screen.getByRole<HTMLButtonElement>('button', { name: '增大界面字号' })

    expect(input.value).toBe('12')
    expect(decrease.disabled).toBe(false)
    expect(increase.disabled).toBe(false)

    // 减到下界 11 后减号按钮禁用。
    fireEvent.click(decrease)
    await waitFor(() => {
      expect(updateMock).toHaveBeenLastCalledWith({ fontSize: 11 })
      expect(input.value).toBe('11')
      expect(decrease.disabled).toBe(true)
    })

    // 键入超大值并回车自动夹紧到上界 18，加号按钮禁用。
    fireEvent.change(input, { target: { value: '28' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => {
      expect(updateMock).toHaveBeenLastCalledWith({ fontSize: 18 })
      expect(input.value).toBe('18')
      expect(increase.disabled).toBe(true)
    })
    const callsAfterEnter = updateMock.mock.calls.length
    fireEvent.blur(input)
    expect(updateMock).toHaveBeenCalledTimes(callsAfterEnter)

    // 键入小于下界的值并失焦自动夹紧到 11。
    fireEvent.change(input, { target: { value: '4' } })
    fireEvent.blur(input)
    await waitFor(() => {
      expect(updateMock).toHaveBeenLastCalledWith({ fontSize: 11 })
      expect(input.value).toBe('11')
    })

    // 键入非法字符后失焦安全恢复当前值，不发送更新。
    const callsBeforeInvalid = updateMock.mock.calls.length
    fireEvent.change(input, { target: { value: 'abc' } })
    fireEvent.blur(input)
    expect(input.value).toBe('11')
    expect(updateMock).toHaveBeenCalledTimes(callsBeforeInvalid)

    // 上下方向键即时步进，Escape 撤销未提交草稿。
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    await waitFor(() => {
      expect(updateMock).toHaveBeenLastCalledWith({ fontSize: 12 })
      expect(input.value).toBe('12')
    })
    fireEvent.change(input, { target: { value: '16' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(input.value).toBe('12')
    fireEvent.keyDown(input, { key: 'End' })
    await waitFor(() => {
      expect(updateMock).toHaveBeenLastCalledWith({ fontSize: 18 })
      expect(input.value).toBe('18')
    })
    fireEvent.keyDown(input, { key: 'Home' })
    await waitFor(() => {
      expect(updateMock).toHaveBeenLastCalledWith({ fontSize: 11 })
      expect(input.value).toBe('11')
    })
  })

  it('缩放胶囊常驻使用 Ant Design Switch，主题色更新当前色值胶囊与选中态', async () => {
    const { updateMock } = await renderAppearanceSettings(settings({ accentColor: '#4d6bfe' }))
    const capsuleSwitch = screen.getByRole('switch', { name: '缩放胶囊常驻' })
    expect(capsuleSwitch.className).toContain('ant-switch')
    expect(capsuleSwitch.getAttribute('aria-checked')).toBe('false')

    fireEvent.click(capsuleSwitch)
    await waitFor(() => {
      expect(capsuleSwitch.getAttribute('aria-checked')).toBe('true')
    })

    const pineSwatch = screen.getByRole('radio', { name: '松绿' })
    fireEvent.click(pineSwatch)
    await waitFor(() => {
      expect(updateMock).toHaveBeenLastCalledWith({ accentColor: '#2f9d77' })
      expect(pineSwatch.getAttribute('aria-checked')).toBe('true')
      expect(screen.getByText('#2F9D77')).toBeTruthy()
    })
  })
})
