/**
 * Agent 预设弹窗组：提供只读定义预览弹窗、复制预设表单弹窗与删除确认弹窗。
 * 运行在 renderer；复制反馈定时器在弹窗关闭或组件卸载时清理。
 */
import { Button, Input, Modal } from 'antd'
import { AlertTriangle, Check, Copy } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import type { AgentPresetEntry } from './settings-model.ts'
import { CapabilityNotice } from './SettingsPrimitives.tsx'

/** 运行核心返回的单个 Agent 预设只读文档结构。 */
export interface PresetDocument {
  readonly agentPreset: string
  readonly trust: 'system' | 'user'
  readonly content: string
  readonly name?: string
  readonly description?: string
}

const PRESET_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/u

function sanitizePresetId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]/gu, '')
}

function validatePresetId(
  value: string,
  existingIds: ReadonlySet<string>,
): { readonly valid: boolean; readonly message: string; readonly isError: boolean } {
  if (value === '') {
    return {
      valid: false,
      message: '仅支持小写字母、数字和连字符，且需以字母或数字开头。',
      isError: false,
    }
  }
  if (!PRESET_ID_PATTERN.test(value)) {
    return {
      valid: false,
      message: '预设 ID 必须以小写字母或数字开头，不能以连字符开头。',
      isError: true,
    }
  }
  if (existingIds.has(value)) {
    return {
      valid: false,
      message: '该预设 ID 已存在，请更换其他标识。',
      isError: true,
    }
  }
  return {
    valid: true,
    message: '可用作本地自定义预设的目录标识。',
    isError: false,
  }
}

/** 渲染 Agent 预设只读预览弹窗，支持一键复制预设定义文本。 */
export function PresetViewerModal({
  viewer,
  onClose,
}: {
  readonly viewer: PresetDocument | null
  onClose(): void
}) {
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    setCopied(false)
    setCopyError(null)
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [viewer])

  const handleCopy = async () => {
    if (viewer === null) return
    setCopyError(null)
    try {
      await navigator.clipboard.writeText(viewer.content)
      setCopied(true)
      if (timerRef.current !== null) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => {
        setCopied(false)
        timerRef.current = null
      }, 2000)
    } catch {
      setCopyError('无法写入剪贴板，请手动选中下方内容复制。')
    }
  }

  const displayName = viewer?.name ?? viewer?.agentPreset ?? '预设定义'
  const trustLabel = viewer?.trust === 'system' ? '内置' : '自定义'
  const lineCount = viewer === null ? 0 : viewer.content.split(/\r?\n/u).length

  return (
    <Modal
      open={viewer !== null}
      centered
      destroyOnHidden
      width="min(680px, calc(100vw - 32px))"
      classNames={{
        container: 'mydsh-glass-dialog',
        mask: 'mydsh-glass-mask',
      }}
      focusable={{ trap: true, focusTriggerAfterClose: true }}
      title={
        <div className="gp-viewer-modal-title">
          <strong>{displayName}</strong>
          {viewer !== null && (
            <span className="gp-preset-trust-badge" data-trust={viewer.trust}>
              {trustLabel}
            </span>
          )}
          <span className="gp-viewer-readonly-tag">只读</span>
        </div>
      }
      footer={<Button onClick={onClose}>关闭</Button>}
      onCancel={onClose}
    >
      {viewer !== null && (
        <div className="gp-viewer-modal-body">
          {viewer.description !== undefined && (
            <p className="gp-viewer-modal-desc">{viewer.description}</p>
          )}
          {copyError !== null && (
            <p className="settings-inline-error" role="alert">
              {copyError}
            </p>
          )}
          <div className="gp-viewer-code-frame">
            <div className="gp-viewer-code-toolbar">
              <div className="gp-viewer-code-meta">
                <code>{viewer.agentPreset}</code>
                <span>{lineCount} 行</span>
              </div>
              <Button
                size="small"
                type={copied ? 'primary' : 'default'}
                icon={
                  copied ? (
                    <Check size={13} aria-hidden="true" />
                  ) : (
                    <Copy size={13} aria-hidden="true" />
                  )
                }
                onClick={() => {
                  void handleCopy()
                }}
              >
                {copied ? '已复制' : '复制内容'}
              </Button>
            </div>
            <pre className="gp-viewer-code-scroll">
              <code>{viewer.content}</code>
            </pre>
          </div>
        </div>
      )}
    </Modal>
  )
}

/** 渲染复制 Agent 预设的表单弹窗，包含 ID 实时清洗与唯一性校验。 */
export function PresetCopyModal({
  source,
  existingIds,
  busy,
  error,
  onCancel,
  onSubmit,
}: {
  readonly source: AgentPresetEntry | null
  readonly existingIds: ReadonlySet<string>
  readonly busy: boolean
  readonly error: string | null
  onCancel(): void
  onSubmit(agentPreset: string, name: string): void
}) {
  const [copyId, setCopyId] = useState('')
  const [copyName, setCopyName] = useState('')

  useEffect(() => {
    if (source === null) {
      setCopyId('')
      setCopyName('')
      return
    }
    setCopyId(sanitizePresetId(`${source.id}-copy`))
    setCopyName(`${source.name ?? source.id} 副本`)
  }, [source])

  const validation = validatePresetId(copyId, existingIds)
  const canSubmit = source !== null && !busy && validation.valid
  const sourceTitle = source?.name ?? source?.id ?? ''

  const submitCopy = () => {
    if (!canSubmit) return
    onSubmit(copyId, copyName.trim())
  }

  return (
    <Modal
      open={source !== null}
      centered
      destroyOnHidden
      width="min(460px, calc(100vw - 32px))"
      classNames={{
        container: 'mydsh-glass-dialog',
        mask: 'mydsh-glass-mask',
      }}
      focusable={{ trap: true, focusTriggerAfterClose: true }}
      title={`复制“${sourceTitle}”`}
      okText="创建副本"
      cancelText="取消"
      okButtonProps={{
        icon: <Copy size={14} aria-hidden="true" />,
        disabled: !canSubmit,
      }}
      cancelButtonProps={{ disabled: busy }}
      confirmLoading={busy}
      onCancel={onCancel}
      onOk={submitCopy}
    >
      <form
        className="gp-copy-modal-form"
        onSubmit={event => {
          event.preventDefault()
          submitCopy()
        }}
      >
        <p className="gp-copy-modal-lead">
          复制会保留整个预设目录及其中的配置，创建后可在本地目录中自由编辑。
        </p>

        <div className="gp-form-field">
          <label htmlFor="preset-copy-id">预设 ID</label>
          <Input
            id="preset-copy-id"
            value={copyId}
            placeholder="my-preset"
            status={validation.isError ? 'error' : ''}
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
            onChange={event => {
              setCopyId(sanitizePresetId(event.target.value))
            }}
          />
          <small
            className={validation.isError ? 'gp-form-hint gp-form-hint--error' : 'gp-form-hint'}
          >
            {validation.message}
          </small>
        </div>

        <div className="gp-form-field">
          <label htmlFor="preset-copy-name">显示名称（可选）</label>
          <Input
            id="preset-copy-name"
            value={copyName}
            maxLength={160}
            placeholder="留空则使用预设 ID"
            disabled={busy}
            onChange={event => {
              setCopyName(event.target.value)
            }}
          />
        </div>

        {error !== null && (
          <CapabilityNotice title="复制未完成" tone="error">
            {error}
          </CapabilityNotice>
        )}
      </form>
    </Modal>
  )
}

/** 渲染删除本地自定义预设的红色危险确认弹窗。 */
export function PresetDeleteModal({
  preset,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  readonly preset: AgentPresetEntry | null
  readonly busy: boolean
  readonly error: string | null
  onCancel(): void
  onConfirm(): void
}) {
  const displayName = preset?.name ?? preset?.id ?? ''

  return (
    <Modal
      open={preset !== null}
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
          <span>删除“{displayName}”？</span>
        </span>
      }
      okText="确认删除"
      cancelText="取消"
      okButtonProps={{ danger: true, disabled: busy }}
      cancelButtonProps={{ disabled: busy }}
      confirmLoading={busy}
      onCancel={onCancel}
      onOk={onConfirm}
    >
      <div className="gp-danger-modal-body">
        <p>
          这将永久移除本地自定义预设目录
          {preset !== null && (
            <>
              （<code className="gp-inline-code">{preset.id}</code>）
            </>
          )}
          ，删除后无法恢复。内置预设不受影响。
        </p>
        {error !== null && (
          <CapabilityNotice title="删除未完成" tone="error">
            {error}
          </CapabilityNotice>
        )}
      </div>
    </Modal>
  )
}
