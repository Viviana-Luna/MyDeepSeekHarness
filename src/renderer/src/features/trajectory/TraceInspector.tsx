import { Copy, WrapText, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView, lineNumbers } from '@codemirror/view'
import { codeEditorTheme } from '../files/code-editor-theme.ts'
import { loadCodeLanguage } from '../files/code-editor-language.ts'
import { MessageMarkdown } from '../conversation/MessageMarkdown.tsx'
import {
  formatTraceDuration,
  recordLabels,
  traceDuration,
  type TraceRecord,
} from './trajectory-model.ts'
import styles from './TrajectoryView.module.css'

const statusLabels = { running: '进行中', complete: '已完成', error: '失败', interrupted: '已中断' }
const time = (value: number | null) =>
  value === null
    ? '未记录'
    : new Date(value).toLocaleString('zh-CN', { hour12: false, fractionalSecondDigits: 3 })

function TraceContent({ text, preview = false }: { text: string | null; preview?: boolean }) {
  const parent = useRef<HTMLDivElement>(null)
  const [wrap, setWrap] = useState(true)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  useEffect(() => {
    setCopyState('idle')
  }, [text])
  let formatted = text ?? ''
  let json = false
  try {
    formatted = JSON.stringify(JSON.parse(formatted), null, 2)
    json = true
  } catch {
    /* 普通输出保留原文。 */
  }
  const visible = preview
    ? formatted.slice(0, 600).split('\n').slice(0, 16).join('\n')
    : formatted.slice(0, 200_000)
  useEffect(() => {
    if (parent.current === null || text === null) return
    let disposed = false
    const view = new EditorView({
      parent: parent.current,
      state: EditorState.create({
        doc: visible,
        extensions: [
          codeEditorTheme,
          lineNumbers(),
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          ...(wrap ? [EditorView.lineWrapping] : []),
        ],
      }),
    })
    if (json)
      void loadCodeLanguage('json')
        .then(language => {
          if (!disposed)
            view.setState(
              EditorState.create({
                doc: visible,
                extensions: [
                  codeEditorTheme,
                  lineNumbers(),
                  EditorState.readOnly.of(true),
                  EditorView.editable.of(false),
                  language,
                  ...(wrap ? [EditorView.lineWrapping] : []),
                ],
              }),
            )
        })
        .catch(() => {
          /* 高亮失败仍保留可复制的原文。 */
        })
    return () => {
      disposed = true
      view.destroy()
    }
  }, [visible, json, wrap, text])
  if (text === null || text === '')
    return <p className={styles.unavailable}>此记录没有提供这项内容。</p>
  return (
    <div className={styles.codeBlock}>
      <div className={styles.codeActions}>
        <button
          type="button"
          aria-label="自动换行"
          aria-pressed={wrap}
          onClick={() => {
            setWrap(value => !value)
          }}
        >
          <WrapText size={14} />
        </button>
        <button
          type="button"
          aria-label={copyState === 'copied' ? '已复制' : '复制内容'}
          onClick={() => {
            if (!navigator.clipboard) {
              setCopyState('failed')
              return
            }
            void navigator.clipboard
              .writeText(text)
              .then(() => {
                if (alive.current) setCopyState('copied')
              })
              .catch(() => {
                if (alive.current) setCopyState('failed')
              })
          }}
        >
          <Copy size={13} />
          {copyState === 'copied' ? '已复制' : copyState === 'failed' ? '复制失败，重试' : '复制'}
        </button>
      </div>
      <div className={styles.inspectorCode} ref={parent} />
      {formatted.length > visible.length && (
        <p className={styles.unavailable}>
          {preview
            ? '概述仅显示片段；在对应标签查看全文，复制保留完整内容。'
            : '内容较长，预览前 200,000 字符；复制可获取完整内容。'}
        </p>
      )}
    </div>
  )
}

export function TraceInspector({ record, onClose }: { record: TraceRecord; onClose(): void }) {
  const [tab, setTab] = useState('overview')
  const tabs = [
    { id: 'overview', label: '概述' },
    { id: 'input', label: record.kind === 'tool' ? '参数' : '输入' },
    { id: 'output', label: '结果' },
    ...(record.kind === 'model' ? [{ id: 'thinking', label: '思考' }] : []),
    { id: 'schema', label: 'Schema' },
    { id: 'timing', label: '计时' },
    { id: 'raw', label: '原始记录' },
  ]
  const active = tabs.some(item => item.id === tab) ? tab : 'overview'
  const duration = traceDuration(record)
  const timing = (
    <dl className={styles.inspectorFacts}>
      <dt>开始时间</dt>
      <dd>{time(record.startedAt)}</dd>
      <dt>结束时间</dt>
      <dd>{time(record.endedAt)}</dd>
      <dt>时长</dt>
      <dd>{formatTraceDuration(duration)}</dd>
      {record.kind === 'model' && (
        <>
          <dt>首字时间</dt>
          <dd>
            {formatTraceDuration(
              record.firstTokenAt === null || record.startedAt === null
                ? null
                : Math.max(0, record.firstTokenAt - record.startedAt),
            )}
          </dd>
        </>
      )}
    </dl>
  )
  return (
    <aside className={styles.inspector} aria-label="轨迹记录检查器">
      <header className={styles.inspectorHeader}>
        <span className={styles.kind} data-kind={record.kind}>
          {recordLabels[record.kind]}
        </span>
        <span>
          {record.turn > 0 ? `第 ${record.turn} 轮` : '轮次之间'}
          {record.step === null ? '' : ` · 第 ${record.step} 步`}
        </span>
        <button type="button" aria-label="关闭轨迹检查器" onClick={onClose}>
          <X size={15} />
        </button>
      </header>
      <div className={styles.inspectorTabs} role="tablist" aria-label="记录详情">
        {tabs.map((item, index) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={active === item.id}
            id={`trace-tab-${item.id}`}
            aria-controls="trace-inspector-panel"
            tabIndex={active === item.id ? 0 : -1}
            onClick={() => {
              setTab(item.id)
            }}
            onKeyDown={event => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
              event.preventDefault()
              const next =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? tabs.length - 1
                    : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
              const id = tabs[next]!.id
              setTab(id)
              document.getElementById(`trace-tab-${id}`)?.focus()
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div
        className={styles.inspectorBody}
        id="trace-inspector-panel"
        role="tabpanel"
        aria-labelledby={`trace-tab-${active}`}
        tabIndex={0}
      >
        {active === 'overview' ? (
          <>
            <dl className={styles.inspectorFacts}>
              <dt>名称</dt>
              <dd>{record.name}</dd>
              <dt>状态</dt>
              <dd data-status={record.status}>{statusLabels[record.status]}</dd>
              <dt>序号</dt>
              <dd>#{record.seq}</dd>
              {record.callId !== null && (
                <>
                  <dt>调用 ID</dt>
                  <dd>{record.callId}</dd>
                </>
              )}
              {record.parentCallId !== null && (
                <>
                  <dt>父调用</dt>
                  <dd>{record.parentCallId}</dd>
                </>
              )}
              {record.usage !== null && (
                <>
                  <dt>输入 Token</dt>
                  <dd>{record.usage.input?.toLocaleString() ?? '未记录'}</dd>
                  <dt>输出 Token</dt>
                  <dd>{record.usage.output?.toLocaleString() ?? '未记录'}</dd>
                  <dt>思考 Token</dt>
                  <dd>{record.usage.reasoning?.toLocaleString() ?? '未记录'}</dd>
                </>
              )}
            </dl>
            {record.input !== null && (
              <section>
                <h3>
                  <button
                    type="button"
                    onClick={() => {
                      setTab('input')
                    }}
                  >
                    {record.kind === 'tool' ? '参数' : '输入'} ›
                  </button>
                </h3>
                <TraceContent text={record.input} preview />
              </section>
            )}
            {record.output !== null && (
              <section>
                <h3>
                  <button
                    type="button"
                    onClick={() => {
                      setTab('output')
                    }}
                  >
                    结果 ›
                  </button>
                </h3>
                {record.kind === 'model' ? (
                  <MessageMarkdown text={record.output} />
                ) : (
                  <TraceContent text={record.output} preview />
                )}
              </section>
            )}
            {record.thinking !== null && (
              <details>
                <summary>思考内容</summary>
                <MessageMarkdown text={record.thinking} />
              </details>
            )}
            {record.kind === 'tool' && (
              <section>
                <h3>
                  <button
                    type="button"
                    onClick={() => {
                      setTab('schema')
                    }}
                  >
                    Schema ›
                  </button>
                </h3>
                {record.schema === null ? (
                  <p className={styles.unavailable}>
                    Schema 不可用：这段历史没有记录对应的工具定义。
                  </p>
                ) : (
                  <TraceContent text={record.schema} preview />
                )}
              </section>
            )}
            <section>
              <h3>计时</h3>
              {timing}
            </section>
          </>
        ) : active === 'timing' ? (
          timing
        ) : active === 'output' && record.kind === 'model' && record.output ? (
          <MessageMarkdown text={record.output} />
        ) : active === 'thinking' && record.thinking ? (
          <MessageMarkdown text={record.thinking} />
        ) : (
          <TraceContent
            key={`${record.id}-${active}`}
            text={
              active === 'raw'
                ? record.raw
                : active === 'input'
                  ? record.input
                  : active === 'output'
                    ? record.output
                    : active === 'thinking'
                      ? record.thinking
                      : record.schema
            }
          />
        )}
      </div>
    </aside>
  )
}
