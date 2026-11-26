// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const terminalMock = vi.hoisted(() => ({
  instances: [] as Array<{
    write: ReturnType<typeof vi.fn>
    focus: ReturnType<typeof vi.fn>
    clear: ReturnType<typeof vi.fn>
    hasSelection(): boolean
    emitData(data: string): void
  }>,
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = vi.fn()
  },
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    options: Record<string, unknown> = {}
    write = vi.fn()
    focus = vi.fn()
    clear = vi.fn()
    dispose = vi.fn()
    loadAddon = vi.fn()
    open = vi.fn()
    attachCustomKeyEventHandler = vi.fn()
    hasSelection = () => false
    getSelection = () => ''
    onData = vi.fn<(listener: (data: string) => void) => { dispose(): void }>(() => ({
      dispose: vi.fn(),
    }))
    onResize = vi.fn(() => ({ dispose: vi.fn() }))

    constructor() {
      terminalMock.instances.push(this)
    }

    emitData(data: string) {
      const listener = this.onData.mock.calls[0]?.[0] as ((value: string) => void) | undefined
      listener?.(data)
    }
  },
}))

import {
  WorkspaceTabsProvider,
  useWorkspaceTabs,
} from '../src/renderer/src/features/workspace-tabs/WorkspaceTabsProvider.tsx'
import { TerminalView } from '../src/renderer/src/features/terminal/TerminalView.tsx'
import type { DesktopBridge, DesktopTerminalApi } from '../src/renderer/src/platform/contracts.ts'
import type { DesktopTerminalEvent } from '../src/shared/terminal.ts'

class TestResizeObserver {
  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}
}

function createBridge(options: { createError?: Error } = {}) {
  let nextTerminal = 0
  const listeners = new Set<(event: DesktopTerminalEvent) => void>()
  const terminal: DesktopTerminalApi = {
    create: vi.fn(async request => {
      if (options.createError !== undefined) throw options.createError
      nextTerminal += 1
      if (request.taskId !== undefined) {
        return {
          id: `终端-${String(nextTerminal)}`,
          pid: 100 + nextTerminal,
          kind: 'task' as const,
          title: '启动开发服务',
          taskId: request.taskId,
        }
      }
      return {
        id: `终端-${String(nextTerminal)}`,
        pid: 100 + nextTerminal,
        kind: 'shell' as const,
        title: 'zsh',
      }
    }),
    ready: vi.fn(async () => undefined),
    write: vi.fn(async () => undefined),
    resize: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    clipboard: vi.fn(async () => undefined),
    onEvent: listener => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
  const bridge: DesktopBridge = {
    remote: {
      call: async () => {
        throw new Error('测试未声明扩展 Remote')
      },
      cancelCall: async () => {},
      follow: () => () => {},
    },
    setPluginBusyReasons: async () => {},
    getFrontendPlugins: async () => [],
    onFrontendPluginsChanged: () => () => undefined,
    version: 19,
    terminal,
    settings: {
      read: vi.fn(),
      update: vi.fn(),
      chooseBackground: vi.fn(),
      applyBackground: vi.fn(),
      cancelBackground: vi.fn(),
      clearBackground: vi.fn(),
      onChanged: () => () => undefined,
      onOpenRequested: () => () => undefined,
    },
    host: {
      status: vi.fn(),
      call: vi.fn(),
      onStatusChanged: () => () => undefined,
    },
  }
  return {
    bridge,
    terminal,
    emit: (event: DesktopTerminalEvent) => {
      for (const listener of listeners) listener(event)
    },
  }
}

beforeEach(() => {
  terminalMock.instances.length = 0
  vi.stubGlobal('ResizeObserver', TestResizeObserver)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0)
    return 1
  })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
})

afterEach(() => {
  delete window.dshDesktop
  vi.unstubAllGlobals()
})

function SharedTerminalTabs({ visible }: { visible: boolean }) {
  const navigation = useWorkspaceTabs()
  return (
    <div aria-label="统一标签测试入口">
      {navigation?.terminalGroups.flatMap(group =>
        group.tabs.map(tab => (
          <div key={`${group.projectAccessId}:${tab.key}`}>
            <button
              onClick={() => {
                group.close(tab.key)
              }}
            >
              关闭共享 {tab.title}
            </button>
            <div hidden={!visible}>
              {group.render?.(tab.key, visible && group.activeKey === tab.key)}
            </div>
          </div>
        )),
      )}
    </div>
  )
}

const content = (visible: boolean) => (
  <WorkspaceTabsProvider>
    <SharedTerminalTabs visible={visible} />
    <TerminalView projectId="项目-1" visible={visible} />
  </WorkspaceTabsProvider>
)

describe('用户终端视图', () => {
  it.each([
    { name: '局部标签终端', shared: false },
    { name: '统一工作标签终端', shared: true },
  ])('$name 使用紧凑图标，复制、粘贴、清屏、重启与新建功能不变', async ({ shared }) => {
    const harness = createBridge()
    window.dshDesktop = harness.bridge
    const view = render(shared ? content(true) : <TerminalView projectId="项目-1" />)
    await waitFor(() => {
      expect(harness.terminal.ready).toHaveBeenCalledWith('终端-1')
    })
    const controls = within(view.container).getByRole('group', { name: '终端操作' })
    const buttons = within(controls).getAllByRole('button')
    expect(buttons.map(button => button.getAttribute('aria-label'))).toEqual([
      '新建终端',
      '复制所选内容',
      '粘贴剪贴板内容',
      '清除终端显示',
      '重启当前终端',
    ])
    for (const button of buttons) {
      const icon = button.querySelector('svg')
      expect(icon?.getAttribute('width')).toBe('16')
      expect(icon?.getAttribute('height')).toBe('16')
      expect(icon?.getAttribute('aria-hidden')).toBe('true')
      expect(button.getAttribute('title')).toBeTruthy()
      expect(button.textContent).toBe('')
    }
    expect(buttons[0]?.querySelector('.lucide-message-square-plus')).toBeTruthy()
    expect(buttons[3]?.querySelector('.lucide-scan-line')).toBeTruthy()
    const terminal = terminalMock.instances[0]!
    vi.spyOn(terminal, 'hasSelection').mockReturnValue(true)
    fireEvent.click(within(controls).getByRole('button', { name: '复制所选内容' }))
    fireEvent.click(within(controls).getByRole('button', { name: '粘贴剪贴板内容' }))
    await waitFor(() => {
      expect(harness.terminal.clipboard).toHaveBeenCalledWith('copy')
      expect(harness.terminal.clipboard).toHaveBeenCalledWith('paste')
    })
    fireEvent.click(within(controls).getByRole('button', { name: '清除终端显示' }))
    expect(terminal.clear).toHaveBeenCalledOnce()
    expect(harness.terminal.close).not.toHaveBeenCalled()
    expect(harness.terminal.create).toHaveBeenCalledTimes(1)
    fireEvent.click(within(controls).getByRole('button', { name: '重启当前终端' }))
    await waitFor(() => {
      expect(harness.terminal.close).toHaveBeenCalledWith('终端-1')
      expect(harness.terminal.ready).toHaveBeenCalledWith('终端-2')
    })
    fireEvent.click(within(controls).getByRole('button', { name: '新建终端' }))
    await waitFor(() => {
      expect(harness.terminal.ready).toHaveBeenCalledWith('终端-3')
    })
    view.unmount()
    await waitFor(() => {
      expect(harness.terminal.close).toHaveBeenCalledWith('终端-2')
      expect(harness.terminal.close).toHaveBeenCalledWith('终端-3')
    })
  })

  it('顶栏接管标签后隐藏局部标签，切换视图保留 PTY，关闭共享标签才清理', async () => {
    const harness = createBridge()
    window.dshDesktop = harness.bridge
    const view = render(content(true))
    await waitFor(() => {
      expect(harness.terminal.ready).toHaveBeenCalledWith('终端-1')
    })
    expect(screen.queryByRole('tab')).toBeNull()
    view.rerender(content(false))
    expect(harness.terminal.close).not.toHaveBeenCalled()
    vi.mocked(harness.terminal.close).mockRejectedValueOnce(new Error('终端关闭失败'))
    fireEvent.click(screen.getByRole('button', { name: '关闭共享 终端 1' }))
    expect((await screen.findByRole('alert')).textContent).toContain('终端关闭失败')
    expect(screen.getByRole('button', { name: '关闭共享 终端 1' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '关闭共享 终端 1' }))
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: '关闭共享 终端 1' })).toBeNull()
    })
    expect(harness.terminal.close).toHaveBeenCalledTimes(2)
    view.unmount()
  })

  it('创建真实 PTY、接收输出、打开第二个标签并在卸载时关闭终端', async () => {
    const harness = createBridge()
    window.dshDesktop = harness.bridge
    const view = render(<TerminalView projectId="项目-1" projectName="演示项目" />)

    await waitFor(() => {
      expect(harness.terminal.create).toHaveBeenCalledWith({
        projectId: '项目-1',
        columns: 80,
        rows: 24,
      })
      expect(harness.terminal.ready).toHaveBeenCalledWith('终端-1')
    })
    act(() => {
      harness.emit({ type: 'data', terminalId: '终端-1', data: '\u001b[32m完成\u001b[0m' })
    })
    expect(terminalMock.instances[0]?.write).toHaveBeenCalledWith('\u001b[32m完成\u001b[0m')
    act(() => {
      terminalMock.instances[0]?.emitData('pwd\r')
    })
    await waitFor(() => {
      expect(harness.terminal.write).toHaveBeenCalledWith('终端-1', 'pwd\r')
    })

    fireEvent.click(screen.getByRole('button', { name: '新建终端' }))
    await waitFor(() => {
      expect(harness.terminal.create).toHaveBeenCalledTimes(2)
      expect(harness.terminal.ready).toHaveBeenCalledWith('终端-2')
    })
    expect(screen.getByRole('tab', { name: /终端 2/u }).getAttribute('aria-selected')).toBe('true')

    view.unmount()
    await waitFor(() => {
      expect(harness.terminal.close).toHaveBeenCalledWith('终端-1')
      expect(harness.terminal.close).toHaveBeenCalledWith('终端-2')
    })
  })

  it('任务直接进入唯一 PTY 标签，并按并发选项聚焦、重启或新建', async () => {
    const harness = createBridge()
    window.dshDesktop = harness.bridge
    const consume = vi.fn()
    const taskId = '00000000-0000-0000-0000-000000000001'
    const request = {
      key: 1,
      projectId: '项目-1',
      projectName: '演示项目',
      taskId,
      name: '启动开发服务',
      allowConcurrent: false,
    }
    const view = render(
      <TerminalView
        projectId="项目-1"
        projectName="演示项目"
        launchRequest={request}
        onConsumeLaunchRequest={consume}
      />,
    )

    await waitFor(() => {
      expect(harness.terminal.create).toHaveBeenCalledWith({
        projectId: '项目-1',
        taskId,
        columns: 80,
        rows: 24,
      })
      expect(harness.terminal.ready).toHaveBeenCalledWith('终端-1')
    })
    expect(screen.getAllByRole('tab')).toHaveLength(1)
    expect(screen.getByRole('tab', { name: /启动开发服务/u })).toBeTruthy()
    expect(screen.queryByRole('tab', { name: /终端 1/u })).toBeNull()

    view.rerender(
      <TerminalView
        projectId="项目-1"
        projectName="演示项目"
        launchRequest={{ ...request, key: 2 }}
        onConsumeLaunchRequest={consume}
      />,
    )
    await waitFor(() => {
      expect(consume).toHaveBeenCalledWith(2)
    })
    expect(harness.terminal.create).toHaveBeenCalledTimes(1)

    act(() => {
      harness.emit({ type: 'exit', terminalId: '终端-1', exitCode: 0 })
    })
    expect(await screen.findByText('已退出 0')).toBeTruthy()
    view.rerender(
      <TerminalView
        projectId="项目-1"
        projectName="演示项目"
        launchRequest={{ ...request, key: 3 }}
        onConsumeLaunchRequest={consume}
      />,
    )
    await waitFor(() => {
      expect(harness.terminal.create).toHaveBeenCalledTimes(2)
    })
    expect(screen.getAllByRole('tab')).toHaveLength(1)

    view.rerender(
      <TerminalView
        projectId="项目-1"
        projectName="演示项目"
        launchRequest={{ ...request, key: 4, allowConcurrent: true }}
        onConsumeLaunchRequest={consume}
      />,
    )
    await waitFor(() => {
      expect(harness.terminal.create).toHaveBeenCalledTimes(3)
    })
    expect(screen.getAllByRole('tab')).toHaveLength(2)
    expect(harness.terminal.create).toHaveBeenNthCalledWith(3, {
      projectId: '项目-1',
      taskId,
      columns: 80,
      rows: 24,
    })
  })

  it('终端启动失败时使用统一可关闭提示', async () => {
    const harness = createBridge({ createError: new Error('无法启动登录 Shell') })
    window.dshDesktop = harness.bridge
    render(<TerminalView projectId="项目-1" projectName="演示项目" />)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('终端操作失败')
    expect(alert.textContent).toContain('无法启动登录 Shell')
    expect(alert.className).toContain('app-alert--floating')
    fireEvent.click(screen.getByRole('button', { name: '关闭提示' }))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('原生粘贴失败只显示中文浮层，不把运行中的终端标为失败', async () => {
    const harness = createBridge()
    window.dshDesktop = harness.bridge
    vi.mocked(harness.terminal.clipboard).mockRejectedValueOnce(new Error('终端窗口已关闭'))
    const view = render(<TerminalView projectId="项目-1" projectName="演示项目" />)
    const currentView = within(view.container)

    await waitFor(() => {
      expect(harness.terminal.ready).toHaveBeenCalledWith('终端-1')
    })
    fireEvent.click(currentView.getByRole('button', { name: '粘贴剪贴板内容' }))

    const alert = await screen.findByRole('alert')
    expect(alert.className).toContain('app-alert--floating')
    expect(harness.terminal.clipboard).toHaveBeenCalledWith('paste')
    expect(alert.textContent).toContain('终端窗口已关闭')
    expect(currentView.getByText('zsh')).toBeTruthy()
    expect(currentView.queryByText('启动失败')).toBeNull()
  })
})
