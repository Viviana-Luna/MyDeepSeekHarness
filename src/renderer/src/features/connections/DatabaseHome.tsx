/** renderer 数据库首页，展示保存的连接与窗口内查询历史，不拥有数据库连接。 */
import { Button, Dropdown } from 'antd'
import { Database, FilePlus2, History, Plus, RefreshCw } from 'lucide-react'
import type { DatabaseProfile } from '../../../../../packages/connections/database/types.d.ts'
import { formatConnectionSummary, formatConnectionTooltip } from './database-engine-meta.ts'
import {
  connectionStateLabel,
  formatHistoryScopeLabel,
  type DatabaseConnectionState,
} from './database-workspace-helpers.ts'
import { DatabaseEngineIcon } from './DatabaseEngineIcon.tsx'
import type { DatabaseHistoryEntry } from './useDatabaseHistory.ts'
import './database-home.css'

interface HomeProps {
  connections: readonly DatabaseProfile[]
  connectionStates?: Readonly<Record<string, DatabaseConnectionState>>
  history: readonly DatabaseHistoryEntry[]
  loaded: boolean
  busy: boolean
  onAdd(): void
  onOpen(profile: DatabaseProfile): void
  onNewQuery(profile: DatabaseProfile): void
  onRestore(entry: DatabaseHistoryEntry): void
  onRefresh(): void
}

function ConnectionShortcuts({
  connections,
  connectionStates,
  loaded,
  busy,
  onAdd,
  onOpen,
  onNewQuery,
  onRefresh,
}: HomeProps) {
  const available = connections.filter(profile => !profile.disabled)
  const countText =
    available.length === connections.length
      ? `${connections.length} 个连接`
      : `${available.length} / ${connections.length} 可用`
  return (
    <section className="database-home__panel database-home__shortcuts" aria-label="快速开始">
      <header className="database-home__header">
        <div className="database-home__heading">
          <h2>
            <Database size={17} aria-hidden="true" />
            快速开始
          </h2>
          {loaded && <span>{countText}</span>}
        </div>
        <div className="database-home__toolbar" role="toolbar" aria-label="常用操作">
          <Button
            className="database-home__action"
            size="small"
            icon={<RefreshCw size={14} />}
            disabled={!loaded || busy}
            onClick={onRefresh}
          >
            刷新连接
          </Button>
          <Dropdown
            trigger={['click']}
            menu={{
              className: 'database-tree-menu-list',
              items: available.map(profile => ({
                key: profile.id,
                label: profile.name,
                onClick: () => onNewQuery(profile),
              })),
            }}
            disabled={busy || available.length === 0}
          >
            <Button
              className="database-home__action"
              size="small"
              icon={<FilePlus2 size={14} />}
              disabled={busy || available.length === 0}
            >
              新建查询
            </Button>
          </Dropdown>
          <Button
            className="database-home__action database-home__action--primary"
            type="primary"
            size="small"
            icon={<Plus size={15} />}
            disabled={!loaded || busy}
            onClick={onAdd}
          >
            新建连接
          </Button>
        </div>
      </header>
      {!loaded && (
        <p className="database-home__empty" role="status">
          正在读取连接…
        </p>
      )}
      {loaded && connections.length === 0 && (
        <p className="database-home__empty">还没有数据库连接，点击「新建连接」开始。</p>
      )}
      {connections.length > 0 && (
        <ul className="database-home__connections">
          {connections.map(profile => {
            const state =
              connectionStates?.[profile.id] ?? (profile.disabled ? 'disabled' : 'disconnected')
            const showDot = state === 'connected' || state === 'connecting' || state === 'error'
            return (
              <li key={profile.id} data-connection-state={state}>
                <button
                  type="button"
                  className="database-home__connection"
                  disabled={busy || profile.disabled}
                  onClick={() => onOpen(profile)}
                  aria-label={`打开连接 ${profile.name}`}
                  title={formatConnectionTooltip(profile)}
                >
                  <span className="database-home__connection-icon" data-engine={profile.engine}>
                    <DatabaseEngineIcon engine={profile.engine} size={20} />
                  </span>
                  <span className="database-home__connection-copy">
                    <span className="database-home__connection-title">
                      <strong>{profile.name}</strong>
                      {showDot && (
                        <span
                          className={`database-status-dot database-status-dot--${state}`}
                          role="img"
                          data-connection-state={state}
                          aria-label={connectionStateLabel(state)}
                          title={connectionStateLabel(state)}
                        />
                      )}
                    </span>
                    <small>{formatConnectionSummary(profile)}</small>
                  </span>
                  {profile.disabled && <em>已停用</em>}
                </button>
                <Button
                  type="text"
                  aria-label={`在 ${profile.name} 新建查询`}
                  title="新建查询"
                  icon={<FilePlus2 size={16} />}
                  disabled={busy || profile.disabled}
                  onClick={() => onNewQuery(profile)}
                />
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

function QueryHistory({ history, connections, busy, onRestore }: HomeProps) {
  return history.length === 0 ? (
    <div className="database-home__history-empty">
      <span>
        <History size={18} aria-hidden="true" />
      </span>
      <div>
        <strong>暂无查询记录</strong>
        <p>运行 SQL 后，可以在这里找回并继续编辑。</p>
      </div>
    </div>
  ) : (
    <ul className="database-home__history-list">
      {history.map(entry => {
        const profile = connections.find(item => item.id === entry.connectionId)
        return (
          <li key={entry.id}>
            <button
              type="button"
              disabled={busy || !profile || profile.disabled}
              title="恢复到查询编辑器"
              aria-label={`恢复查询 ${entry.sql}`}
              onClick={() => onRestore(entry)}
            >
              <code>{entry.sql}</code>
              <span>
                <strong>
                  {entry.connectionName}
                  {formatHistoryScopeLabel(entry)}
                </strong>
                <span>
                  {entry.rowCount} 行 · {entry.elapsedMs} ms
                </span>
                <time dateTime={new Date(entry.executedAt).toISOString()}>
                  {new Date(entry.executedAt).toLocaleString('zh-CN')}
                </time>
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

/** 未选择连接时保留左侧对象导航，在主区提供实际可用的连接与查询入口。 */
export function DatabaseHome(props: HomeProps) {
  return (
    <div className="database-home" data-database-home aria-busy={!props.loaded}>
      <div className="database-home__body">
        <ConnectionShortcuts {...props} />
        <section className="database-home__panel database-home__history" aria-label="历史查询">
          <header className="database-home__header">
            <div className="database-home__heading">
              <h2>
                <History size={17} aria-hidden="true" />
                历史查询
              </h2>
            </div>
            <span>只读查询 · 仅当前窗口</span>
          </header>
          <QueryHistory {...props} />
        </section>
      </div>
    </div>
  )
}
