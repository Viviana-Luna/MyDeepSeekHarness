import { Ellipsis, Minus } from 'lucide-react'
import { Tooltip } from 'antd'
import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { useWorkspaceStore } from '../../../../hooks/useWorkspace.ts'
import type { IslandContribution } from '../../../../plugins/registry.ts'
import { PluginIconView } from '../../../../plugins/react.tsx'
import { AnchoredMenu } from '../../../../shared/ui/AnchoredMenu.tsx'

interface RightIslandTabsProps {
  readonly islands: readonly IslandContribution[]
  readonly activeIsland: IslandContribution | undefined
  readonly mainIslandId: string | undefined
}

/** 顶部标签只切换已有浮岛，面板内容与终端实例仍由宿主管理。 */
export function RightIslandTabs({ islands, activeIsland, mainIslandId }: RightIslandTabsProps) {
  const store = useWorkspaceStore()
  const headerRef = useRef<HTMLElement>(null)
  const stripRef = useRef<HTMLDivElement>(null)
  const moreRef = useRef<HTMLButtonElement>(null)
  const collapseRef = useRef<HTMLButtonElement>(null)
  const available = islands.filter(island => island.id !== mainIslandId && !island.contextual)
  const [visibleIds, setVisibleIds] = useState<string[]>(() =>
    activeIsland ? [activeIsland.id] : [],
  )
  const [menuOpen, setMenuOpen] = useState(false)
  const dismiss = useCallback(() => {
    setMenuOpen(false)
  }, [])
  useLayoutEffect(() => {
    const header = headerRef.current
    const strip = stripRef.current
    const collapse = collapseRef.current
    if (!header || !strip || !collapse) return
    const tabs = [...strip.querySelectorAll<HTMLButtonElement>('[data-tab-id]')]
    const update = () => {
      if (header.clientWidth === 0) return
      const gap = Number.parseFloat(getComputedStyle(strip).gap) || 0
      const headerGap = Number.parseFloat(getComputedStyle(header).gap) || 0
      const widths = tabs.map(tab => ({ id: tab.dataset.tabId!, width: tab.scrollWidth }))
      const fullWidth = header.clientWidth - collapse.offsetWidth - headerGap
      let next = widths.map(tab => tab.id)
      if (
        widths.reduce((sum, tab) => sum + tab.width, 0) + gap * Math.max(0, widths.length - 1) >
        fullWidth
      ) {
        const budget = Math.max(0, fullWidth - collapse.offsetWidth - headerGap)
        const selected = widths.find(tab => tab.id === activeIsland?.id) ?? widths[0]
        const kept = new Set(selected ? [selected.id] : [])
        let used = Math.min(selected?.width ?? 0, budget)
        for (const tab of widths) {
          if (kept.has(tab.id) || used + gap + tab.width > budget) continue
          kept.add(tab.id)
          used += gap + tab.width
        }
        next = widths.filter(tab => kept.has(tab.id)).map(tab => tab.id)
      }
      if (next.length === widths.length) setMenuOpen(false)
      setVisibleIds(previous => (previous.join('\0') === next.join('\0') ? previous : next))
    }
    update()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update)
    observer?.observe(header)
    tabs.forEach(tab => {
      observer?.observe(tab)
    })
    return () => {
      observer?.disconnect()
    }
  }, [activeIsland?.id, islands, mainIslandId])
  const overflow = available.filter(island => !visibleIds.includes(island.id))

  return (
    <header ref={headerRef} className="right-island-header">
      <div
        ref={stripRef}
        className="right-island-tabs"
        role="tablist"
        aria-label="右侧栏目"
        onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
          const current = available.findIndex(island => island.id === activeIsland?.id)
          const index =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? available.length - 1
                : (current + (event.key === 'ArrowRight' ? 1 : -1) + available.length) %
                  available.length
          const next = available[index]
          if (!next) return
          event.preventDefault()
          store.selectRightIsland(next.id)
          // 标签随当前面板挂载；提交后将键盘焦点交给新面板中的选中标签。
          requestAnimationFrame(() => {
            document
              .querySelector<HTMLButtonElement>(
                '.info-island .right-island-tabs [aria-selected="true"]',
              )
              ?.focus()
          })
        }}
      >
        {available.map(island => {
          const selected = island.id === activeIsland?.id
          const visible = visibleIds.includes(island.id)
          return (
            <Tooltip
              key={island.id}
              title={island.label}
              placement="bottom"
              trigger={['hover', 'focus']}
              mouseEnterDelay={0.3}
            >
              <button
                type="button"
                role="tab"
                aria-selected={selected}
                aria-label={island.label}
                data-tab-id={island.id}
                data-island-id={visible ? island.id : undefined}
                data-overflow={!visible || undefined}
                aria-hidden={!visible || undefined}
                inert={!visible}
                tabIndex={visible && selected ? 0 : -1}
                aria-controls={selected ? 'session-inspector' : undefined}
                onClick={() => {
                  if (!selected) store.selectRightIsland(island.id)
                }}
              >
                <PluginIconView
                  icon={island.icon}
                  name={island.label}
                  size={18}
                  strokeWidth={1.8}
                />
              </button>
            </Tooltip>
          )
        })}
      </div>
      {overflow.length > 0 && (
        <button
          ref={moreRef}
          className="right-island-more"
          type="button"
          aria-label="更多右侧栏目"
          title="更多右侧栏目"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => {
            setMenuOpen(open => !open)
          }}
        >
          <Ellipsis size={17} aria-hidden="true" />
        </button>
      )}
      <AnchoredMenu
        open={menuOpen && overflow.length > 0}
        anchorRef={moreRef}
        align="end"
        side="bottom"
        className="right-island-overflow-menu"
        label="更多右侧栏目"
        onDismiss={dismiss}
      >
        {overflow.map(island => (
          <button
            key={island.id}
            type="button"
            role="menuitem"
            data-island-id={island.id}
            onClick={() => {
              setMenuOpen(false)
              store.selectRightIsland(island.id)
            }}
          >
            {island.label}
          </button>
        ))}
      </AnchoredMenu>
      <button
        ref={collapseRef}
        className="right-island-collapse"
        type="button"
        aria-label="收起右侧栏目"
        title="收起右侧栏目"
        onClick={() => {
          store.toggleInformation()
        }}
      >
        <Minus size={17} aria-hidden="true" />
      </button>
    </header>
  )
}
