import { Select } from 'antd'
import { useEffect, useRef, useState } from 'react'
import { useWorkspaceSnapshot, useWorkspaceStore } from '../../../../../hooks/useWorkspace.ts'
import {
  parseAgentPresetRoster,
  type AgentPresetRoster,
} from '../../../../../features/settings/settings-model.ts'
import styles from './SessionPresetPicker.module.css'
import { SessionPresetPills } from './SessionPresetPills.tsx'

export function SessionPresetPicker({ variant = 'select' }: { variant?: 'select' | 'pills' }) {
  const store = useWorkspaceStore()
  const snapshot = useWorkspaceSnapshot()
  const session = snapshot.sessions.find(item => item.sessionId === snapshot.selectedSessionId)
  const [roster, setRoster] = useState<AgentPresetRoster | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const generation = useRef(0)
  const savingRequest = useRef<symbol | null>(null)
  const ready = snapshot.hostStatus?.kind === 'ready'

  useEffect(() => {
    setSaving(false)
    return () => {
      savingRequest.current = null
    }
  }, [ready, snapshot.selectedSessionId])

  useEffect(() => {
    const current = ++generation.current
    setError(null)
    if (!ready) {
      setRoster(null)
      return
    }
    void store
      .callHost('listAgentPresets', {})
      .then(value => {
        if (current !== generation.current) return
        const result = parseAgentPresetRoster(value)
        if (result === null) throw new Error('无法读取 Agent 预设清单')
        setRoster(result)
      })
      .catch(cause => {
        if (current === generation.current)
          setError(cause instanceof Error ? cause.message : '读取预设失败')
      })
    return () => {
      generation.current += 1
    }
  }, [store, ready, snapshot.selectedSessionId, snapshot.pluginRevision])

  const projected = session?.projections?.values?.agentPreset
  const selected = typeof projected === 'string' ? projected : session?.agentPreset
  const currentPreset = selected ?? roster?.presets.find(preset => preset.isDefault)?.id
  const locked = session !== undefined && !session.blank
  const disabled =
    !ready ||
    roster === null ||
    snapshot.creatingSession ||
    session?.blank !== true ||
    session.running ||
    snapshot.sendingMessage ||
    snapshot.awaitingResponseSessionIds.includes(session.sessionId)
  const select = async (agentPreset: string) => {
    if (
      disabled ||
      savingRequest.current !== null ||
      session === undefined ||
      agentPreset === currentPreset
    )
      return
    const request = Symbol()
    savingRequest.current = request
    setSaving(true)
    setError(null)
    try {
      await store.callHost('selectSessionAgentPreset', {
        sessionId: session.sessionId,
        agentPreset,
      })
      await store.refreshSessions()
    } catch (cause) {
      if (savingRequest.current === request)
        setError(cause instanceof Error ? cause.message : '切换预设失败')
    } finally {
      if (savingRequest.current === request) {
        savingRequest.current = null
        setSaving(false)
      }
    }
  }

  if (variant === 'pills') {
    return (
      <section className={styles.preset} aria-label="会话预设">
        {roster !== null && (
          <SessionPresetPills
            roster={roster}
            selected={currentPreset}
            disabled={disabled}
            saving={saving}
            onSelect={id => {
              void select(id)
            }}
          />
        )}
        {error !== null && <p role="alert">{error}</p>}
      </section>
    )
  }

  return (
    <section className="session-preset-card" aria-label="会话预设">
      <Select<string>
        size="small"
        className="session-preset-select"
        aria-label="Agent 预设"
        value={currentPreset ?? null}
        placeholder={ready ? '正在读取预设…' : '运行核心未就绪'}
        title={locked ? '会话开始后无法更改，请新建会话选择其他预设。' : '选择 Agent 预设'}
        disabled={disabled || saving}
        {...(disabled || saving ? { open: false } : {})}
        loading={saving}
        virtual={false}
        showSearch={false}
        options={
          roster?.presets.map(preset => ({
            value: preset.id,
            label: preset.name ?? preset.id,
            disabled: preset.broken !== undefined,
            title: preset.broken ?? preset.description ?? preset.name ?? preset.id,
          })) ?? []
        }
        onChange={value => {
          void select(value)
        }}
      />
      <small>
        {locked ? '会话开始后预设已固定，新建会话可选择其他预设。' : '选择本次会话的 Agent 预设。'}
      </small>
      {error !== null && <p role="alert">{error}</p>}
    </section>
  )
}
