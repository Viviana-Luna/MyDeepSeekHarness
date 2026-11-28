import {
  ArrowLeft,
  ArrowRight,
  CornerDownLeft,
  ExternalLink,
  Globe,
  LoaderCircle,
  RotateCw,
  ShieldAlert,
  Square,
  X,
} from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  formatKillSwitchLabel,
  type AutomationTakeoverState,
} from '../../../../shared/automation.ts'
import { EMPTY_BROWSER_STATE, type BrowserRequest } from '../../../../shared/browser.ts'
import type { IslandPresentationProps } from '../../plugins/registry.ts'
import './browser.css'
import { useWorkspaceStore } from '../../hooks/useWorkspace.ts'
import { useWorkspaceTabs } from '../workspace-tabs/WorkspaceTabsProvider.tsx'

function displayAddress(value: typeof EMPTY_BROWSER_STATE): string {
  return value.previewPath || value.url
}

function BrowserTakeoverBar() {
  const automation = window.dshDesktop?.automation
  const [takeover, setTakeover] = useState<AutomationTakeoverState | null>(null)
  const [stopping, setStopping] = useState(false)
  const [stopError, setStopError] = useState('')
  useEffect(() => {
    if (!automation) return
    let mounted = true
    void automation
      .status()
      .then(status => {
        if (mounted) setTakeover(status.takeover)
      })
      .catch(() => {})
    const off = automation.onStateChanged(next => {
      if (mounted) {
        setTakeover(next)
        if (!next.active) setStopError('')
      }
    })
    return () => {
      mounted = false
      off()
    }
  }, [automation])
  if (!automation || !takeover?.active || takeover.kind !== 'embedded-browser') return null
  const killLabel = formatKillSwitchLabel(takeover.killSwitchShortcut)
  const summary =
    stopError || `AI 正在控制内置浏览器（第 ${takeover.stepCount} 步）· 可随时按 ${killLabel} 急停`
  return (
    <div className="browser-takeover-bar" role="status" aria-live="polite">
      <ShieldAlert size={13} aria-hidden="true" />
      <span title={summary}>{summary}</span>
      <button
        type="button"
        disabled={stopping}
        onClick={() => {
          setStopping(true)
          setStopError('')
          void automation
            .stopTakeover()
            .catch(() => {
              setStopError('停止接管失败，请重试或按急停快捷键')
            })
            .finally(() => {
              setStopping(false)
            })
        }}
      >
        <Square size={11} aria-hidden="true" />
        <span>{stopping ? '停止中…' : '停止接管'}</span>
      </button>
    </div>
  )
}

export function BrowserPanel({
  visibility,
  tabId = 'default',
}: IslandPresentationProps & { tabId?: string }) {
  const tabs = useWorkspaceTabs()
  const store = useWorkspaceStore()
  const selectBrowser = tabs?.selectBrowser
  const activate = useRef<() => void>(() => {})
  activate.current = () => {
    const id = `browser:${tabId}`
    if (tabs?.split?.includes(id)) tabs.focus(id)
    else {
      selectBrowser?.(tabId)
      store.setView('browser')
    }
  }
  const bridge = window.dshDesktop?.browser
  const api = useMemo(
    () =>
      bridge === undefined
        ? undefined
        : {
            request: (request: BrowserRequest) => bridge.request({ ...request, tabId }),
            onChanged: (listener: (value: typeof EMPTY_BROWSER_STATE) => void) =>
              bridge.onChanged(value => {
                if ((value.tabId ?? 'default') === tabId) listener(value)
              }),
          },
    [bridge, tabId],
  )
  const [state, setState] = useState(EMPTY_BROWSER_STATE)
  const [hydrated, setHydrated] = useState(false)
  const [address, setAddress] = useState('')
  const [error, setError] = useState('')
  const viewport = useRef<HTMLDivElement>(null)
  const alive = useRef(true)
  const latestUrl = useRef('')
  const updateBrowser = tabs?.updateBrowser
  const previewPath = state.previewPath ?? null
  const previewName = previewPath?.split('/').at(-1) ?? ''
  useEffect(() => {
    const resolvedTitle = state.title || previewName || state.url
    if (!hydrated && !resolvedTitle) return
    updateBrowser?.(tabId, resolvedTitle || '新网页')
  }, [hydrated, previewName, state.title, state.url, tabId, updateBrowser])
  useEffect(() => {
    alive.current = true
    setHydrated(false)
    void api
      ?.request({ action: 'read' })
      .then(value => {
        if (alive.current) {
          setHydrated(true)
          setState(value)
          const shown = displayAddress(value)
          setAddress(shown)
          latestUrl.current = shown
        }
      })
      .catch(caught => {
        if (alive.current) setError(caught instanceof Error ? caught.message : '无法读取浏览器状态')
      })
    const off = api?.onChanged(value => {
      if (alive.current) {
        setHydrated(true)
        if (value.focused) activate.current()
        setState(value)
        const shown = displayAddress(value)
        if (shown !== latestUrl.current) {
          latestUrl.current = shown
          setAddress(shown)
        }
      }
    })
    return () => {
      alive.current = false
      off?.()
      void api?.request({ action: 'layout', visible: false }).catch(() => {})
    }
  }, [api, tabId])
  const request = (value: BrowserRequest) => {
    setError('')
    void api
      ?.request(value)
      .then(next => {
        if (alive.current) {
          setState(next)
          if (value.action !== 'read') {
            const shown = displayAddress(next)
            latestUrl.current = shown
            setAddress(shown)
          }
        }
      })
      .catch(caught => {
        if (alive.current) setError(caught instanceof Error ? caught.message : '浏览器操作失败')
      })
  }
  useLayoutEffect(() => {
    const element = viewport.current
    if (!element || !api) return
    let frame = 0
    let last = ''
    const workbenchBlocksPage = () =>
      document.body.hasAttribute('data-workbench-dragging') ||
      document.body.hasAttribute('data-workbench-resizing') ||
      Boolean(element.closest('[data-layout-moving]'))
    const update = () => {
      if (workbenchBlocksPage()) {
        cancelAnimationFrame(frame)
        frame = 0
        if (last !== 'hidden') {
          last = 'hidden'
          void api.request({ action: 'layout', visible: false }).catch(() => {})
        }
        return
      }
      // 高频拖动和玻璃材质更新合并到已有帧，不能反复延期网页布局。
      if (frame !== 0) return
      frame = requestAnimationFrame(() => {
        frame = 0
        const rect = element.getBoundingClientRect()
        const overlay =
          workbenchBlocksPage() ||
          [
            // AnchoredMenu 在退出交互后继续绘制，直到卸载才让出网页区域。
            ...document.querySelectorAll<HTMLElement>(
              'dialog[open], [role="dialog"], [role="menu"], [role="listbox"], [data-menu-motion], .quick-open-backdrop, .project-search-backdrop, .ant-modal-wrap, .ant-tooltip, .ant-popover, .ant-select-dropdown',
            ),
          ].some(node => {
            const style = getComputedStyle(node),
              bounds = node.getBoundingClientRect()
            return (
              node.getClientRects().length > 0 &&
              style.visibility !== 'hidden' &&
              style.display !== 'none' &&
              bounds.left < rect.right &&
              bounds.right > rect.left &&
              bounds.top < rect.bottom &&
              bounds.bottom > rect.top
            )
          })
        const show =
          visibility === 'foreground' &&
          !overlay &&
          rect.width > 1 &&
          rect.height > 1 &&
          !state.error &&
          !error
        const input: BrowserRequest = {
          action: 'layout',
          visible: Boolean(show),
          bounds: {
            x: Math.max(0, rect.x),
            y: Math.max(0, rect.y),
            width: rect.width,
            height: rect.height,
          },
        }
        const signature = JSON.stringify(input)
        if (signature === last) return
        last = signature
        void api.request(input).catch(() => {})
      })
    }
    const resize = new ResizeObserver(update)
    resize.observe(element)
    const mutation = new MutationObserver(update)
    mutation.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        'class',
        'style',
        'hidden',
        'aria-hidden',
        'open',
        'data-menu-motion',
        'data-workbench-dragging',
        'data-workbench-resizing',
        'data-layout-moving',
      ],
    })
    window.addEventListener('resize', update)
    document.addEventListener('visibilitychange', update)
    update()
    return () => {
      cancelAnimationFrame(frame)
      resize.disconnect()
      mutation.disconnect()
      window.removeEventListener('resize', update)
      document.removeEventListener('visibilitychange', update)
      void api.request({ action: 'layout', visible: false }).catch(() => {})
    }
  }, [api, visibility, state.error, state.url, error])
  return (
    <section className="browser-panel" aria-label="内置浏览器">
      <form
        className="browser-toolbar"
        onSubmit={event => {
          event.preventDefault()
          if (previewPath !== null && address.trim() === previewPath) {
            request({ action: 'reload' })
            return
          }
          request({ action: 'navigate', url: address })
        }}
      >
        <button
          type="button"
          className="browser-nav-button"
          aria-label="网页后退"
          title="后退"
          disabled={!state.canGoBack}
          onClick={() => {
            request({ action: 'back' })
          }}
        >
          <ArrowLeft size={15} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="browser-nav-button"
          aria-label="网页前进"
          title="前进"
          disabled={!state.canGoForward}
          onClick={() => {
            request({ action: 'forward' })
          }}
        >
          <ArrowRight size={15} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="browser-nav-button"
          aria-label={state.loading ? '停止加载网页' : '重新加载网页'}
          title={state.loading ? '停止加载' : '重新加载'}
          disabled={!state.url}
          onClick={() => {
            request({ action: state.loading ? 'stop' : 'reload' })
          }}
        >
          {state.loading ? (
            <X size={15} aria-hidden="true" />
          ) : (
            <RotateCw size={14} aria-hidden="true" />
          )}
        </button>
        {previewPath !== null && (
          <span className="browser-preview-badge" title={`本地项目预览：${previewPath}`}>
            本地预览
          </span>
        )}
        <div className="browser-address-field">
          <input
            type="text"
            inputMode="url"
            aria-label="网页地址"
            placeholder="输入网址或 localhost 地址"
            value={address}
            onChange={event => {
              setAddress(event.target.value)
            }}
            onFocus={event => {
              event.currentTarget.select()
            }}
          />
          <button
            type="submit"
            className="browser-go-button"
            aria-label="打开网页"
            title="前往输入的网址（Enter）"
            disabled={!address.trim() || !api}
          >
            <CornerDownLeft size={13} aria-hidden="true" />
            <span className="browser-action-label">前往</span>
          </button>
        </div>
        <button
          type="button"
          className="browser-external-button"
          aria-label="在系统浏览器中打开"
          title="在系统浏览器中打开当前网页"
          disabled={!state.url}
          onClick={() => {
            request({ action: 'external' })
          }}
        >
          <ExternalLink size={14} aria-hidden="true" />
          <span className="browser-action-label">外部打开</span>
        </button>
      </form>
      <BrowserTakeoverBar />
      {state.url && (
        <div className="browser-caption">
          {state.loading && <LoaderCircle size={12} className="spin" aria-hidden="true" />}
          <span title={previewPath ?? (state.title || state.url)}>
            {state.title || previewPath || state.url}
          </span>
          <button
            type="button"
            aria-label="关闭网页"
            title="关闭当前网页"
            onClick={() => {
              request({ action: 'close' })
            }}
          >
            <X size={13} aria-hidden="true" />
          </button>
        </div>
      )}
      <div className="browser-viewport" ref={viewport}>
        {error || state.error ? (
          <div className="browser-empty" role="alert">
            <Globe size={24} />
            <p>{error || state.error}</p>
            <button
              type="button"
              onClick={() => {
                request({ action: 'reload' })
              }}
            >
              重新加载
            </button>
          </div>
        ) : !state.url ? (
          <div className="browser-empty">
            <Globe size={28} />
            <strong>浏览网页与本地预览</strong>
            <p>
              {api
                ? '输入网址开始，网页会保留在当前窗口。'
                : '内置浏览器需要在 MyDSH 桌面应用中使用。'}
            </p>
          </div>
        ) : null}
      </div>
    </section>
  )
}
