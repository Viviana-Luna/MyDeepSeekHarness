/**
 * 通用设置页：配置新会话默认的 Agent 预设与权限，以及界面配色、运行时语言和繁忙时 Enter 行为。
 * 运行在 renderer；主机设置通过 `mutate` 写入后台，外观配色直接同步至桌面设置 Store，不持有外部资源。
 */
import { Modal } from 'antd'
import { AlertTriangle, Monitor, Moon, Sun } from 'lucide-react'
import { useState } from 'react'

import type { DesktopColorScheme } from '../../../../shared/appearance.ts'
import { permissionPresetLabel } from '../../domain/session-controls.ts'
import { useWorkspaceSnapshot, useWorkspaceStore } from '../../hooks/useWorkspace.ts'
import {
  enumStringsAtField,
  namespaceOf,
  preferenceOf,
  type AgentPresetEntry,
  type AgentPresetRoster,
  type HostSettingsDocument,
  type HostSettingsNamespace,
  type HostSettingsPathOperation,
} from './settings-model.ts'
import {
  CapabilityNotice,
  SettingRow,
  SettingsSection,
  SettingsSelect,
} from './SettingsPrimitives.tsx'
import './general-presets.css'

interface GeneralSettingsProps {
  readonly document: HostSettingsDocument | null
  readonly presetRoster: AgentPresetRoster | null
  readonly saving: string | null
  mutate(
    namespace: string,
    operations: readonly HostSettingsPathOperation[],
    label?: string,
  ): Promise<boolean>
}

const COLOR_SCHEMES: readonly {
  readonly id: DesktopColorScheme
  readonly label: string
  readonly icon: typeof Sun
}[] = [
  { id: 'light', label: '浅色', icon: Sun },
  { id: 'dark', label: '深色', icon: Moon },
  { id: 'system', label: '跟随系统', icon: Monitor },
]

function permissionLabel(value: string): string {
  return permissionPresetLabel(value, value)
}

function ColorSchemeSelector({
  current,
  onSelect,
}: {
  readonly current: DesktopColorScheme | undefined
  onSelect(scheme: DesktopColorScheme): void
}) {
  return (
    <div
      className="color-scheme-options gp-color-scheme-options"
      role="radiogroup"
      aria-label="外观配色"
    >
      {COLOR_SCHEMES.map(({ id, label, icon: Icon }) => {
        const selected = current === id
        const cardClassName = selected ? 'gp-scheme-card is-selected' : 'gp-scheme-card'
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={selected}
            className={cardClassName}
            onClick={() => {
              onSelect(id)
            }}
          >
            <span className="gp-scheme-preview" data-scheme={id} aria-hidden="true">
              <span className="gp-scheme-preview__sidebar" />
              <span className="gp-scheme-preview__canvas">
                <span className="gp-scheme-preview__bar" />
                <span className="gp-scheme-preview__line" />
                <span className="gp-scheme-preview__line gp-scheme-preview__line--short" />
              </span>
            </span>
            <span className="gp-scheme-card__label">
              <Icon size={14} aria-hidden="true" />
              <span>{label}</span>
            </span>
          </button>
        )
      })}
    </div>
  )
}

function FullAccessConfirmModal({
  open,
  writable,
  saving,
  onCancel,
  onConfirm,
}: {
  readonly open: boolean
  readonly writable: boolean
  readonly saving: boolean
  onCancel(): void
  onConfirm(): void
}) {
  return (
    <Modal
      open={open}
      centered
      destroyOnHidden
      width="min(440px, calc(100vw - 32px))"
      classNames={{
        container: 'mydsh-glass-dialog',
        mask: 'mydsh-glass-mask',
      }}
      focusable={{ trap: true, focusTriggerAfterClose: true }}
      title={
        <span className="gp-modal-danger-title">
          <AlertTriangle size={18} aria-hidden="true" />
          <span>允许新会话使用完全权限？</span>
        </span>
      }
      okText="确认使用完全权限"
      cancelText="取消"
      okButtonProps={{ danger: true, disabled: !writable || saving }}
      confirmLoading={saving}
      onCancel={onCancel}
      onOk={onConfirm}
    >
      <div className="gp-danger-modal-body">
        <p>
          启用后，随后新建的会话将跳过文件沙箱与人工审批，可直接修改文件、执行命令并访问工作区外的内容。
        </p>
        <div className="gp-danger-modal-callout" role="note">
          只有在你完全信任当前项目内容与模型行为时，才建议将其设为默认权限。
        </div>
      </div>
    </Modal>
  )
}

function SessionDefaultsSection({
  healthyPresets,
  presetNamespace,
  presetCurrent,
  permission,
  permissionCurrent,
  permissionOptions,
  disabled,
  onSelectPreset,
  onSelectPermission,
}: {
  readonly healthyPresets: readonly AgentPresetEntry[]
  readonly presetNamespace: HostSettingsNamespace | undefined
  readonly presetCurrent: string | undefined
  readonly permission: HostSettingsNamespace | undefined
  readonly permissionCurrent: string | undefined
  readonly permissionOptions: readonly string[]
  readonly disabled: boolean
  onSelectPreset(value: string): void
  onSelectPermission(value: string): void
}) {
  return (
    <SettingsSection title="新会话默认" description="仅应用于随后新建的会话，不影响已开始的对话。">
      {healthyPresets.length > 0 && (
        <SettingRow
          title="Agent 预设"
          description="只对随后新建的会话生效；当前会话保持开始时的组装。"
        >
          <SettingsSelect
            label="默认 Agent 预设"
            value={presetCurrent ?? ''}
            disabled={disabled || presetNamespace === undefined}
            placeholder="选择默认预设"
            options={healthyPresets.map(preset => ({
              value: preset.id,
              label: preset.name ?? preset.id,
            }))}
            onChange={onSelectPreset}
          />
        </SettingRow>
      )}

      {permission !== undefined && (
        <SettingRow title="默认权限" description="选择新会话的默认文件沙箱与审批策略。">
          <SettingsSelect
            label="默认权限"
            value={permissionCurrent ?? ''}
            disabled={disabled}
            placeholder="请选择权限"
            options={permissionOptions.map(value => ({
              value,
              label: permissionLabel(value),
            }))}
            onChange={onSelectPermission}
          />
        </SettingRow>
      )}
    </SettingsSection>
  )
}

function InterfaceInputSection({
  colorScheme,
  localeNamespace,
  locale,
  conversationNamespace,
  busyEnter,
  disabled,
  onSelectColorScheme,
  onSelectLocale,
  onSelectBusyEnter,
}: {
  readonly colorScheme: DesktopColorScheme | undefined
  readonly localeNamespace: HostSettingsNamespace | undefined
  readonly locale: string | undefined
  readonly conversationNamespace: HostSettingsNamespace | undefined
  readonly busyEnter: 'queue' | 'steer'
  readonly disabled: boolean
  onSelectColorScheme(scheme: DesktopColorScheme): void
  onSelectLocale(value: string): void
  onSelectBusyEnter(value: string): void
}) {
  return (
    <SettingsSection
      title="界面与输入"
      description="调整全局外观配色、运行核心语言与消息发送交互。"
    >
      <SettingRow
        title="外观配色"
        description="同时用于启动页与工作台。字体、字号与主题色可在“外观”分类中继续调整。"
        layout="vertical"
      >
        <ColorSchemeSelector current={colorScheme} onSelect={onSelectColorScheme} />
      </SettingRow>

      {localeNamespace !== undefined && (
        <SettingRow
          title="运行时语言"
          description="设置运行核心的语言偏好；MyDSH 界面保持简体中文。"
        >
          <SettingsSelect
            label="运行时语言"
            value={locale ?? 'auto'}
            disabled={disabled}
            options={[
              { value: 'auto', label: '自动' },
              { value: 'zh', label: '简体中文' },
              { value: 'en', label: 'English' },
            ]}
            onChange={onSelectLocale}
          />
        </SettingRow>
      )}

      {conversationNamespace !== undefined && (
        <SettingRow
          title="繁忙时 Enter 键行为"
          description="仅在智能体运行时生效；Cmd/Ctrl + Enter 使用另一种行为。"
        >
          <SettingsSelect
            label="繁忙时 Enter 键行为"
            value={busyEnter}
            disabled={disabled}
            options={[
              { value: 'queue', label: '排队发送' },
              { value: 'steer', label: '插话发送' },
            ]}
            onChange={onSelectBusyEnter}
          />
        </SettingRow>
      )}
    </SettingsSection>
  )
}

/** 渲染「通用设置」页，分为「新会话默认」与「界面与输入」两个分组卡片。 */
export function GeneralSettings({ document, presetRoster, saving, mutate }: GeneralSettingsProps) {
  const store = useWorkspaceStore()
  const snapshot = useWorkspaceSnapshot()
  const [pendingDanger, setPendingDanger] = useState(false)
  const writable = document?.writable === true
  const hostDisabled = !writable || saving !== null
  const permission = namespaceOf(document, 'permission', 'permissionPresets')
  const permissionCurrent =
    typeof permission?.value.defaultPreset === 'string' ? permission.value.defaultPreset : undefined
  const permissionOptions =
    permission === undefined
      ? []
      : [
          ...new Set([
            ...enumStringsAtField(permission.schema, 'defaultPreset'),
            ...(permissionCurrent === undefined ? [] : [permissionCurrent]),
          ]),
        ]
  const presetNamespace = namespaceOf(document, 'agent-presets')
  const presetCurrent =
    typeof presetNamespace?.value.default === 'string'
      ? presetNamespace.value.default
      : presetRoster?.presets.find(item => item.isDefault)?.id
  const healthyPresets = presetRoster?.presets.filter(item => item.broken === undefined) ?? []
  const localeNamespace = namespaceOf(document, 'locale')
  const locale = preferenceOf(document, 'locale', 'preference')
  const conversationNamespace = namespaceOf(document, 'ui-conversation')
  const storedBusyEnter = preferenceOf(document, 'ui-conversation', 'busyEnter')
  const busyEnter =
    storedBusyEnter === 'queue' || storedBusyEnter === 'steer'
      ? storedBusyEnter
      : snapshot.busyEnter
  const hasSessionDefaults = healthyPresets.length > 0 || permission !== undefined

  const choosePermission = (value: string) => {
    if (value === 'danger-full-access') {
      setPendingDanger(true)
      return
    }
    if (permission === undefined) return
    void mutate(permission.ns, [{ op: 'set', path: ['defaultPreset'], value }], 'permission')
  }

  const confirmFullAccess = () => {
    setPendingDanger(false)
    if (permission === undefined) return
    void mutate(
      permission.ns,
      [{ op: 'set', path: ['defaultPreset'], value: 'danger-full-access' }],
      'permission',
    )
  }

  return (
    <div className="settings-page" aria-labelledby="settings-general-title">
      <header className="settings-page__heading">
        <h2 id="settings-general-title">通用设置</h2>
        <p>配置新会话的默认预设、权限、界面配色与输入偏好。</p>
      </header>

      {document === null && (
        <CapabilityNotice title="运行时设置暂不可用" tone="warning">
          运行核心就绪后即可读取和保存偏好；桌面配色仍可在下方使用。
        </CapabilityNotice>
      )}

      {hasSessionDefaults && (
        <SessionDefaultsSection
          healthyPresets={healthyPresets}
          presetNamespace={presetNamespace}
          presetCurrent={presetCurrent}
          permission={permission}
          permissionCurrent={permissionCurrent}
          permissionOptions={permissionOptions}
          disabled={hostDisabled}
          onSelectPreset={value => {
            if (presetNamespace === undefined) return
            void mutate(
              presetNamespace.ns,
              [{ op: 'set', path: ['default'], value }],
              'agent-preset',
            )
          }}
          onSelectPermission={choosePermission}
        />
      )}

      <InterfaceInputSection
        colorScheme={snapshot.settings?.colorScheme}
        localeNamespace={localeNamespace}
        locale={locale}
        conversationNamespace={conversationNamespace}
        busyEnter={busyEnter}
        disabled={hostDisabled}
        onSelectColorScheme={scheme => {
          void store.updateSettings({ colorScheme: scheme })
        }}
        onSelectLocale={value => {
          if (localeNamespace === undefined) return
          void mutate(
            localeNamespace.ns,
            value === 'auto'
              ? [{ op: 'unset', path: ['preference'] }]
              : [{ op: 'set', path: ['preference'], value }],
            'locale',
          )
        }}
        onSelectBusyEnter={value => {
          if (conversationNamespace === undefined) return
          void mutate(
            conversationNamespace.ns,
            [{ op: 'set', path: ['busyEnter'], value }],
            'busy-enter',
          )
        }}
      />

      <FullAccessConfirmModal
        open={pendingDanger}
        writable={writable}
        saving={saving === 'permission'}
        onCancel={() => {
          setPendingDanger(false)
        }}
        onConfirm={confirmFullAccess}
      />
    </div>
  )
}
