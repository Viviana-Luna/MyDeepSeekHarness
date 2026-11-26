import {
  Check,
  ChevronDown,
  ChevronUp,
  Clock3,
  CornerDownLeft,
  ListOrdered,
  LoaderCircle,
  Pencil,
  X,
} from 'lucide-react'
import { useEffect, useId, useMemo, useState } from 'react'

import type {
  DesktopQueueSnapshot,
  DesktopSessionQueueAction,
} from '../../../../shared/session-live.ts'
import { DESKTOP_QUEUE_EDIT_MAX_BYTES } from '../../../../shared/session-live.ts'
import { IconButton } from '../../shared/ui/IconButton.tsx'
import styles from './QueueDock.module.css'

export interface QueueDockProps {
  readonly queue: DesktopQueueSnapshot
  readonly running: boolean
  readonly updatingIds: readonly string[]
  readonly onUpdate: (itemId: string, action: DesktopSessionQueueAction) => Promise<boolean>
}

function readOnlyReason(reason: 'non-text' | 'multiple-blocks' | 'text-too-large'): string {
  if (reason === 'multiple-blocks') return '消息由多个内容块组成，不能在桌面端无损编辑'
  if (reason === 'text-too-large') return '消息过长，只能移除或插入，不能在桌面端编辑'
  return '消息包含非文本内容，不能在桌面端编辑'
}

export function QueueDock({ queue, running, updatingIds, onUpdate }: QueueDockProps) {
  const visible = useMemo(
    () => queue.items.filter(item => item.placement !== 'context'),
    [queue.items],
  )
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [collapsed, setCollapsed] = useState(true)
  const listId = useId()

  useEffect(() => {
    if (editingId !== null && !visible.some(item => item.id === editingId)) {
      setEditingId(null)
      setDraft('')
    }
    if (visible.length === 0 && !collapsed) setCollapsed(true)
  }, [collapsed, editingId, visible])

  if (queue.totalCount === 0 || visible.length === 0) return null

  const interactionActive =
    editingId !== null || visible.some(item => updatingIds.includes(item.id))
  const expanded = !collapsed || interactionActive
  const listVisible = queue.totalCount === 1 || expanded

  const beginEdit = (item: (typeof visible)[number]) => {
    if (item.edit.kind !== 'editable-text') return
    setEditingId(item.id)
    setDraft(item.edit.text)
  }
  const closeEdit = () => {
    setEditingId(null)
    setDraft('')
  }
  const saveEdit = async (itemId: string) => {
    const accepted = await onUpdate(itemId, {
      kind: 'edit',
      content: [{ type: 'text', text: draft }],
    })
    if (accepted) closeEdit()
  }

  return (
    <section className={styles.dock} aria-label="消息队列">
      <div className={styles.panel}>
        {queue.totalCount > 1 && (
          <button
            className={styles.header}
            type="button"
            aria-controls={listId}
            aria-expanded={expanded}
            aria-label={expanded ? '收起待处理消息' : '展开待处理消息'}
            disabled={interactionActive}
            onClick={() => {
              setCollapsed(value => !value)
            }}
          >
            <span className={styles.lead} aria-hidden="true">
              <ListOrdered size={14} />
            </span>
            <span className={styles.count}>待处理消息</span>
            <span className={styles.badge}>{String(queue.totalCount)}</span>
            {!expanded && <span className={styles.summary}>{visible[0]?.preview}</span>}
            <span className={styles.chevron} aria-hidden="true">
              {expanded ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
            </span>
          </button>
        )}
        <ol id={listId} className={styles.list} aria-label="待处理消息列表" hidden={!listVisible}>
          {visible.map(item => {
            const queued = item.placement === 'queued'
            const updating = updatingIds.includes(item.id)
            const editing = editingId === item.id
            return (
              <li className={`${styles.item} ${queued ? '' : styles.steering}`} key={item.id}>
                <span className={styles.lead}>
                  {updating || !queued ? (
                    <LoaderCircle
                      className="spin"
                      size={14}
                      aria-label={updating ? '正在更新队列' : '正在插入当前轮'}
                    />
                  ) : (
                    <Clock3 size={14} aria-hidden="true" />
                  )}
                </span>
                {editing ? (
                  <div className={styles.editor}>
                    <input
                      type="text"
                      aria-label="编辑排队消息"
                      value={draft}
                      maxLength={DESKTOP_QUEUE_EDIT_MAX_BYTES}
                      disabled={updating}
                      onChange={event => {
                        setDraft(event.currentTarget.value)
                      }}
                      onKeyDown={event => {
                        if (event.key === 'Escape') closeEdit()
                        if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                          event.preventDefault()
                          void saveEdit(item.id)
                        }
                      }}
                    />
                    <div className={styles.editorActions}>
                      <IconButton
                        label="保存"
                        className={`${styles.action} ${styles.save}`}
                        disabled={updating || draft.trim() === ''}
                        onClick={() => {
                          void saveEdit(item.id)
                        }}
                      >
                        <Check size={14} aria-hidden="true" />
                      </IconButton>
                      <IconButton
                        label="取消"
                        className={styles.action}
                        disabled={updating}
                        onClick={closeEdit}
                      >
                        <X size={14} aria-hidden="true" />
                      </IconButton>
                    </div>
                  </div>
                ) : (
                  <p title={item.preview}>
                    {item.preview}
                    {item.previewTruncated ? '…' : ''}
                  </p>
                )}
                {queued && !editing && (
                  <div className={styles.actions}>
                    <IconButton
                      label="编辑"
                      className={styles.action}
                      disabled={updating || item.edit.kind !== 'editable-text'}
                      title={
                        item.edit.kind === 'read-only'
                          ? readOnlyReason(item.edit.reason)
                          : '编辑排队消息'
                      }
                      onClick={() => {
                        beginEdit(item)
                      }}
                    >
                      <Pencil size={14} aria-hidden="true" />
                    </IconButton>
                    <IconButton
                      label="移除"
                      className={`${styles.action} ${styles.remove}`}
                      disabled={updating}
                      title="从队列移除"
                      onClick={() => {
                        void onUpdate(item.id, { kind: 'remove' })
                      }}
                    >
                      <X size={14} aria-hidden="true" />
                    </IconButton>
                    {running && (
                      <IconButton
                        label="插入当前轮"
                        className={`${styles.action} ${styles.steer}`}
                        disabled={updating}
                        title="让这条消息进入当前轮"
                        onClick={() => {
                          void onUpdate(item.id, { kind: 'steer' })
                        }}
                      >
                        <CornerDownLeft size={14} aria-hidden="true" />
                      </IconButton>
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ol>
        {listVisible && queue.omittedCount > 0 && (
          <p className={styles.overflowNotice} role="status">
            另有 {queue.omittedCount} 条未显示；前面的消息处理后会自动出现。
          </p>
        )}
      </div>
    </section>
  )
}
