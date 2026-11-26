/**
 * 已归档会话设置页：支持按标题/项目筛选、多选批量删除、单个恢复与永久删除确认。
 * 运行在 renderer；恢复和删除均通过工作台 Store 调用核心接口，卸载时取消过期状态写入。
 */
import { Button, Checkbox, Modal } from 'antd'
import {
  Archive,
  ArchiveRestore,
  Folder,
  LoaderCircle,
  RotateCw,
  Search,
  Trash2,
  X,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { relativeTime, sessionTitle, type SessionSummary } from '../../domain/session.ts'
import { useWorkspaceSnapshot, useWorkspaceStore } from '../../hooks/useWorkspace.ts'
import { CapabilityNotice } from './SettingsPrimitives.tsx'

interface ArchivedRowItem {
  readonly id: string
  readonly session: SessionSummary | undefined
  readonly title: string
  readonly project: string
}

function ArchivedSessionRow({
  row,
  checked,
  disabled,
  canRestore,
  onToggle,
  onRestore,
  onDelete,
}: {
  readonly row: ArchivedRowItem
  readonly checked: boolean
  readonly disabled: boolean
  readonly canRestore: boolean
  onToggle(checked: boolean): void
  onRestore(): void
  onDelete(): void
}) {
  const { id, session, title, project } = row
  return (
    <li data-session-id={id} data-selected={checked || undefined}>
      <Checkbox
        aria-label={`选择归档会话: ${title}`}
        checked={checked}
        disabled={disabled}
        onChange={event => {
          onToggle(event.target.checked)
        }}
      />
      <div className="settings-archive-copy">
        <strong title={title}>{title}</strong>
        <div className="settings-archive-meta">
          <span className="settings-archive-project" title={project}>
            <Folder size={12} aria-hidden="true" />
            <span>{project}</span>
          </span>
          {session && (
            <span className="settings-archive-time">{relativeTime(session.updatedAt)}</span>
          )}
        </div>
      </div>
      <div className="settings-archive-actions">
        <Button
          size="small"
          aria-label={`恢复会话: ${title}`}
          disabled={disabled || !canRestore}
          icon={<ArchiveRestore size={14} aria-hidden="true" />}
          onClick={onRestore}
        >
          恢复
        </Button>
        <Button
          size="small"
          danger
          aria-label={`永久删除会话: ${title}`}
          disabled={disabled}
          icon={<Trash2 size={14} aria-hidden="true" />}
          onClick={onDelete}
        >
          永久删除
        </Button>
      </div>
    </li>
  )
}

function ArchivedDeleteModal({
  deleting,
  progress,
  deleteError,
  onCancel,
  onConfirm,
}: {
  readonly deleting: readonly { id: string; title: string }[] | null
  readonly progress: number | null
  readonly deleteError: string | null
  onCancel(): void
  onConfirm(): void
}) {
  return (
    <Modal
      classNames={{
        container: 'mydsh-glass-dialog',
        mask: 'mydsh-glass-mask',
      }}
      title={
        deleting && deleting.length > 1
          ? `永久删除 ${deleting.length} 个归档会话？`
          : '永久删除会话？'
      }
      open={deleting !== null}
      centered
      destroyOnHidden
      width={440}
      okText="永久删除"
      cancelText="取消"
      okButtonProps={{ danger: true }}
      confirmLoading={progress !== null}
      onCancel={onCancel}
      onOk={onConfirm}
    >
      <div className="settings-archive-modal-body">
        <p>
          {deleting?.length === 1
            ? `“${deleting[0]?.title}”的会话记录`
            : `所选 ${deleting?.length ?? 0} 个归档会话的记录`}
          将永久删除，无法恢复。仍在执行的任务会先停止，项目文件不受影响。
        </p>
        {deleting && deleting.length > 1 && (
          <ul className="settings-archive-delete-list">
            {deleting.map(row => (
              <li key={row.id}>{row.title}</li>
            ))}
          </ul>
        )}
        {progress !== null && (
          <p className="settings-archive-progress" role="status">
            已处理 {progress} / {deleting?.length ?? 0} 项
          </p>
        )}
        {deleteError !== null && (
          <CapabilityNotice title="删除未完成" tone="error">
            {deleteError}
          </CapabilityNotice>
        )}
      </div>
    </Modal>
  )
}

/** 已归档会话管理设置页：展示归档记录并支持筛选、恢复与永久删除。 */
export function ArchivedSessionsSettings() {
  const store = useWorkspaceStore()
  const snapshot = useWorkspaceSnapshot()
  const [query, setQuery] = useState('')
  const [deleting, setDeleting] = useState<readonly { id: string; title: string }[] | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [progress, setProgress] = useState<number | null>(null)
  const deletingRef = useRef(false)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    void store.refreshSessions()
    return () => {
      alive.current = false
    }
  }, [store])

  useEffect(() => {
    setSelected(
      current => new Set([...current].filter(id => snapshot.archivedSessionIds.includes(id))),
    )
  }, [snapshot.archivedSessionIds])

  const summaries = new Map(snapshot.archivedSessions.map(session => [session.sessionId, session]))
  const owners = new Map(
    snapshot.workspaces.flatMap(workspace =>
      workspace.sessionIds.map(id => [id, workspace.title] as const),
    ),
  )
  const rows: ArchivedRowItem[] = snapshot.archivedSessionIds.toReversed().map(id => {
    const session = summaries.get(id)
    return {
      id,
      session,
      title: session === undefined ? '未命名会话' : sessionTitle(session),
      project: owners.get(id) ?? '未分组',
    }
  })
  const search = query.trim().toLocaleLowerCase()
  const visibleRows = rows.filter(row =>
    `${row.title}\n${row.project}`.toLocaleLowerCase().includes(search),
  )
  const available = snapshot.sessionArchiveCapability === 'available'
  const selectedRows = visibleRows.filter(row => selected.has(row.id))

  const confirmDelete = async () => {
    if (deleting === null || deletingRef.current) return
    deletingRef.current = true
    setProgress(0)
    setDeleteError(null)
    const failed: (typeof deleting)[number][] = []
    const errors = new Set<string>()
    /* oxlint-disable no-await-in-loop -- 归档快照按顺序提交，避免并发覆盖。 */
    for (const [index, row] of deleting.entries()) {
      try {
        // 逐条复用核心删除契约，避免并发归档快照相互覆盖。
        if (!(await store.deleteArchivedSession(row.id, false)))
          throw new Error('会话状态已变化，请刷新后重试')
      } catch (error) {
        failed.push(row)
        errors.add(error instanceof Error ? error.message : '无法删除会话，请稍后重试')
      }
      if (alive.current) setProgress(index + 1)
    }
    /* oxlint-enable no-await-in-loop */
    await store.refreshSessions()
    deletingRef.current = false
    if (!alive.current) return
    setProgress(null)
    setSelected(new Set(failed.map(row => row.id)))
    setDeleting(failed.length === 0 ? null : failed)
    if (failed.length > 0) {
      setDeleteError(
        deleting.length === 1
          ? [...errors].join('；')
          : `已删除 ${deleting.length - failed.length} 项，${failed.length} 项未完成：${[...errors].join('；')}`,
      )
    }
  }

  return (
    <div className="settings-page">
      <header className="settings-page__heading">
        <div className="settings-heading-title-row">
          <h2>已归档会话</h2>
          {rows.length > 0 && <span className="settings-count-pill">共 {rows.length} 项</span>}
        </div>
        <p>恢复会话或永久删除不再需要的会话记录。</p>
      </header>

      <div className="settings-archive-toolbar">
        <div className="settings-archive-search">
          <Search size={15} className="settings-archive-search__icon" aria-hidden="true" />
          <input
            type="search"
            aria-label="搜索已归档会话"
            placeholder="搜索会话标题或所属项目"
            value={query}
            disabled={progress !== null}
            onChange={event => {
              setQuery(event.target.value)
              setSelected(new Set())
            }}
          />
          {query !== '' && (
            <button
              type="button"
              className="settings-archive-search__clear"
              aria-label="清空搜索"
              disabled={progress !== null}
              onClick={() => {
                setQuery('')
                setSelected(new Set())
              }}
            >
              <X size={13} aria-hidden="true" />
            </button>
          )}
        </div>
        <Button
          className="settings-archive-refresh"
          aria-label="刷新已归档会话"
          title="刷新已归档会话"
          disabled={snapshot.loadingSessions}
          icon={
            <RotateCw
              size={15}
              className={snapshot.loadingSessions ? 'spin' : undefined}
              aria-hidden="true"
            />
          }
          onClick={() => {
            void store.refreshSessions()
          }}
        />
      </div>

      {snapshot.error !== null && (
        <CapabilityNotice title="归档会话操作未完成" tone="error">
          {snapshot.error}
        </CapabilityNotice>
      )}

      {!available ? (
        <CapabilityNotice
          title={
            snapshot.sessionArchiveCapability === 'checking'
              ? '正在连接运行核心'
              : '归档会话暂不可用'
          }
        >
          连接成功后可以查看和恢复已归档的会话。
        </CapabilityNotice>
      ) : snapshot.loadingSessions && rows.length === 0 ? (
        <div className="settings-archive-surface">
          <div className="settings-archive-empty" role="status">
            <span className="settings-archive-empty__badge" aria-hidden="true">
              <LoaderCircle size={20} className="spin" />
            </span>
            <strong>正在读取已归档会话…</strong>
            <small>请稍候，正在同步项目归档记录。</small>
          </div>
        </div>
      ) : visibleRows.length === 0 ? (
        <div className="settings-archive-surface">
          <div className="settings-archive-empty" role="status">
            <span className="settings-archive-empty__badge" aria-hidden="true">
              {rows.length > 0 ? <Search size={20} /> : <Archive size={20} />}
            </span>
            <strong>
              {rows.length > 0
                ? '没有匹配的会话'
                : snapshot.archivedSessionIds.length > 0
                  ? '暂无可读取的归档会话'
                  : '暂无已归档会话'}
            </strong>
            <small>
              {rows.length > 0
                ? '尝试更换关键词，或清空搜索查看全部归档记录。'
                : '在左侧会话列表中归档的对话会显示在这里，方便日后恢复或清理。'}
            </small>
          </div>
        </div>
      ) : (
        <div className="settings-archive-surface">
          <div className="settings-archive-selection">
            <div className="settings-archive-selection__left">
              <Checkbox
                checked={selectedRows.length === visibleRows.length}
                indeterminate={selectedRows.length > 0 && selectedRows.length < visibleRows.length}
                disabled={progress !== null}
                onChange={event => {
                  setSelected(new Set(event.target.checked ? visibleRows.map(row => row.id) : []))
                }}
              >
                全选{search ? '搜索结果' : ''}
              </Checkbox>
              <span
                className="settings-archive-selection__count"
                data-active={selectedRows.length > 0 || undefined}
              >
                已选 {selectedRows.length} 项
              </span>
            </div>
            <div className="settings-archive-selection__actions">
              <Button
                size="small"
                type="text"
                disabled={selectedRows.length === 0 || progress !== null}
                onClick={() => {
                  setSelected(new Set())
                }}
              >
                取消选择
              </Button>
              <Button
                size="small"
                danger
                disabled={selectedRows.length === 0 || progress !== null}
                icon={<Trash2 size={14} />}
                onClick={() => {
                  store.clearError()
                  setDeleteError(null)
                  setDeleting(selectedRows)
                }}
              >
                删除所选
              </Button>
            </div>
          </div>

          <ul
            className="settings-archive-list"
            aria-label="已归档会话列表"
            aria-busy={snapshot.loadingSessions}
          >
            {visibleRows.map(row => (
              <ArchivedSessionRow
                key={row.id}
                row={row}
                checked={selected.has(row.id)}
                disabled={progress !== null || snapshot.archivingSessionIds.includes(row.id)}
                canRestore={row.session !== undefined}
                onToggle={isChecked => {
                  setSelected(current => {
                    const next = new Set(current)
                    if (isChecked) next.add(row.id)
                    else next.delete(row.id)
                    return next
                  })
                }}
                onRestore={() => {
                  void store.unarchiveSession(row.id)
                }}
                onDelete={() => {
                  store.clearError()
                  setDeleteError(null)
                  setDeleting([{ id: row.id, title: row.title }])
                }}
              />
            ))}
          </ul>
        </div>
      )}

      <ArchivedDeleteModal
        deleting={deleting}
        progress={progress}
        deleteError={deleteError}
        onCancel={() => {
          if (!deletingRef.current) setDeleting(null)
        }}
        onConfirm={() => {
          void confirmDelete()
        }}
      />
    </div>
  )
}
