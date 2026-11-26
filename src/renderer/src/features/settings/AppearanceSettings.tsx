/**
 * 外观设置页：管理界面字体、步进字号、主题色与缩放胶囊常驻偏好。
 * 运行在 renderer；设置变更经工作台 Store 写入 Electron 主进程并即时投影到界面。
 */
import { Switch } from 'antd'
import { Check, Minus, Palette, Plus } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'

import { DESKTOP_FONT_FAMILIES, DESKTOP_FONT_SIZE_RANGE } from '../../../../shared/appearance.ts'
import { useWorkspaceSnapshot, useWorkspaceStore } from '../../hooks/useWorkspace.ts'
import type { DesktopFontFamily } from '../../platform/contracts.ts'
import {
  ACCENT_PRESETS,
  FONT_PRESETS,
  accentContrastColor,
} from '../appearance/appearance-system.tsx'
import '../appearance/appearance.css'
import {
  CapabilityNotice,
  SettingRow,
  SettingsSection,
  SettingsSelect,
} from './SettingsPrimitives.tsx'

const NUMERIC_DRAFT = /^\s*-?\d+(?:\.\d+)?\s*$/u

function clampFontSize(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.round(value)))
}

function parseFontSizeDraft(draft: string): number | null {
  if (!NUMERIC_DRAFT.test(draft)) return null
  const parsed = Number(draft.trim())
  return Number.isFinite(parsed) ? parsed : null
}

function FontSizeStepper({
  value,
  minimum,
  maximum,
  onCommit,
}: {
  readonly value: number
  readonly minimum: number
  readonly maximum: number
  onCommit(value: number): void
}) {
  const [draft, setDraft] = useState(() => String(value))
  const [committed, setCommitted] = useState(value)
  const committedRef = useRef(value)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setDraft(String(value))
    setCommitted(value)
    committedRef.current = value
  }, [value])

  const commitValue = (candidate: number) => {
    const next = clampFontSize(candidate, minimum, maximum)
    setDraft(String(next))
    setCommitted(next)
    if (next === committedRef.current) return
    committedRef.current = next
    onCommit(next)
  }

  const commitDraft = () => {
    const parsed = parseFontSizeDraft(draft)
    if (parsed === null) {
      setDraft(String(committedRef.current))
      return
    }
    commitValue(parsed)
  }

  const stepBy = (delta: number) => {
    const base = parseFontSizeDraft(draft) ?? committedRef.current
    commitValue(base + delta)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      stepBy(1)
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      stepBy(-1)
      return
    }
    if (event.key === 'Home') {
      event.preventDefault()
      commitValue(minimum)
      return
    }
    if (event.key === 'End') {
      event.preventDefault()
      commitValue(maximum)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      commitDraft()
      return
    }
    if (event.key === 'Escape' && draft !== String(committedRef.current)) {
      // 存在未提交草稿时先撤销本次输入，避免直接关闭外层设置弹窗。
      event.stopPropagation()
      setDraft(String(committedRef.current))
    }
  }

  const parsedDraft = parseFontSizeDraft(draft)
  const effectiveValue =
    parsedDraft === null ? committed : clampFontSize(parsedDraft, minimum, maximum)

  return (
    <div className="font-size-control">
      <span className="font-size-control__range" aria-hidden="true">
        {minimum}–{maximum} px
      </span>
      <div className="font-size-stepper">
        <button
          className="font-size-stepper__button"
          type="button"
          aria-label="减小界面字号"
          disabled={effectiveValue <= minimum}
          onClick={() => {
            stepBy(-1)
          }}
        >
          <Minus size={13} aria-hidden="true" />
        </button>
        <div
          className="font-size-stepper__field"
          onClick={() => {
            inputRef.current?.focus()
          }}
        >
          <input
            ref={inputRef}
            className="font-size-stepper__input"
            type="text"
            inputMode="numeric"
            role="spinbutton"
            aria-label="界面字号"
            aria-valuemin={minimum}
            aria-valuemax={maximum}
            aria-valuenow={committed}
            aria-valuetext={`${String(committed)} px`}
            value={draft}
            onChange={event => {
              setDraft(event.currentTarget.value)
            }}
            onBlur={commitDraft}
            onKeyDown={handleKeyDown}
          />
          <span className="font-size-stepper__unit" aria-hidden="true">
            px
          </span>
        </div>
        <button
          className="font-size-stepper__button"
          type="button"
          aria-label="增大界面字号"
          disabled={effectiveValue >= maximum}
          onClick={() => {
            stepBy(1)
          }}
        >
          <Plus size={13} aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}

function AccentColorPicker({
  accentColor,
  onSelect,
}: {
  readonly accentColor: string
  onSelect(color: string): void
}) {
  const normalized = accentColor.toLowerCase()
  const displayHex = accentColor.toUpperCase()
  const isPreset = ACCENT_PRESETS.some(preset => preset.value === normalized)
  const customClass = isPreset ? 'accent-custom' : 'accent-custom is-selected'

  return (
    <div className="accent-picker">
      <span className="accent-value-pill" aria-label={`当前主题色 ${displayHex}`}>
        <span
          className="accent-value-pill__swatch"
          style={{ backgroundColor: accentColor }}
          aria-hidden="true"
        />
        <code>{displayHex}</code>
      </span>
      <div className="accent-options" role="radiogroup" aria-label="主题色">
        {ACCENT_PRESETS.map(preset => {
          const isSelected = normalized === preset.value
          const optionClass = isSelected ? 'accent-option is-selected' : 'accent-option'
          return (
            <button
              className={optionClass}
              key={preset.value}
              type="button"
              role="radio"
              title={`${preset.label} · ${preset.value.toUpperCase()}`}
              aria-label={preset.label}
              aria-checked={isSelected}
              style={{
                backgroundColor: preset.value,
                color: accentContrastColor(preset.value),
              }}
              onClick={() => {
                onSelect(preset.value)
              }}
            >
              {isSelected && <Check size={12} strokeWidth={2.75} aria-hidden="true" />}
            </button>
          )
        })}
        <label className={customClass} title="自定义主题色">
          <Palette size={13} aria-hidden="true" />
          <span className="visually-hidden">自定义主题色</span>
          <input
            aria-label="自定义主题色"
            type="color"
            value={accentColor}
            onChange={event => {
              onSelect(event.currentTarget.value)
            }}
          />
        </label>
      </div>
    </div>
  )
}

/** 外观设置页组件：提供界面字体、步进字号、主题色与缩放胶囊常驻配置。 */
export function AppearanceSettings() {
  const store = useWorkspaceStore()
  const snapshot = useWorkspaceSnapshot()
  const settings = snapshot.settings

  if (settings === null) {
    return (
      <div className="settings-page" aria-labelledby="settings-appearance-title">
        <header className="settings-page__heading">
          <h2 id="settings-appearance-title">外观</h2>
        </header>
        <CapabilityNotice title="正在读取桌面外观">
          设置由 Electron 主进程校验并保存在本机。
        </CapabilityNotice>
      </div>
    )
  }

  return (
    <div className="settings-page settings-appearance" aria-labelledby="settings-appearance-title">
      <header className="settings-page__heading">
        <h2 id="settings-appearance-title">外观</h2>
        <p>管理 MyDSH 的字体、字号、交互细节与主题色。</p>
      </header>

      {settings.warning !== undefined && (
        <CapabilityNotice title="部分外观设置已安全回退" tone="warning">
          {settings.warning}
        </CapabilityNotice>
      )}

      <SettingsSection title="字体与排版">
        <SettingRow title="界面字体" description={FONT_PRESETS[settings.fontFamily].detail}>
          <SettingsSelect
            label="界面字体"
            value={settings.fontFamily}
            options={DESKTOP_FONT_FAMILIES.map(id => ({
              value: id,
              label: FONT_PRESETS[id].label,
            }))}
            onChange={value => {
              void store.updateSettings({ fontFamily: value as DesktopFontFamily })
            }}
          />
        </SettingRow>
        <SettingRow title="界面字号" description="同步调整标题、正文、控件和辅助信息。">
          <FontSizeStepper
            value={settings.fontSize}
            minimum={DESKTOP_FONT_SIZE_RANGE.minimum}
            maximum={DESKTOP_FONT_SIZE_RANGE.maximum}
            onCommit={fontSize => {
              void store.updateSettings({ fontSize })
            }}
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title="主题与交互">
        <SettingRow title="主题色" description="用于主要按钮、选中状态与交互高亮。">
          <AccentColorPicker
            accentColor={settings.accentColor}
            onSelect={accentColor => {
              void store.updateSettings({ accentColor })
            }}
          />
        </SettingRow>
        <SettingRow
          title="缩放胶囊常驻"
          description="默认只在浮岛间隙悬停、键盘聚焦或拖动时显示；开启后始终显示。"
        >
          <Switch
            aria-label="缩放胶囊常驻"
            checked={snapshot.panelCapsulesPersistent}
            onChange={checked => {
              store.setPanelCapsulesPersistent(checked)
            }}
          />
        </SettingRow>
      </SettingsSection>
    </div>
  )
}
