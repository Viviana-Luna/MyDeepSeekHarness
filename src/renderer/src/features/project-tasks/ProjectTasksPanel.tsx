import { ArrowDown, ArrowUp, Copy, Pencil, Play, Plus, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import type {
  DesktopProjectTaskDefinition,
  DesktopProjectTaskSaveRequest,
} from '../../../../shared/project-tasks.ts'
import { useWorkspaceSnapshot } from '../../hooks/useWorkspace.ts'
import { AppAlert } from '../../shared/ui/AppAlert.tsx'
import { IconButton } from '../../shared/ui/IconButton.tsx'
import { useProjectTasks } from './ProjectTasksProvider.tsx'
import styles from './ProjectTasks.module.css'

type TaskDraft = Omit<DesktopProjectTaskSaveRequest, 'projectId'>

interface EditorSeed {
  key: string
  draft: TaskDraft
}

const EMPTY_DRAFT: TaskDraft = Object.freeze({
  name: '',
  executable: '',
  args: Object.freeze([]),
  cwd: '',
  env: Object.freeze({}),
  allowConcurrent: false,
})

function draftFromTask(task: DesktopProjectTaskDefinition, copy = false): TaskDraft {
  return {
    ...(copy ? {} : { taskId: task.id }),
    name: copy ? `${task.name} 副本` : task.name,
    executable: task.executable,
    args: [...task.args],
    cwd: task.cwd,
    env: { ...task.env },
    allowConcurrent: task.allowConcurrent,
  }
}

function parseEnvironment(value: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const raw of value.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    const separator = line.indexOf('=')
    if (separator <= 0) throw new Error(`环境变量“${line}”必须使用 KEY=VALUE 格式`)
    const key = line.slice(0, separator).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) throw new Error(`环境变量名“${key}”无效`)
    env[key] = line.slice(separator + 1)
  }
  return env
}

function TaskEditorDialog({
  seed,
  saving,
  serverError,
  onClearServerError,
  onClose,
  onSave,
}: {
  seed: EditorSeed | null
  saving: boolean
  serverError: string | null
  onClearServerError(): void
  onClose(): void
  onSave(draft: TaskDraft): Promise<boolean>
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [name, setName] = useState('')
  const [executable, setExecutable] = useState('')
  const [args, setArgs] = useState('')
  const [cwd, setCwd] = useState('')
  const [env, setEnv] = useState('')
  const [allowConcurrent, setAllowConcurrent] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog === null) return
    if (seed !== null) {
      setName(seed.draft.name)
      setExecutable(seed.draft.executable)
      setArgs(seed.draft.args.join('\n'))
      setCwd(seed.draft.cwd)
      setEnv(
        Object.entries(seed.draft.env)
          .map(([key, value]) => `${key}=${value}`)
          .join('\n'),
      )
      setAllowConcurrent(seed.draft.allowConcurrent)
      setError(null)
      if (!dialog.open) dialog.showModal()
    } else if (dialog.open) dialog.close()
  }, [seed])

  const close = () => {
    if (!saving) onClose()
  }
  const backdrop = (event: MouseEvent<HTMLDialogElement>) => {
    if (event.target !== event.currentTarget) return
    const bounds = event.currentTarget.getBoundingClientRect()
    if (
      event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom
    )
      close()
  }
  const submit = async () => {
    if (seed === null) return
    try {
      const saved = await onSave({
        ...(seed.draft.taskId === undefined ? {} : { taskId: seed.draft.taskId }),
        name,
        executable,
        args: args
          .split('\n')
          .map(value => value.trim())
          .filter(value => value !== ''),
        cwd,
        env: parseEnvironment(env),
        allowConcurrent,
      })
      if (saved) onClose()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '脚本定义无效')
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      aria-labelledby="project-task-editor-title"
      onCancel={event => {
        event.preventDefault()
        close()
      }}
      onClick={backdrop}
    >
      <div className={styles.dialogFrame}>
        <header>
          <div>
            <h2 id="project-task-editor-title">
              {seed?.draft.taskId === undefined ? '新建脚本' : '编辑脚本'}
            </h2>
          </div>
          <button type="button" aria-label="关闭脚本编辑器" disabled={saving} onClick={close}>
            <X size={17} />
          </button>
        </header>
        <div className={styles.form}>
          {(error ?? serverError) !== null && (
            <AppAlert
              tone="error"
              title={error !== null ? '脚本定义无效' : '脚本操作失败'}
              onClose={() => {
                setError(null)
                onClearServerError()
              }}
            >
              {error ?? serverError}
            </AppAlert>
          )}
          <label>
            <span>名称</span>
            <input
              value={name}
              maxLength={80}
              autoFocus
              onChange={event => {
                setName(event.currentTarget.value)
              }}
              placeholder="例如：启动开发服务"
            />
          </label>
          <label>
            <span>可执行程序</span>
            <input
              value={executable}
              maxLength={512}
              onChange={event => {
                setExecutable(event.currentTarget.value)
              }}
              placeholder="例如：npm 或 /usr/bin/python3"
            />
          </label>
          <label>
            <span>参数（每行一个）</span>
            <textarea
              value={args}
              rows={4}
              onChange={event => {
                setArgs(event.currentTarget.value)
              }}
              placeholder={'run\ndev'}
            />
          </label>
          <label>
            <span>相对工作目录</span>
            <input
              value={cwd}
              onChange={event => {
                setCwd(event.currentTarget.value)
              }}
              placeholder="留空表示项目根目录"
            />
          </label>
          <label>
            <span>环境变量（每行 KEY=VALUE）</span>
            <textarea
              value={env}
              rows={3}
              onChange={event => {
                setEnv(event.currentTarget.value)
              }}
              placeholder="NODE_ENV=development"
            />
          </label>
          <label className={styles.checkbox}>
            <input
              type="checkbox"
              checked={allowConcurrent}
              onChange={event => {
                setAllowConcurrent(event.currentTarget.checked)
              }}
            />
            <span>允许同一脚本并发运行</span>
          </label>
          <p>脚本直接启动程序，不经过 Shell；管道、重定向和复杂逻辑请写入项目已有脚本。</p>
        </div>
        <footer>
          <button type="button" disabled={saving} onClick={close}>
            取消
          </button>
          <button
            className={styles.primary}
            type="button"
            disabled={saving || name.trim() === '' || executable.trim() === ''}
            onClick={() => {
              void submit()
            }}
          >
            {saving ? '保存中…' : '保存脚本'}
          </button>
        </footer>
      </div>
    </dialog>
  )
}

export function ProjectTasksPanel({ visible = true }: { visible?: boolean }) {
  const tasks = useProjectTasks()
  const { informationCollapsed } = useWorkspaceSnapshot()
  const [editor, setEditor] = useState<EditorSeed | null>(null)
  const taskIds = useMemo(() => tasks.tasks.map(task => task.id), [tasks.tasks])
  const openEditor = (draft: TaskDraft) => {
    tasks.clearError()
    setEditor({ key: crypto.randomUUID(), draft })
  }
  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction
    if (target < 0 || target >= taskIds.length) return
    const next = [...taskIds]
    const [id] = next.splice(index, 1)
    if (id === undefined) return
    next.splice(target, 0, id)
    void tasks.reorderTasks(next)
  }

  return (
    <div className={`contextual-inspector ${styles.panel}`} data-project-tasks="true">
      <header>
        <div>
          <h2>脚本</h2>
        </div>
        <IconButton
          label="新建脚本"
          disabled={tasks.projectId === null}
          onClick={() => {
            openEditor(EMPTY_DRAFT)
          }}
        >
          <Plus size={15} />
        </IconButton>
      </header>
      {visible && !informationCollapsed && editor === null && tasks.error !== null && (
        <AppAlert
          tone="error"
          title="脚本操作失败"
          floating
          dismissAfterMs={8_000}
          onClose={tasks.clearError}
        >
          {tasks.error}
        </AppAlert>
      )}
      {tasks.projectId === null ? (
        <p className="contextual-panel-empty">当前会话没有可访问的项目。</p>
      ) : tasks.loading ? (
        <p className="contextual-panel-empty">正在读取用户脚本…</p>
      ) : tasks.tasks.length === 0 ? (
        <p className="contextual-panel-empty">尚未创建脚本。点击运行后在当前项目终端启动。</p>
      ) : (
        <ul className={styles.taskList}>
          {tasks.tasks.map((task, index) => {
            const busy = tasks.mutation === task.id
            return (
              <li key={task.id} data-task-name={task.name}>
                <div className={styles.taskMain}>
                  <span>
                    <strong>{task.name}</strong>
                    <small>
                      {task.executable} {task.args.join(' ')}
                    </small>
                  </span>
                </div>
                <div className={styles.actions}>
                  <IconButton
                    label={`在终端运行 ${task.name}`}
                    disabled={busy}
                    onClick={() => {
                      tasks.runTask(task.id)
                    }}
                  >
                    <Play size={13} />
                  </IconButton>
                  <IconButton
                    label={`编辑 ${task.name}`}
                    disabled={busy}
                    onClick={() => {
                      openEditor(draftFromTask(task))
                    }}
                  >
                    <Pencil size={13} />
                  </IconButton>
                  <IconButton
                    label={`复制 ${task.name}`}
                    disabled={busy}
                    onClick={() => {
                      openEditor(draftFromTask(task, true))
                    }}
                  >
                    <Copy size={13} />
                  </IconButton>
                  <IconButton
                    label={`上移 ${task.name}`}
                    disabled={index === 0 || tasks.mutation !== null}
                    onClick={() => {
                      move(index, -1)
                    }}
                  >
                    <ArrowUp size={13} />
                  </IconButton>
                  <IconButton
                    label={`下移 ${task.name}`}
                    disabled={index === tasks.tasks.length - 1 || tasks.mutation !== null}
                    onClick={() => {
                      move(index, 1)
                    }}
                  >
                    <ArrowDown size={13} />
                  </IconButton>
                  <IconButton
                    label={`删除 ${task.name}`}
                    disabled={busy}
                    onClick={() => {
                      void tasks.removeTask(task.id)
                    }}
                  >
                    <Trash2 size={13} />
                  </IconButton>
                </div>
                <small>
                  {task.cwd === '' ? '项目根目录' : task.cwd} ·{' '}
                  {task.allowConcurrent ? '每次新建终端' : '复用专属终端'}
                </small>
              </li>
            )
          })}
        </ul>
      )}
      <TaskEditorDialog
        seed={editor}
        saving={tasks.mutation === 'save'}
        serverError={tasks.error}
        onClearServerError={tasks.clearError}
        onClose={() => {
          setEditor(null)
        }}
        onSave={tasks.saveTask}
      />
    </div>
  )
}
