/**
 * 空会话预设胶囊与溢出菜单：在 renderer 呈现前四项常驻胶囊及“更多”菜单。
 * 选中状态由会话宿主持有，玻璃透镜仅负责位置、按压与拖拽视觉反馈。
 */
import { Check, ChevronDown } from 'lucide-react'
import { useCallback, useId, useRef, useState, type KeyboardEvent } from 'react'
import type { AgentPresetRoster } from '../../../../../features/settings/settings-model.ts'
import { AnchoredMenu } from '../../../../../shared/ui/AnchoredMenu.tsx'
import styles from './SessionPresetPicker.module.css'
import { usePresetGlass } from './usePresetGlass.ts'

const MAX_VISIBLE = 5

function moveFocus(event: KeyboardEvent<HTMLButtonElement>) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  const buttons = Array.from(
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
      'button:not(:disabled)',
    ) ?? [],
  )
  const index = buttons.indexOf(event.currentTarget)
  if (index < 0) return
  const direction = event.key === 'ArrowLeft' ? -1 : 1
  let next = (index + direction + buttons.length) % buttons.length
  if (event.key === 'Home') next = 0
  if (event.key === 'End') next = buttons.length - 1
  event.preventDefault()
  buttons[next]?.focus()
}

/** 保持前四项预设胶囊稳定，超出五项时将余项收纳进“更多预设”菜单。 */
export function SessionPresetPills({
  roster,
  selected,
  disabled,
  saving,
  onSelect,
}: {
  roster: AgentPresetRoster
  selected: string | undefined
  disabled: boolean
  saving: boolean
  onSelect: (id: string) => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const moreRef = useRef<HTMLButtonElement>(null)
  const menuId = useId()
  const closeMenu = useCallback(() => setMenuOpen(false), [])
  const hasOverflow = roster.presets.length > MAX_VISIBLE
  const visible = hasOverflow ? roster.presets.slice(0, MAX_VISIBLE - 1) : roster.presets
  const overflow = hasOverflow ? roster.presets.slice(MAX_VISIBLE - 1) : []
  const overflowSelection = overflow.find(preset => preset.id === selected)
  const interactive = !disabled && !saving
  const select = useCallback(
    (id: string) => {
      if (!disabled && !saving) onSelect(id)
    },
    [disabled, saving, onSelect],
  )
  const glass = usePresetGlass(selected, roster.presets, {
    interactive,
    onSelect: select,
  })
  const showMenu = menuOpen && hasOverflow && interactive

  return (
    <>
      <div className={styles.track} role="group" aria-label="Agent 预设" aria-busy={saving}>
        <div className={styles.options} ref={glass.root}>
          <div
            className={styles.material}
            data-preset-material=""
            ref={glass.material}
            aria-hidden="true"
          />
          <div className={styles.defs} ref={glass.defs} aria-hidden="true" />
          <div
            className={`tab-glass-lens ${styles.lens}`}
            ref={glass.lens}
            data-preset-lens=""
            aria-hidden="true"
            hidden
          />
          {visible.map(preset => (
            <button
              key={preset.id}
              type="button"
              className={styles.pill}
              data-preset-id={preset.id}
              aria-pressed={preset.id === selected}
              aria-disabled={saving || undefined}
              disabled={disabled || preset.broken !== undefined}
              title={preset.broken ?? preset.description ?? preset.name ?? preset.id}
              onClick={() => select(preset.id)}
              onKeyDown={moveFocus}
            >
              {preset.name ?? preset.id}
            </button>
          ))}
          {hasOverflow && (
            <button
              ref={moreRef}
              type="button"
              className={`${styles.pill} ${styles.more}`}
              aria-label="更多预设"
              aria-haspopup="menu"
              aria-expanded={showMenu}
              aria-controls={showMenu ? menuId : undefined}
              aria-pressed={overflowSelection !== undefined}
              aria-disabled={saving || undefined}
              disabled={disabled}
              title={
                overflowSelection
                  ? `当前预设：${overflowSelection.name ?? overflowSelection.id}`
                  : '更多预设'
              }
              onClick={() => {
                if (!saving) setMenuOpen(value => !value)
              }}
              onKeyDown={moveFocus}
            >
              更多 <ChevronDown size={12} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
      <AnchoredMenu
        id={menuId}
        open={showMenu}
        anchorRef={moreRef}
        align="end"
        side="bottom"
        motion="morph"
        className={styles.menu!}
        label="更多预设"
        onDismiss={closeMenu}
      >
        {overflow.map(preset => (
          <button
            key={preset.id}
            type="button"
            role="menuitemradio"
            aria-checked={preset.id === selected}
            disabled={preset.broken !== undefined}
            title={preset.broken ?? preset.description}
            onClick={() => {
              closeMenu()
              moreRef.current?.focus()
              select(preset.id)
            }}
          >
            <span>{preset.name ?? preset.id}</span>
            {preset.id === selected && <Check size={14} aria-hidden="true" />}
          </button>
        ))}
      </AnchoredMenu>
    </>
  )
}
