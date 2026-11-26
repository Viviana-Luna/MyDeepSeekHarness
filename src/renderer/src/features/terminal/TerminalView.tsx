import { FitAddon } from '@xterm/addon-fit'
import { Terminal, type ITheme } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import {
  ClipboardPaste,
  Copy,
  MessageSquarePlus,
  PanelTopOpen,
  RotateCcw,
  ScanLine,
  TerminalSquare,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import {
  DESKTOP_TERMINAL_LIMITS,
  type DesktopTerminalDescriptor,
  type DesktopTerminalKind,
} from '../../../../shared/terminal.ts'
import { getDesktopBridge } from '../../services/desktop.ts'
import type { DesktopTerminalApi } from '../../platform/contracts.ts'
import { AppAlert } from '../../shared/ui/AppAlert.tsx'
import { CapabilityState } from '../../shared/ui/CapabilityState.tsx'
import type { ProjectTaskLaunchRequest } from '../project-tasks/ProjectTasksProvider.tsx'
import styles from './TerminalView.module.css'
import { useWorkspaceTabs } from '../workspace-tabs/WorkspaceTabsProvider.tsx'

type TerminalStatus = 'starting' | 'running' | 'exited' | 'error'

interface TerminalTab {
  key: string
  number: number
  restart: number
  status: TerminalStatus
  kind: DesktopTerminalKind
  title: string
  processTitle: string | null
  taskId?: string
  exitCode: number | null
}

interface TerminalPaneActions {
  close(): Promise<void>
  copy(): Promise<void>
  paste(): Promise<void>
  clear(): void
  focus(): void
}

interface TerminalPaneProps {
  tabKey: string
  api: DesktopTerminalApi
  projectId: string
  taskId?: string
  active: boolean
  onActions(tabKey: string, actions: TerminalPaneActions | null): void
  onStatus(
    tabKey: string,
    status: TerminalStatus,
    descriptor?: DesktopTerminalDescriptor,
    exitCode?: number,
  ): void
  onError(message: string): void
}

function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : '终端操作失败'
  const message = raw
    .replace(/^Error invoking remote method '[^']+': Error:\s*/u, '')
    .replace(/^Error:\s*/u, '')
  return message
}

function terminalTheme(): ITheme {
  const style = getComputedStyle(document.documentElement)
  const value = (name: string, fallback: string): string =>
    style.getPropertyValue(name).trim() || fallback
  return {
    background: value('--editor-background', '#15171b'),
    foreground: value('--editor-text', '#d7dae0'),
    cursor: value('--editor-cursor', '#f4f6fa'),
    cursorAccent: value('--editor-background', '#15171b'),
    selectionBackground: value('--editor-selection', 'rgb(49 93 140 / .6)'),
    black: '#1c1d21',
    red: value('--negative', '#ff5d68'),
    green: value('--positive', '#37c66a'),
    yellow: value('--warning', '#e5a64f'),
    blue: value('--editor-accent', '#7ea2ff'),
    magenta: value('--editor-keyword', '#d18bb7'),
    cyan: value('--editor-type', '#78b7d5'),
    white: value('--editor-text', '#d7dae0'),
    brightBlack: value('--faint', '#858995'),
    brightRed: '#ff7a83',
    brightGreen: '#65d889',
    brightYellow: '#f0bd70',
    brightBlue: '#9ab7ff',
    brightMagenta: '#e4a5cc',
    brightCyan: '#9bd5ed',
    brightWhite: value('--text', '#f3f4f7'),
  }
}

function TerminalPane({
  tabKey,
  api,
  projectId,
  taskId,
  active,
  onActions,
  onStatus,
  onError,
}: TerminalPaneProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const activeRef = useRef(active)
  activeRef.current = active

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return undefined
    let disposed = false
    let terminalId: string | null = null
    const notify = (caught: unknown): void => {
      if (disposed) return
      onError(errorMessage(caught))
    }
    const fail = (caught: unknown): void => {
      notify(caught)
      onStatus(tabKey, 'error')
    }
    const computed = getComputedStyle(document.documentElement)
    const fontSize = Number.parseFloat(computed.getPropertyValue('--editor-font-size')) || 13
    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: 'bar',
      fontFamily:
        computed.getPropertyValue('--editor-font-family').trim() ||
        'ui-monospace, Menlo, monospace',
      fontSize,
      lineHeight: 1.25,
      minimumContrastRatio: 4.5,
      scrollback: 10_000,
      smoothScrollDuration: 80,
      theme: terminalTheme(),
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(host)

    const copy = async (): Promise<void> => {
      if (!terminal.hasSelection()) return
      terminal.focus()
      await api.clipboard('copy')
    }
    const paste = async (): Promise<void> => {
      if (terminalId === null) return
      terminal.focus()
      await api.clipboard('paste')
    }
    const actions: TerminalPaneActions = {
      close: async () => {
        if (terminalId !== null) {
          await api.close(terminalId)
          terminalId = null
        }
      },
      copy: async () => {
        await copy().catch(notify)
      },
      paste: async () => {
        await paste().catch(notify)
      },
      clear: () => {
        terminal.clear()
      },
      focus: () => {
        terminal.focus()
      },
    }
    onActions(tabKey, actions)

    // 键盘复制粘贴交给 Chromium 与 xterm 的原生事件；异步 readText 会被 sandbox 拒绝。

    const fitTerminal = (): void => {
      if (disposed || !activeRef.current || host.clientWidth === 0 || host.clientHeight === 0)
        return
      try {
        fit.fit()
      } catch (caught) {
        fail(caught)
      }
    }
    const frame = requestAnimationFrame(fitTerminal)
    const resizeObserver = new ResizeObserver(fitTerminal)
    resizeObserver.observe(host)
    const resizeSubscription = terminal.onResize(({ cols, rows }) => {
      if (terminalId !== null) void api.resize(terminalId, cols, rows).catch(fail)
    })
    const inputSubscription = terminal.onData(data => {
      if (terminalId !== null) void api.write(terminalId, data).catch(fail)
    })
    const stopEvents = api.onEvent(event => {
      if (event.terminalId !== terminalId || disposed) return
      if (event.type === 'data') {
        terminal.write(event.data)
        return
      }
      const detail =
        event.signal === undefined
          ? `退出码 ${String(event.exitCode)}`
          : `退出码 ${String(event.exitCode)}，信号 ${String(event.signal)}`
      terminal.write(`\r\n\u001b[90m[进程已退出：${detail}]\u001b[0m\r\n`)
      onStatus(tabKey, 'exited', undefined, event.exitCode)
    })
    const themeObserver = new MutationObserver(() => {
      terminal.options.theme = terminalTheme()
    })
    themeObserver.observe(document.documentElement, { attributes: true })

    void (async () => {
      try {
        fitTerminal()
        const descriptor = await api.create({
          projectId,
          ...(taskId === undefined ? {} : { taskId }),
          columns: Math.max(DESKTOP_TERMINAL_LIMITS.minColumns, terminal.cols || 80),
          rows: Math.max(DESKTOP_TERMINAL_LIMITS.minRows, terminal.rows || 24),
        })
        if (disposed) {
          await api.close(descriptor.id).catch(() => undefined)
          return
        }
        terminalId = descriptor.id
        host.dataset.terminalId = descriptor.id
        onStatus(tabKey, 'running', descriptor)
        await api.resize(descriptor.id, terminal.cols, terminal.rows)
        await api.ready(descriptor.id)
        if (activeRef.current) terminal.focus()
      } catch (caught) {
        fail(caught)
      }
    })()

    return () => {
      disposed = true
      cancelAnimationFrame(frame)
      resizeObserver.disconnect()
      themeObserver.disconnect()
      stopEvents()
      inputSubscription.dispose()
      resizeSubscription.dispose()
      onActions(tabKey, null)
      const closingId = terminalId
      terminalId = null
      delete host.dataset.terminalId
      if (closingId !== null) void api.close(closingId).catch(() => undefined)
      terminal.dispose()
    }
  }, [api, onActions, onError, onStatus, projectId, tabKey, taskId])

  useEffect(() => {
    if (!active) return undefined
    const frame = requestAnimationFrame(() => {
      hostRef.current?.querySelector<HTMLElement>('.xterm-helper-textarea')?.focus()
    })
    return () => {
      cancelAnimationFrame(frame)
    }
  }, [active])

  return <div ref={hostRef} className={styles.terminalHost} hidden={!active} />
}

function statusLabel(tab: TerminalTab): string {
  if (tab.status === 'starting') return '启动中'
  if (tab.status === 'running')
    return tab.kind === 'shell' ? (tab.processTitle ?? '运行中') : '运行中'
  if (tab.status === 'exited') return `已退出 ${String(tab.exitCode ?? 0)}`
  return '启动失败'
}

export interface TerminalViewProps {
  projectId: string | null
  projectName?: string
  visible?: boolean
  canCreate?: boolean
  launchRequest?: ProjectTaskLaunchRequest | null
  onConsumeLaunchRequest?(key: number): void
  onTabCountChange?(count: number): void
  onOpenInMain?: (() => void) | undefined
}

export function TerminalView({
  projectId,
  projectName = '当前项目',
  visible = true,
  canCreate = true,
  launchRequest = null,
  onConsumeLaunchRequest,
  onTabCountChange,
  onOpenInMain,
}: TerminalViewProps) {
  const sharedTabs = useWorkspaceTabs()
  const publishTerminalGroup = sharedTabs?.publishTerminalGroup
  const removeTerminalGroup = sharedTabs?.removeTerminalGroup
  const api = getDesktopBridge().terminal
  const nextNumber = useRef(0)
  const actions = useRef(new Map<string, TerminalPaneActions>())
  const closing = useRef(new Set<string>())
  const activated = useRef(false)
  const consumedLaunchKey = useRef(0)
  const [tabs, setTabs] = useState<TerminalTab[]>([])
  const tabsRef = useRef<readonly TerminalTab[]>(tabs)
  tabsRef.current = tabs
  const [activeKey, setActiveKey] = useState('')
  const [error, setError] = useState<string | null>(null)
  const clearError = useCallback(() => {
    setError(null)
  }, [])
  const tabCountListener = useRef(onTabCountChange)
  tabCountListener.current = onTabCountChange

  useEffect(() => {
    tabCountListener.current?.(tabs.length)
  }, [tabs.length])
  useEffect(
    () => () => {
      tabCountListener.current?.(0)
    },
    [],
  )

  const updateTab = useCallback((key: string, patch: Partial<TerminalTab>) => {
    setTabs(current => current.map(tab => (tab.key === key ? { ...tab, ...patch } : tab)))
  }, [])
  const createTab = useCallback(() => {
    if (!canCreate || tabsRef.current.length >= DESKTOP_TERMINAL_LIMITS.maxTerminals) return
    const number = nextNumber.current + 1
    nextNumber.current = number
    const tab: TerminalTab = {
      key: `terminal-${String(number)}`,
      number,
      restart: 0,
      status: 'starting',
      kind: 'shell',
      title: `终端 ${String(number)}`,
      processTitle: null,
      exitCode: null,
    }
    setTabs(current => [...current, tab])
    setActiveKey(tab.key)
  }, [canCreate])
  const closeTab = useCallback(async (key: string) => {
    if (closing.current.has(key)) return
    closing.current.add(key)
    try {
      await actions.current.get(key)?.close()
      const index = tabsRef.current.findIndex(tab => tab.key === key)
      const remaining = tabsRef.current.filter(tab => tab.key !== key)
      tabsRef.current = remaining
      actions.current.delete(key)
      setTabs(remaining)
      setActiveKey(current =>
        current === key ? (remaining[Math.min(index, remaining.length - 1)]?.key ?? '') : current,
      )
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      closing.current.delete(key)
    }
  }, [])
  const restartTab = useCallback(
    (key: string) => {
      clearError()
      setTabs(current =>
        current.map(tab =>
          tab.key === key
            ? {
                ...tab,
                restart: tab.restart + 1,
                status: 'starting',
                processTitle: null,
                exitCode: null,
              }
            : tab,
        ),
      )
    },
    [clearError],
  )
  const registerActions = useCallback((key: string, value: TerminalPaneActions | null) => {
    if (value === null) actions.current.delete(key)
    else actions.current.set(key, value)
  }, [])
  const handleStatus = useCallback(
    (
      key: string,
      status: TerminalStatus,
      descriptor?: DesktopTerminalDescriptor,
      exitCode?: number,
    ) => {
      updateTab(key, {
        status,
        ...(descriptor === undefined
          ? {}
          : {
              kind: descriptor.kind,
              title:
                descriptor.kind === 'task'
                  ? descriptor.title
                  : (tabsRef.current.find(tab => tab.key === key)?.title ?? descriptor.title),
              processTitle: descriptor.title,
              ...(descriptor.taskId === undefined ? {} : { taskId: descriptor.taskId }),
            }),
        ...(exitCode === undefined ? {} : { exitCode }),
      })
    },
    [updateTab],
  )
  const launchTask = useCallback(
    (request: ProjectTaskLaunchRequest) => {
      const existing = request.allowConcurrent
        ? undefined
        : tabsRef.current.find(tab => tab.kind === 'task' && tab.taskId === request.taskId)
      if (existing !== undefined) {
        setActiveKey(existing.key)
        if (existing.status === 'exited' || existing.status === 'error') restartTab(existing.key)
        else
          requestAnimationFrame(() => {
            actions.current.get(existing.key)?.focus()
          })
        return
      }
      if (!canCreate || tabsRef.current.length >= DESKTOP_TERMINAL_LIMITS.maxTerminals) {
        setError(`一个窗口最多同时打开 ${String(DESKTOP_TERMINAL_LIMITS.maxTerminals)} 个终端`)
        return
      }
      const number = nextNumber.current + 1
      nextNumber.current = number
      const tab: TerminalTab = {
        key: `terminal-${String(number)}`,
        number,
        restart: 0,
        status: 'starting',
        kind: 'task',
        title: request.name,
        processTitle: null,
        taskId: request.taskId,
        exitCode: null,
      }
      setTabs(current => [...current, tab])
      setActiveKey(tab.key)
    },
    [canCreate, restartTab],
  )

  useEffect(() => {
    if (launchRequest === null || launchRequest.key === consumedLaunchKey.current) return
    consumedLaunchKey.current = launchRequest.key
    activated.current = true
    launchTask(launchRequest)
    onConsumeLaunchRequest?.(launchRequest.key)
  }, [launchRequest, launchTask, onConsumeLaunchRequest])

  useEffect(() => {
    if (!visible || activated.current || launchRequest !== null) return
    activated.current = true
    if (tabsRef.current.length === 0) createTab()
  }, [createTab, launchRequest, visible])
  useEffect(() => {
    if (projectId === null) return
    publishTerminalGroup?.({
      projectAccessId: projectId,
      activeKey,
      tabs: tabs.map(tab => ({ ...tab, description: statusLabel(tab) })),
      select: key => {
        if (!tabsRef.current.some(tab => tab.key === key)) return
        setActiveKey(key)
        requestAnimationFrame(() => {
          actions.current.get(key)?.focus()
        })
      },
      close: closeTab,
      create: createTab,
      render: (key, shown) => {
        const tab = tabs.find(item => item.key === key)
        if (!tab || !api) return null
        const action = actions.current.get(key)
        return (
          <section
            className={`workspace-view ${styles.view}`}
            aria-label={`${projectName} ${tab.title}`}
          >
            <header className={styles.toolbar}>
              <span className={styles.projectName}>
                {projectName} · {statusLabel(tab)}
              </span>
              <div className={styles.actions} role="group" aria-label="终端操作">
                <button
                  type="button"
                  className={styles.iconButton}
                  aria-label="新建终端"
                  title="新建终端"
                  disabled={!canCreate}
                  onClick={createTab}
                >
                  <MessageSquarePlus size={16} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className={styles.iconButton}
                  aria-label="复制所选内容"
                  title="复制"
                  disabled={!action}
                  onClick={() => {
                    void action?.copy()
                  }}
                >
                  <Copy size={16} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className={styles.iconButton}
                  aria-label="粘贴剪贴板内容"
                  title="粘贴"
                  disabled={!action}
                  onClick={() => {
                    void action?.paste()
                  }}
                >
                  <ClipboardPaste size={16} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className={styles.iconButton}
                  aria-label="清除终端显示"
                  title="清屏"
                  disabled={!action}
                  onClick={() => {
                    action?.clear()
                  }}
                >
                  <ScanLine size={16} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className={styles.iconButton}
                  aria-label="重启当前终端"
                  title="重启"
                  onClick={() => {
                    restartTab(key)
                  }}
                >
                  <RotateCcw size={16} aria-hidden="true" />
                </button>
              </div>
            </header>
            <div className={styles.panes}>
              <TerminalPane
                key={`${tab.key}:${tab.restart}`}
                tabKey={tab.key}
                api={api}
                projectId={projectId}
                {...(tab.taskId === undefined ? {} : { taskId: tab.taskId })}
                active={shown}
                onActions={registerActions}
                onStatus={handleStatus}
                onError={setError}
              />
            </div>
          </section>
        )
      },
    })
  }, [
    activeKey,
    closeTab,
    projectId,
    publishTerminalGroup,
    tabs,
    createTab,
    api,
    projectName,
    restartTab,
    canCreate,
    error,
    clearError,
    registerActions,
    handleStatus,
  ])
  useEffect(
    () => () => {
      if (projectId !== null) removeTerminalGroup?.(projectId)
    },
    [projectId, removeTerminalGroup],
  )
  const activeActions = actions.current.get(activeKey)

  if (projectId === null) {
    return (
      <section className="workspace-view" hidden={!visible}>
        <CapabilityState
          icon={TerminalSquare}
          title="请选择一个可访问的项目"
          detail="请先选择项目，再在该项目目录中启动终端。"
        />
      </section>
    )
  }
  if (api === undefined) {
    return (
      <section className="workspace-view" hidden={!visible}>
        <CapabilityState
          icon={TerminalSquare}
          title="当前桌面桥不支持终端"
          detail="请重新启动最新版本的 MyDSH。"
        />
      </section>
    )
  }

  if (sharedTabs !== null)
    return (
      <>
        {error && (
          <AppAlert tone="error" title="终端操作失败" floating onClose={clearError}>
            {error}
          </AppAlert>
        )}
        {tabs.length === 0 && (
          <div className={styles.empty}>
            <TerminalSquare size={24} />
            <strong>没有打开的终端</strong>
            <button type="button" disabled={!canCreate} onClick={createTab}>
              新建终端
            </button>
          </div>
        )}
      </>
    )

  return (
    <section
      id={visible ? 'terminal-view' : undefined}
      className={`workspace-view ${styles.view}`}
      aria-label={`${projectName} 用户终端`}
      hidden={!visible}
    >
      <header className={styles.toolbar}>
        <div
          className={styles.tabs}
          role={sharedTabs === null ? 'tablist' : undefined}
          aria-label="终端操作入口"
        >
          {sharedTabs === null &&
            tabs.map(tab => (
              <div
                key={tab.key}
                className={styles.tab}
                data-active={tab.key === activeKey || undefined}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab.key === activeKey}
                  className={styles.tabSelect}
                  onClick={() => {
                    setActiveKey(tab.key)
                    requestAnimationFrame(() => {
                      actions.current.get(tab.key)?.focus()
                    })
                  }}
                >
                  <span className={styles.statusDot} data-status={tab.status} aria-hidden="true" />
                  <span>{tab.title}</span>
                  <small>{statusLabel(tab)}</small>
                </button>
                <button
                  type="button"
                  className={styles.tabClose}
                  aria-label={`关闭终端 ${String(tab.number)}`}
                  onClick={() => {
                    closeTab(tab.key)
                  }}
                >
                  <X size={16} aria-hidden="true" />
                </button>
              </div>
            ))}
        </div>
        <div className={styles.actions} role="group" aria-label="终端操作">
          <span className={styles.projectName} title={projectName}>
            {projectName}
          </span>
          <button
            type="button"
            className={styles.iconButton}
            aria-label="新建终端"
            title="新建终端"
            disabled={!canCreate || tabs.length >= DESKTOP_TERMINAL_LIMITS.maxTerminals}
            onClick={createTab}
          >
            <MessageSquarePlus size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            className={styles.iconButton}
            aria-label="复制所选内容"
            title="复制"
            disabled={activeActions === undefined}
            onClick={() => {
              void activeActions?.copy()
            }}
          >
            <Copy size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            className={styles.iconButton}
            aria-label="粘贴剪贴板内容"
            title="粘贴"
            disabled={activeActions === undefined}
            onClick={() => {
              void activeActions?.paste()
            }}
          >
            <ClipboardPaste size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            className={styles.iconButton}
            aria-label="清除终端显示"
            title="清屏"
            disabled={activeActions === undefined}
            onClick={() => {
              activeActions?.clear()
            }}
          >
            <ScanLine size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            className={styles.iconButton}
            aria-label="重启当前终端"
            title="重启"
            disabled={activeKey === ''}
            onClick={() => {
              restartTab(activeKey)
            }}
          >
            <RotateCcw size={16} aria-hidden="true" />
          </button>
          {onOpenInMain !== undefined && (
            <button
              type="button"
              className={styles.iconButton}
              aria-label="在主区打开终端"
              title="在主区打开终端"
              onClick={onOpenInMain}
            >
              <PanelTopOpen size={16} aria-hidden="true" />
            </button>
          )}
        </div>
      </header>
      <div className={styles.panes}>
        {error !== null && (
          <AppAlert
            tone="error"
            title="终端操作失败"
            floating
            dismissAfterMs={8_000}
            onClose={clearError}
          >
            {error}
          </AppAlert>
        )}
        {tabs.length === 0 ? (
          <div className={styles.empty}>
            <TerminalSquare size={24} aria-hidden="true" />
            <strong>没有打开的终端</strong>
            <button type="button" disabled={!canCreate} onClick={createTab}>
              <MessageSquarePlus size={16} aria-hidden="true" />
              新建终端
            </button>
          </div>
        ) : (
          tabs.map(tab => (
            <TerminalPane
              key={`${tab.key}:${String(tab.restart)}`}
              tabKey={tab.key}
              api={api}
              projectId={projectId}
              {...(tab.taskId === undefined ? {} : { taskId: tab.taskId })}
              active={visible && tab.key === activeKey}
              onActions={registerActions}
              onStatus={handleStatus}
              onError={setError}
            />
          ))
        )}
      </div>
    </section>
  )
}
