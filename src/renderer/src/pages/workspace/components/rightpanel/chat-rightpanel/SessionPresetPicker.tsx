/**
 * 空会话 Agent 预设选择器：从运行时读取真实预设目录，并在空会话阶段通过液态玻璃胶囊切换会话预设。
 * 运行在 renderer；仅维护异步请求代次，避免过期响应覆写当前会话状态。
 */
import { useEffect, useRef, useState } from 'react'
import { useWorkspaceSnapshot, useWorkspaceStore } from '../../../../../hooks/useWorkspace.ts'
import {
  parseAgentPresetRoster,
  type AgentPresetRoster,
} from '../../../../../features/settings/settings-model.ts'
import styles from './SessionPresetPicker.module.css'
import { SessionPresetPills } from './SessionPresetPills.tsx'

/**
 * 渲染当前空会话的 Agent 预设分段胶囊；会话开始后自动遵循核心锁定规则禁用切换。
 */
export function SessionPresetPicker() {
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
