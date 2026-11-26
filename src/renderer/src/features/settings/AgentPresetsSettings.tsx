/**
 * Agent 预设设置页：展示内置与自定义预设卡片网格，支持切换默认预设、只读预览、复制、打开目录与删除。
 * 运行在 renderer；读写与文件目录操作通过工作台 Store 的受控 Host 动作完成，不持有长期订阅资源。
 */
import { Button, Tooltip } from 'antd'
import { Check, Copy, FileText, FolderOpen, Sparkles, Trash2 } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'

import { isRecord } from '../../../../shared/validation.ts'
import { useWorkspaceStore } from '../../hooks/useWorkspace.ts'
import {
  PresetCopyModal,
  PresetDeleteModal,
  PresetViewerModal,
  type PresetDocument,
} from './AgentPresetModals.tsx'
import {
  namespaceOf,
  type AgentPresetEntry,
  type AgentPresetRoster,
  type HostSettingsDocument,
  type HostSettingsPathOperation,
} from './settings-model.ts'
import { CapabilityNotice } from './SettingsPrimitives.tsx'
import './general-presets.css'

interface AgentPresetsSettingsProps {
  readonly document: HostSettingsDocument | null
  readonly roster: AgentPresetRoster | null
  readonly saving: string | null
  mutate(
    namespace: string,
    operations: readonly HostSettingsPathOperation[],
    label?: string,
  ): Promise<boolean>
  reload(): Promise<void>
}

interface PresetActionState {
  readonly kind: 'read' | 'copy' | 'open' | 'remove'
  readonly presetId: string
}

function parsePresetDocument(value: unknown): PresetDocument | null {
  if (
    !isRecord(value) ||
    typeof value.agentPreset !== 'string' ||
    (value.trust !== 'system' && value.trust !== 'user') ||
    typeof value.content !== 'string' ||
    value.content.length > 2_000_000
  ) {
    return null
  }
  const name = typeof value.name === 'string' ? value.name : undefined
  const description = typeof value.description === 'string' ? value.description : undefined
  return {
    agentPreset: value.agentPreset,
    trust: value.trust,
    content: value.content,
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
  }
}

function resolveDefaultPresetId(
  presetNamespace: ReturnType<typeof namespaceOf>,
  roster: AgentPresetRoster | null,
): string | undefined {
  const configured = presetNamespace?.value.default
  if (typeof configured === 'string' && configured !== 'wish' && configured !== 'mydsh') {
    return configured
  }
  return roster?.presets.find(preset => preset.isDefault)?.id
}

function useAgentPresetActions(reload: () => Promise<void>) {
  const store = useWorkspaceStore()
  const [activeAction, setActiveAction] = useState<PresetActionState | null>(null)
  const [viewer, setViewer] = useState<PresetDocument | null>(null)
  const [copyFrom, setCopyFrom] = useState<AgentPresetEntry | null>(null)
  const [removePreset, setRemovePreset] = useState<AgentPresetEntry | null>(null)
  const [localError, setLocalError] = useState<string | null>(null)
  const [modalError, setModalError] = useState<string | null>(null)
  const [openPath, setOpenPath] = useState<string | null>(null)

  const readPreset = async (preset: AgentPresetEntry) => {
    setActiveAction({ kind: 'read', presetId: preset.id })
    setLocalError(null)
    try {
      const result = parsePresetDocument(
        await store.callHost('readAgentPreset', { agentPreset: preset.id }),
      )
      if (result === null) throw new Error('运行核心返回了无法识别的预设文档')
      setViewer(result)
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : '读取 Agent 预设失败')
    } finally {
      setActiveAction(null)
    }
  }

  const copyPreset = async (agentPreset: string, name: string) => {
    if (copyFrom === null) return
    setActiveAction({ kind: 'copy', presetId: copyFrom.id })
    setModalError(null)
    try {
      await store.callHost('copyAgentPreset', {
        from: copyFrom.id,
        agentPreset,
        ...(name === '' ? {} : { name }),
      })
      setCopyFrom(null)
      await reload()
    } catch (error) {
      setModalError(error instanceof Error ? error.message : '复制 Agent 预设失败')
    } finally {
      setActiveAction(null)
    }
  }

  const openPreset = async (preset: AgentPresetEntry) => {
    setActiveAction({ kind: 'open', presetId: preset.id })
    setLocalError(null)
    setOpenPath(null)
    try {
      const result = await store.callHost('openAgentPreset', { agentPreset: preset.id })
      if (isRecord(result) && result.opened === false && typeof result.path === 'string') {
        setOpenPath(result.path)
      }
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : '打开 Agent 预设失败')
    } finally {
      setActiveAction(null)
    }
  }

  const confirmRemove = async () => {
    if (removePreset === null) return
    const target = removePreset
    setActiveAction({ kind: 'remove', presetId: target.id })
    setModalError(null)
    try {
      await store.callHost('removeAgentPreset', { agentPreset: target.id })
      setRemovePreset(null)
      if (viewer?.agentPreset === target.id) setViewer(null)
      await reload()
    } catch (error) {
      setModalError(error instanceof Error ? error.message : '删除 Agent 预设失败')
    } finally {
      setActiveAction(null)
    }
  }

  const createWithAgent = () => {
    setLocalError(null)
    void store.createSession(undefined, 'standard').then(created => {
      if (created) store.closeSettings()
      else setLocalError('无法创建会话，请检查运行核心状态后重试。')
    })
  }

  return {
    activeAction,
    viewer,
    copyFrom,
    removePreset,
    localError,
    modalError,
    openPath,
    readPreset,
    copyPreset,
    openPreset,
    confirmRemove,
    createWithAgent,
    closeViewer: () => {
      setViewer(null)
    },
    startCopy: (preset: AgentPresetEntry) => {
      setModalError(null)
      setCopyFrom(preset)
    },
    cancelCopy: () => {
      if (activeAction?.kind !== 'copy') {
        setModalError(null)
        setCopyFrom(null)
      }
    },
    startRemove: (preset: AgentPresetEntry) => {
      setModalError(null)
      setRemovePreset(preset)
    },
    cancelRemove: () => {
      if (activeAction?.kind !== 'remove') {
        setModalError(null)
        setRemovePreset(null)
      }
    },
  }
}

function PresetCard({
  preset,
  roster,
  busy,
  activeAction,
  selected,
  canSelect,
  onSelect,
  onRead,
  onCopy,
  onOpen,
  onRemove,
}: {
  readonly preset: AgentPresetEntry
  readonly roster: AgentPresetRoster
  readonly busy: boolean
  readonly activeAction: PresetActionState | null
  readonly selected: boolean
  readonly canSelect: boolean
  onSelect(): void
  onRead(): void
  onCopy(): void
  onOpen(): void
  onRemove(): void
}) {
  const displayName = preset.name ?? preset.id
  const trustLabel = preset.trust === 'system' ? '内置' : '自定义'
  const selectLabel = selected ? `当前使用: ${displayName}` : `设为默认: ${displayName}`
  const isReadingThis = activeAction?.kind === 'read' && activeAction.presetId === preset.id
  const isOpeningThis = activeAction?.kind === 'open' && activeAction.presetId === preset.id

  return (
    <article
      className="settings-preset-card"
      data-broken={preset.broken === undefined ? undefined : true}
      data-selected={selected || undefined}
    >
      <button
        className="settings-preset-select"
        type="button"
        aria-label={selectLabel}
        aria-pressed={selected}
        disabled={!canSelect || selected || preset.broken !== undefined}
        onClick={onSelect}
      >
        <div className="gp-preset-card__head">
          <div className="gp-preset-card__title-group">
            <strong title={displayName}>{displayName}</strong>
            <span className="gp-preset-trust-badge" data-trust={preset.trust}>
              {trustLabel}
            </span>
          </div>
          {selected && (
            <span className="gp-preset-default-pill">
              <Check size={12} aria-hidden="true" />
              <span>当前默认</span>
            </span>
          )}
        </div>
        {preset.description !== undefined && (
          <p className="gp-preset-card__desc">{preset.description}</p>
        )}
        {preset.broken !== undefined && (
          <span className="settings-inline-error">{preset.broken}</span>
        )}
      </button>

      <div className="settings-card-actions">
        <code className="gp-preset-card__id" title={preset.id}>
          {preset.id}
        </code>
        <div className="gp-preset-card__tools">
          {preset.broken === undefined && (
            <Tooltip title="查看定义">
              <Button
                className="gp-preset-action-btn"
                type="text"
                size="small"
                aria-label={`查看: ${displayName}`}
                disabled={busy}
                loading={isReadingThis}
                icon={<FileText size={14} aria-hidden="true" />}
                onClick={onRead}
              />
            </Tooltip>
          )}
          {roster.authorable && (
            <Tooltip title="复制预设">
              <Button
                className="gp-preset-action-btn"
                type="text"
                size="small"
                aria-label={`复制: ${displayName}`}
                disabled={busy || preset.broken !== undefined}
                icon={<Copy size={14} aria-hidden="true" />}
                onClick={onCopy}
              />
            </Tooltip>
          )}
          {preset.trust === 'user' && (
            <>
              <Tooltip title="打开目录">
                <Button
                  className="gp-preset-action-btn"
                  type="text"
                  size="small"
                  aria-label={`打开目录: ${displayName}`}
                  disabled={busy}
                  loading={isOpeningThis}
                  icon={<FolderOpen size={14} aria-hidden="true" />}
                  onClick={onOpen}
                />
              </Tooltip>
              <Tooltip title="删除预设">
                <Button
                  className="gp-preset-action-btn gp-preset-action-btn--danger"
                  type="text"
                  size="small"
                  danger
                  aria-label={`删除: ${displayName}`}
                  disabled={busy}
                  icon={<Trash2 size={14} aria-hidden="true" />}
                  onClick={onRemove}
                />
              </Tooltip>
            </>
          )}
        </div>
      </div>
    </article>
  )
}

function PresetGroupSection({
  title,
  count,
  headerAction,
  emptyState,
  children,
}: {
  readonly title: string
  readonly count: number
  readonly headerAction?: ReactNode
  readonly emptyState?: ReactNode
  readonly children: ReactNode
}) {
  const headingId = `settings-preset-group-${title}`
  return (
    <section className="settings-preset-group" aria-labelledby={headingId}>
      <header className="gp-preset-group__header">
        <div className="gp-preset-group__title">
          <h3 id={headingId}>{title}</h3>
          <span className="settings-count-pill">{count}</span>
        </div>
        {headerAction}
      </header>
      {count > 0 ? <div className="settings-preset-list">{children}</div> : emptyState}
    </section>
  )
}

/** 渲染「Agent 预设」设置页，管理内置与自定义预设及预览、复制、删除弹窗。 */
export function AgentPresetsSettings({
  document,
  roster,
  saving,
  mutate,
  reload,
}: AgentPresetsSettingsProps) {
  const actions = useAgentPresetActions(reload)
  const presetNamespace = namespaceOf(document, 'agent-presets')
  const defaultPreset = resolveDefaultPresetId(presetNamespace, roster)
  const busy = saving !== null || actions.activeAction !== null
  const canSelectDefault = presetNamespace !== undefined && document?.writable === true && !busy
  const existingIds = useMemo(
    () => new Set((roster?.presets ?? []).map(preset => preset.id)),
    [roster],
  )
  const systemPresets = roster?.presets.filter(preset => preset.trust === 'system') ?? []
  const userPresets = roster?.presets.filter(preset => preset.trust === 'user') ?? []

  const renderCards = (presets: readonly AgentPresetEntry[]) =>
    presets.map(preset => (
      <PresetCard
        key={preset.id}
        preset={preset}
        roster={roster!}
        busy={busy}
        activeAction={actions.activeAction}
        selected={preset.id === defaultPreset}
        canSelect={canSelectDefault}
        onSelect={() => {
          if (presetNamespace === undefined) return
          void mutate(
            presetNamespace.ns,
            [{ op: 'set', path: ['default'], value: preset.id }],
            'agent-preset',
          )
        }}
        onRead={() => {
          void actions.readPreset(preset)
        }}
        onCopy={() => {
          actions.startCopy(preset)
        }}
        onOpen={() => {
          void actions.openPreset(preset)
        }}
        onRemove={() => {
          actions.startRemove(preset)
        }}
      />
    ))

  return (
    <div className="settings-page gp-presets-page" aria-labelledby="settings-presets-title">
      <header className="settings-page__heading">
        <h2 id="settings-presets-title">Agent 预设</h2>
        <p>
          预设决定新会话中 Agent
          的工具、提示词与能力组合。点击卡片设为默认，或复制已有预设进行定制。
        </p>
      </header>

      {roster === null ? (
        <CapabilityNotice title="Agent 预设能力不可用" tone="warning">
          暂无可用的预设清单；已有会话可以继续运行。
        </CapabilityNotice>
      ) : (
        <>
          {actions.localError !== null && (
            <CapabilityNotice title="操作未完成" tone="error">
              {actions.localError}
            </CapabilityNotice>
          )}
          {actions.openPath !== null && (
            <CapabilityNotice title="暂时无法打开预设目录">
              预设目录位于：<span className="settings-monospace">{actions.openPath}</span>
            </CapabilityNotice>
          )}

          <PresetGroupSection title="内置" count={systemPresets.length}>
            {renderCards(systemPresets)}
          </PresetGroupSection>

          <PresetGroupSection
            title="自定义"
            count={userPresets.length}
            headerAction={
              roster.authorable && (
                <Button
                  size="small"
                  icon={<Sparkles size={13} aria-hidden="true" />}
                  disabled={busy}
                  onClick={actions.createWithAgent}
                >
                  让 Agent 协助创作
                </Button>
              )
            }
            emptyState={
              <div className="gp-preset-empty" role="status">
                <span className="gp-preset-empty__icon" aria-hidden="true">
                  <Sparkles size={16} />
                </span>
                <div className="gp-preset-empty__copy">
                  <strong>暂无自定义预设</strong>
                  <small>
                    {roster.authorable
                      ? '可点击右上角“让 Agent 协助创作”，或从内置预设复制一份快速起步。'
                      : '当前环境未开放自定义预设创作。'}
                  </small>
                </div>
              </div>
            }
          >
            {renderCards(userPresets)}
          </PresetGroupSection>

          <PresetViewerModal viewer={actions.viewer} onClose={actions.closeViewer} />

          <PresetCopyModal
            source={actions.copyFrom}
            existingIds={existingIds}
            busy={actions.activeAction?.kind === 'copy'}
            error={actions.modalError}
            onCancel={actions.cancelCopy}
            onSubmit={(agentPreset, name) => {
              void actions.copyPreset(agentPreset, name)
            }}
          />

          <PresetDeleteModal
            preset={actions.removePreset}
            busy={actions.activeAction?.kind === 'remove'}
            error={actions.modalError}
            onCancel={actions.cancelRemove}
            onConfirm={() => {
              void actions.confirmRemove()
            }}
          />
        </>
      )}
    </div>
  )
}
