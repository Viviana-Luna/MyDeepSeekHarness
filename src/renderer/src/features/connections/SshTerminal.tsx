import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type {
  SshTerminal as TerminalState,
  SshTerminalEvent,
} from '../../../../../packages/connections/ssh/types.d.ts'
import { callRemote, followRemote } from '../../plugins/sdk.ts'

/** 显隐只影响绘制；通道由连接工作区的明确关闭动作拥有。 */
export function SshTerminal({
  terminal,
  active,
  focusOnActivate = true,
  onStatus,
  onError,
}: {
  terminal: TerminalState
  active: boolean
  focusOnActivate?: boolean
  onStatus(value: TerminalState): void
  onError(error: unknown): void
}) {
  const host = useRef<HTMLDivElement>(null),
    callbacks = useRef({ onStatus, onError }),
    view = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  callbacks.current = { onStatus, onError }
  useEffect(() => {
    const element = host.current
    if (!element) return undefined
    const lifetime = new AbortController()
    const theme = () => {
      const style = getComputedStyle(document.documentElement),
        color = (name: string) => style.getPropertyValue(name).trim()
      return {
        background: color('--editor-background'),
        foreground: color('--editor-text'),
        cursor: color('--editor-cursor'),
        selectionBackground: color('--editor-selection'),
      }
    }
    const instance = new Terminal({
      fontFamily: 'ui-monospace, Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.25,
      scrollback: 10000,
      cursorBlink: true,
      minimumContrastRatio: 4.5,
      theme: theme(),
    })
    const fit = new FitAddon()
    instance.loadAddon(fit)
    instance.open(element)
    view.current = instance
    fitRef.current = fit
    const report = (error: unknown) => {
      if (!lifetime.signal.aborted) callbacks.current.onError(error)
    }
    const input = instance.onData(data => {
      void callRemote('mydshSsh/input', { id: terminal.id, data }, lifetime.signal).catch(report)
    })
    const resize = instance.onResize(({ cols, rows }) => {
      void callRemote(
        'mydshSsh/resize',
        {
          id: terminal.id,
          columns: Math.max(2, Math.min(500, cols)),
          rows: Math.max(1, Math.min(200, rows)),
        },
        lifetime.signal,
      ).catch(report)
    })
    const stop = followRemote(
      'mydshSsh/events',
      { id: terminal.id },
      raw => {
        const event = raw as SshTerminalEvent
        if (event.type === 'snapshot') {
          instance.reset()
          instance.write(event.data)
          callbacks.current.onStatus(event.terminal)
        }
        if (event.type === 'data') instance.write(event.data)
        if (event.type === 'status') {
          callbacks.current.onStatus(event.terminal)
          if (event.terminal.status === 'disconnected')
            instance.write('\r\n\x1b[90m[SSH 连接已断开]\x1b[0m\r\n')
        }
      },
      report,
    )
    const resizeObserver = new ResizeObserver(() => {
      if (element.clientWidth && element.clientHeight) fit.fit()
    })
    resizeObserver.observe(element)
    const appearance = new MutationObserver(() => {
      instance.options.theme = theme()
    })
    appearance.observe(document.documentElement, { attributes: true })
    return () => {
      lifetime.abort()
      stop()
      input.dispose()
      resize.dispose()
      resizeObserver.disconnect()
      appearance.disconnect()
      instance.dispose()
      view.current = null
      fitRef.current = null
    }
  }, [terminal.id])
  useEffect(() => {
    if (!active) return undefined
    const frame = requestAnimationFrame(() => {
      fitRef.current?.fit()
      if (focusOnActivate) view.current?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [active, focusOnActivate])
  return (
    <div
      ref={host}
      className="connections-terminal"
      id={`ssh-terminal-panel-${terminal.id}`}
      role="tabpanel"
      aria-labelledby={`ssh-terminal-tab-${terminal.id}`}
      hidden={!active}
      data-ssh-terminal={terminal.id}
      aria-label={`SSH 终端：${terminal.name}`}
    />
  )
}
