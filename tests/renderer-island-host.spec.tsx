// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UiRuntimeContext } from '../src/renderer/src/plugins/react.tsx'
import { UiRuntime } from '../src/renderer/src/plugins/registry.ts'

const fixture = vi.hoisted(() => ({
  snapshot: {
    activeView: 'fixture.mode',
    activeRightIslandId: 'fixture.dynamic',
    rightIslandsInitialized: true,
    selectedSessionId: '会话-1',
    selectedProjectId: '项目-1',
    informationCollapsed: false,
  },
  initializeRightIsland: vi.fn(),
  selectRightIsland: vi.fn(),
  toggleInformation: vi.fn(),
}))

vi.mock('../src/renderer/src/hooks/useWorkspace.ts', () => ({
  useWorkspaceSnapshot: () => fixture.snapshot,
  useWorkspaceStore: () => ({
    initializeRightIsland: fixture.initializeRightIsland,
    selectRightIsland: fixture.selectRightIsland,
    toggleInformation: fixture.toggleInformation,
  }),
}))

vi.mock('../src/renderer/src/features/workspace-tabs/useWorkTabs.ts', () => ({
  useWorkTabs: () => [],
}))
vi.mock('../src/renderer/src/features/workspace-tabs/WorkTabPanels.tsx', () => ({
  WorkTabPanels: () => null,
}))

import { MainPanel } from '../src/renderer/src/pages/workspace/components/mainpanel/index.tsx'

const Icon = () => null

describe('动态浮岛宿主', () => {
  afterEach(() => {
    fixture.initializeRightIsland.mockReset()
    fixture.selectRightIsland.mockReset()
    fixture.toggleInformation.mockReset()
  })

  it('临时文档只按上下文呈现，不成为工具栏入口或默认栏目', async () => {
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }))
    const runtime = new UiRuntime()
    await runtime.install('fixture.contextual', {
      apply(ctx) {
        ctx.mydshSlots.registerIsland({
          id: 'fixture.main',
          label: '对话',
          icon: Icon,
          component: () => <p>当前对话</p>,
          placements: ['main'],
          scope: 'session',
        })
        ctx.mydshSlots.registerIsland({
          id: 'fixture.fallback',
          label: '会话信息',
          icon: Icon,
          component: () => <p>原来的会话信息</p>,
          placements: ['right'],
          scope: 'session',
        })
        ctx.mydshSlots.registerIsland({
          id: 'fixture.plan',
          label: '计划全文',
          icon: Icon,
          contextual: true,
          order: -1,
          component: () => <p>当前计划正文</p>,
          placements: ['right'],
          scope: 'session',
        })
        ctx.mydshSlots.registerMode({
          id: 'fixture.mode',
          label: '对话',
          icon: Icon,
          mainIslandId: 'fixture.main',
          defaultRightIslandId: 'fixture.plan',
        })
      },
    })
    const view = render(
      <UiRuntimeContext.Provider value={runtime}>
        <MainPanel />
      </UiRuntimeContext.Provider>,
    )
    try {
      expect(screen.getByText('原来的会话信息')).toBeTruthy()
      expect(screen.queryByText('当前计划正文')).toBeNull()
      expect(
        document.querySelector('[data-tab-id="fixture.plan"], [data-island-id="fixture.plan"]'),
      ).toBeNull()
      fixture.snapshot.activeRightIslandId = 'fixture.plan'
      view.rerender(
        <UiRuntimeContext.Provider value={runtime}>
          <MainPanel />
        </UiRuntimeContext.Provider>,
      )
      expect(screen.getByText('当前计划正文')).toBeTruthy()
      expect(screen.queryByRole('tablist', { name: '右侧栏目' })).toBeNull()
      fixture.snapshot.activeRightIslandId = 'fixture.fallback'
      view.rerender(
        <UiRuntimeContext.Provider value={runtime}>
          <MainPanel />
        </UiRuntimeContext.Provider>,
      )
      expect(screen.getByText('原来的会话信息')).toBeTruthy()
      expect(screen.getByRole('tablist', { name: '右侧栏目' })).toBeTruthy()
    } finally {
      view.unmount()
      fixture.snapshot.activeRightIslandId = 'fixture.dynamic'
      vi.unstubAllGlobals()
      await runtime.dispose()
    }
  })

  it('隔离贡献渲染错误，并在卸载或同名错误位置复用后回退到可用右侧浮岛', async () => {
    let updateMedia: (() => void) | undefined
    const media = {
      matches: false,
      addEventListener: (_type: string, listener: () => void) => {
        updateMedia = listener
      },
      removeEventListener: vi.fn(),
    }
    vi.stubGlobal('matchMedia', () => media)
    const runtime = new UiRuntime()
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    await runtime.install('fixture.shell', {
      apply(ctx) {
        ctx.mydshSlots.registerIsland({
          id: 'fixture.main',
          label: '固定中央',
          icon: Icon,
          component: () => <p>中央仍可使用</p>,
          placements: ['main', 'right'],
          scope: 'session',
        })
        ctx.mydshSlots.registerIsland({
          id: 'fixture.fallback',
          label: '备用右侧',
          icon: Icon,
          component: () => <p>备用内容</p>,
          placements: ['right'],
          scope: 'session',
        })
        ctx.mydshSlots.registerMode({
          id: 'fixture.mode',
          label: '测试模式',
          icon: Icon,
          mainIslandId: 'fixture.main',
          defaultRightIslandId: 'fixture.fallback',
        })
      },
    })
    await runtime.install('fixture.extension', {
      apply(ctx) {
        ctx.mydshSlots.registerIsland({
          id: 'fixture.dynamic',
          label: '动态浮岛',
          icon: Icon,
          component: () => {
            throw new Error('扩展视图损坏')
          },
          placements: ['right'],
          scope: 'session',
        })
      },
    })

    const view = render(
      <UiRuntimeContext.Provider value={runtime}>
        <MainPanel />
      </UiRuntimeContext.Provider>,
    )
    try {
      expect(screen.getByText('中央仍可使用')).toBeTruthy()
      expect(screen.getByRole('alert').textContent).toContain('动态浮岛暂时不可用')
      expect(screen.getAllByRole('tablist', { name: '右侧栏目' })).toHaveLength(1)
      expect(screen.queryByRole('tab', { name: '固定中央' })).toBeNull()
      expect(screen.getByRole('tab', { name: '动态浮岛' }).getAttribute('aria-selected')).toBe(
        'true',
      )
      expect(screen.getByRole('tab', { name: '动态浮岛' }).textContent).toBe('')
      expect(screen.queryByRole('tab', { name: '备用右侧' })).toBeNull()
      fireEvent.click(screen.getByRole('tab', { name: '动态浮岛' }))
      expect(fixture.toggleInformation).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole('button', { name: '收起右侧栏目' }))
      expect(fixture.toggleInformation).toHaveBeenCalledOnce()
      fireEvent.click(screen.getByRole('button', { name: '更多右侧栏目' }))
      expect(screen.queryByRole('menuitem', { name: '固定中央' })).toBeNull()
      fireEvent.click(screen.getByRole('menuitem', { name: '备用右侧' }))
      expect(fixture.selectRightIsland).toHaveBeenCalledWith('fixture.fallback')
      expect(screen.queryByRole('menu')).toBeNull()

      await act(async () => {
        await runtime.uninstall('fixture.extension')
      })
      await waitFor(() => {
        expect(screen.getByText('备用内容')).toBeTruthy()
      })
      expect(screen.getAllByRole('tablist', { name: '右侧栏目' })).toHaveLength(1)

      await act(async () => {
        await runtime.install('fixture.reused-id', {
          apply(ctx) {
            ctx.mydshSlots.registerIsland({
              id: 'fixture.dynamic',
              label: '同名主区浮岛',
              icon: Icon,
              component: () => <p>不应出现在右侧</p>,
              placements: ['main'],
              scope: 'session',
            })
          },
        })
      })
      await waitFor(() => {
        expect(screen.getByText('备用内容')).toBeTruthy()
      })
      expect(screen.queryByText('不应出现在右侧')).toBeNull()
      expect(screen.getByText('中央仍可使用')).toBeTruthy()
      const rightContent = screen.getByText('备用内容')
      fixture.snapshot.informationCollapsed = true
      view.rerender(
        <UiRuntimeContext.Provider value={runtime}>
          <MainPanel />
        </UiRuntimeContext.Provider>,
      )
      expect(document.querySelector('.info-island')?.hasAttribute('inert')).toBe(true)
      act(() => {
        media.matches = true
        updateMedia?.()
      })
      expect(document.querySelector('.info-island')?.hasAttribute('inert')).toBe(true)
      expect(document.querySelector('.info-island')?.hasAttribute('hidden')).toBe(true)
      fixture.snapshot.informationCollapsed = false
      view.rerender(
        <UiRuntimeContext.Provider value={runtime}>
          <MainPanel />
        </UiRuntimeContext.Provider>,
      )
      expect(document.querySelector('.info-island')?.hasAttribute('hidden')).toBe(true)
      act(() => {
        media.matches = false
        updateMedia?.()
      })
      expect(document.querySelector('.info-island')?.hasAttribute('hidden')).toBe(false)
      expect(document.querySelector('.info-island')?.hasAttribute('inert')).toBe(false)
      expect(screen.getByText('备用内容')).toBe(rightContent)
    } finally {
      view.unmount()
      expect(media.removeEventListener).toHaveBeenCalled()
      fixture.snapshot.informationCollapsed = false
      vi.unstubAllGlobals()
      errorLog.mockRestore()
      await runtime.dispose()
    }
  })
})
