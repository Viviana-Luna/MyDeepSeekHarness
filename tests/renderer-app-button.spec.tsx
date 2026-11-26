/**
 * 全平台统一按钮组件与主题按钮配置测试：覆盖 AppButton 语义变体、胶囊形状、属性/ref 透传、
 * ElasticPress 开关，以及 AppearanceSystem 关闭中文双字按钮自动插空格行为。
 */
// @vitest-environment jsdom

import { Provider } from '@umijs/max'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Button } from 'antd'
import { readFileSync } from 'node:fs'
import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DESKTOP_FONT_SIZE_RANGE, DESKTOP_ISLAND_GAP_RANGE } from '../src/shared/appearance.ts'
import { AppearanceSystem } from '../src/renderer/src/features/appearance/appearance-system.tsx'
import useWorkspaceModel from '../src/renderer/src/models/workspace.ts'
import type { DesktopBridge, DesktopSettings } from '../src/renderer/src/platform/contracts.ts'
import { AppButton, type AppButtonVariant } from '../src/renderer/src/shared/ui/AppButton.tsx'

function createDefaultSettings(): DesktopSettings {
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
  }
}

function installDesktopBridge(): void {
  const current = createDefaultSettings()
  const bridge: DesktopBridge = {
    version: 11,
    remote: {
      call: async () => {
        throw new Error('按钮测试不调用扩展 Remote')
      },
      cancelCall: async () => {},
      follow: () => () => {},
    },
    setPluginBusyReasons: async () => {},
    getFrontendPlugins: async () => [],
    onFrontendPluginsChanged: () => () => undefined,
    host: {
      status: async () => ({ kind: 'unavailable', message: '按钮测试不依赖运行核心' }),
      call: async operation => {
        if (operation === 'listSessions') return { items: [] }
        throw new Error(`按钮测试未处理 Host 操作：${operation}`)
      },
      onStatusChanged: () => () => undefined,
      onSessionFrame: () => () => undefined,
      onHostFrame: () => () => undefined,
    },
    settings: {
      read: async () => current,
      update: async () => current,
      chooseBackground: async () => null,
      applyBackground: async () => current,
      cancelBackground: async () => undefined,
      clearBackground: async () => current,
      onChanged: () => () => undefined,
      onOpenRequested: () => () => undefined,
    },
  }
  window.dshDesktop = bridge
}

beforeEach(() => {
  window.localStorage.clear()
  installDesktopBridge()
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
  document.documentElement.removeAttribute('data-color-scheme')
  document.documentElement.removeAttribute('data-canvas-color-scheme')
  document.documentElement.removeAttribute('style')
})

describe('AppButton 与统一按钮样式体系', () => {
  it('按语义变体映射 Ant Design 按钮类名、变体标记与胶囊形状', () => {
    const cases: readonly {
      readonly variant: AppButtonVariant
      readonly label: string
      readonly expectedClasses: readonly string[]
    }[] = [
      {
        variant: 'default',
        label: '恢复',
        expectedClasses: [
          'mydsh-btn--default',
          'ant-btn-color-default',
          'ant-btn-variant-outlined',
        ],
      },
      {
        variant: 'primary',
        label: '创建提供方',
        expectedClasses: ['mydsh-btn--primary', 'ant-btn-color-primary', 'ant-btn-variant-solid'],
      },
      {
        variant: 'danger',
        label: '永久删除',
        expectedClasses: [
          'mydsh-btn--danger',
          'ant-btn-dangerous',
          'ant-btn-color-dangerous',
          'ant-btn-variant-outlined',
        ],
      },
      {
        variant: 'danger-solid',
        label: '确认删除',
        expectedClasses: [
          'mydsh-btn--danger-solid',
          'ant-btn-dangerous',
          'ant-btn-color-dangerous',
          'ant-btn-variant-solid',
        ],
      },
      {
        variant: 'ghost',
        label: '透明操作',
        expectedClasses: ['mydsh-btn--ghost', 'ant-btn-background-ghost'],
      },
      {
        variant: 'text',
        label: '取消选择',
        expectedClasses: ['mydsh-btn--text', 'ant-btn-variant-text'],
      },
    ]

    render(
      <Provider models={{ workspace: useWorkspaceModel }}>
        <AppearanceSystem>
          {cases.map(item => (
            <AppButton key={item.variant} variant={item.variant}>
              {item.label}
            </AppButton>
          ))}
          <AppButton variant="primary" pill>
            胶囊按钮
          </AppButton>
        </AppearanceSystem>
      </Provider>,
    )

    for (const item of cases) {
      const button = screen.getByRole('button', { name: item.label })
      expect(button.dataset.mydshVariant).toBe(item.variant)
      expect(button.classList.contains('mydsh-btn')).toBe(true)
      for (const expectedClass of item.expectedClasses) {
        expect(button.classList.contains(expectedClass)).toBe(true)
      }
    }

    const pillButton = screen.getByRole('button', { name: '胶囊按钮' })
    expect(pillButton.classList.contains('mydsh-btn--pill')).toBe(true)
    expect(pillButton.classList.contains('ant-btn-round')).toBe(true)
  })

  it('默认启用弹性按压管理并支持关闭，同时透传点击事件、禁用态与 ref', () => {
    const onElasticClick = vi.fn()
    const onStaticClick = vi.fn()
    const elasticRef = createRef<HTMLButtonElement>()
    const staticRef = createRef<HTMLButtonElement>()

    render(
      <Provider models={{ workspace: useWorkspaceModel }}>
        <AppearanceSystem>
          <AppButton ref={elasticRef} onClick={onElasticClick} aria-describedby="tip">
            弹性按钮
          </AppButton>
          <AppButton ref={staticRef} elastic={false} onClick={onStaticClick}>
            静态按钮
          </AppButton>
          <AppButton disabled>禁用按钮</AppButton>
        </AppearanceSystem>
      </Provider>,
    )

    const elasticButton = screen.getByRole<HTMLButtonElement>('button', { name: '弹性按钮' })
    const staticButton = screen.getByRole<HTMLButtonElement>('button', { name: '静态按钮' })
    const disabledButton = screen.getByRole<HTMLButtonElement>('button', { name: '禁用按钮' })

    expect(elasticRef.current).toBe(elasticButton)
    expect(staticRef.current).toBe(staticButton)
    expect(elasticButton.dataset.elasticManaged).toBe('true')
    expect(elasticButton.getAttribute('aria-describedby')).toBe('tip')
    expect(staticButton.dataset.elasticManaged).toBeUndefined()
    expect(staticButton.dataset.noElasticPress).toBe('true')
    expect(disabledButton.disabled).toBe(true)

    fireEvent.click(elasticButton)
    fireEvent.click(staticButton)
    expect(onElasticClick).toHaveBeenCalledTimes(1)
    expect(onStaticClick).toHaveBeenCalledTimes(1)
  })

  it('AppearanceSystem 的 ConfigProvider 关闭中文双字按钮自动插空格', () => {
    render(
      <Provider models={{ workspace: useWorkspaceModel }}>
        <AppearanceSystem>
          <Button>取消</Button>
          <Button type="primary">保存</Button>
          <AppButton variant="danger">删除</AppButton>
        </AppearanceSystem>
      </Provider>,
    )

    for (const label of ['取消', '保存', '删除']) {
      const button = screen.getByRole('button', { name: label })
      expect(button.textContent).toBe(label)
      expect(button.classList.contains('ant-btn-two-chinese-chars')).toBe(false)
    }
  })

  it('buttons.css 在全局入口引入并向发送按钮提供同源嵌压令牌', () => {
    const globalCss = readFileSync('src/renderer/src/global.css', 'utf8')
    const buttonsCss = readFileSync('src/renderer/src/styles/buttons.css', 'utf8')
    const componentsCss = readFileSync('src/renderer/src/styles/components.css', 'utf8')

    expect(globalCss).toContain("@import './styles/buttons.css';")
    expect(buttonsCss).toContain('--relief-recessed:')
    expect(buttonsCss).toContain('--mydsh-btn-shadow: var(--relief-recessed);')
    expect(buttonsCss).toContain('@media (forced-colors: active)')
    expect(buttonsCss).toContain('@media (prefers-reduced-motion: reduce)')
    expect(componentsCss).toContain('box-shadow: var(--mydsh-btn-shadow);')
    expect(componentsCss).toContain('background: var(--mydsh-btn-primary-face);')
  })
})
