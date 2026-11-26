/** SSH 左侧主机列表：展示已保存的连接，不持有连接或凭据。 */
import { Button, Dropdown, Input, type MenuProps } from 'antd'
import { Loader2, MoreHorizontal, Plus, RefreshCw, Search, Server } from 'lucide-react'
import { useState } from 'react'
import type { SshProfile, SshTerminal } from '../../../../../packages/connections/ssh/types.d.ts'
import { formatSshAgentAccessSummary, formatSshAgentBadge } from './SshAgentAccessTab.tsx'

/** 主机卡片可执行的已有连接操作。 */
export type SshHostAction = 'edit' | 'test' | 'import-key' | 'reset-host' | 'remove'

interface SshHostListProps {
  connections: readonly SshProfile[]
  selectedId: string | null
  connectingId?: string | null | undefined
  terminals: readonly SshTerminal[]
  supported: boolean
  loaded: boolean
  busy: boolean
  onAdd(): void
  onRefresh(): void
  onConnect(profile: SshProfile): void
  onAction(profile: SshProfile, action: SshHostAction): void
}

function hostStateText(disabled: boolean, connecting: boolean, connected: boolean): string | null {
  if (disabled) return '已禁用'
  if (connecting) return '连接中…'
  if (connected) return '已连接'
  return null
}

/** 统一展示已保存的主机，主机列表可另外提供管理菜单。 */
export function SshHostCard({
  profile,
  connected,
  connecting = false,
  selected,
  busy,
  onConnect,
  onAction,
}: {
  profile: SshProfile
  connected: boolean
  connecting?: boolean | undefined
  selected: boolean
  busy: boolean
  onConnect(profile: SshProfile): void
  onAction?(profile: SshProfile, action: SshHostAction): void
}) {
  const stateLabel = hostStateText(profile.disabled, connecting, connected)
  const agentBadge = formatSshAgentBadge(profile.agentAccess)
  const agentSummary = formatSshAgentAccessSummary(profile.agentAccess)
  const items: MenuProps['items'] = [
    { key: 'edit', label: '编辑连接', disabled: busy },
    { key: 'test', label: '测试连接', disabled: busy || profile.disabled },
    ...(profile.auth === 'key'
      ? [{ key: 'import-key', label: '导入或替换私钥', disabled: busy }]
      : []),
    ...(profile.fingerprint ? [{ key: 'reset-host', label: '重新核对指纹', disabled: busy }] : []),
    { type: 'divider' },
    { key: 'remove', label: '删除连接', danger: true, disabled: busy },
  ]
  return (
    <article
      className="ssh-host-card"
      data-ssh-host={profile.id}
      data-selected={selected || undefined}
      data-connecting={connecting || undefined}
    >
      <button
        type="button"
        className="ssh-host-card__open"
        aria-label={`连接 ${profile.name}`}
        aria-current={selected ? 'true' : undefined}
        title={`${profile.username}@${profile.host}:${String(profile.port)}`}
        disabled={busy || profile.disabled}
        onClick={() => onConnect(profile)}
      >
        <span className="ssh-host-card__icon" aria-hidden="true">
          {connecting ? <Loader2 size={18} className="ssh-spin" /> : <Server size={19} />}
        </span>
        <span className="ssh-host-card__text">
          <strong>{profile.name}</strong>
          <small>
            {profile.username}@{profile.host}:{profile.port}
          </small>
        </span>
        {agentBadge && (
          <span className="ssh-host-card__agent" title={agentSummary}>
            {agentBadge}
          </span>
        )}
        {stateLabel && <span className="ssh-host-card__state">{stateLabel}</span>}
      </button>
      {onAction && (
        <Dropdown
          trigger={['click']}
          menu={{
            items,
            onClick: ({ key }) => {
              if (
                key === 'edit' ||
                key === 'test' ||
                key === 'import-key' ||
                key === 'reset-host' ||
                key === 'remove'
              )
                onAction(profile, key)
            },
          }}
        >
          <Button
            type="text"
            className="ssh-host-card__menu"
            aria-label={`${profile.name} 的连接操作`}
            icon={<MoreHorizontal size={16} />}
            disabled={busy}
          />
        </Dropdown>
      )}
    </article>
  )
}

/** 搜索已保存主机，连接与修改动作仍由工作区持有。 */
export function SshHostList(props: SshHostListProps) {
  const [search, setSearch] = useState('')
  const needle = search.trim().toLocaleLowerCase()
  const matches = (profile: SshProfile) =>
    [profile.name, profile.host, profile.username, profile.environment].some(value =>
      value.toLocaleLowerCase().includes(needle),
    )
  const visible = props.connections.filter(matches)
  const connected = new Set(
    props.terminals.filter(item => item.status === 'connected').map(item => item.connectionId),
  )
  const cards = (profiles: readonly SshProfile[]) =>
    profiles.map(profile => (
      <SshHostCard
        key={profile.id}
        profile={profile}
        selected={props.selectedId === profile.id}
        connecting={props.connectingId === profile.id}
        connected={connected.has(profile.id)}
        busy={props.busy}
        onConnect={props.onConnect}
        onAction={props.onAction}
      />
    ))
  return (
    <section className="ssh-home" aria-label="SSH 主机列表">
      <header className="ssh-home__toolbar" role="toolbar" aria-label="SSH 主机操作">
        <div className="ssh-home__search" role="search">
          <Input
            type="search"
            aria-label="搜索 SSH 主机"
            placeholder="搜索主机…"
            prefix={<Search size={14} />}
            allowClear
            value={search}
            onChange={event => setSearch(event.target.value)}
          />
        </div>
        <div className="ssh-home__toolbar-actions">
          <Button
            type="text"
            aria-label="新增 SSH 连接"
            title="新增 SSH 连接"
            icon={<Plus size={15} />}
            disabled={props.busy || !props.supported}
            onClick={props.onAdd}
          />
          <Button
            type="text"
            aria-label="刷新连接列表"
            title="刷新连接列表"
            icon={<RefreshCw size={14} />}
            disabled={props.busy}
            onClick={props.onRefresh}
          />
        </div>
      </header>
      <div className="ssh-home__body">
        {!props.supported && (
          <div className="connections-empty">
            <Server size={28} />
            <h3>SSH 连接暂仅支持 macOS 与 Windows</h3>
          </div>
        )}
        {props.supported && !props.loaded && (
          <p className="ssh-home__message" role="status">
            正在读取主机…
          </p>
        )}
        {props.supported && props.loaded && !props.connections.length && (
          <div className="connections-empty">
            <Server size={28} />
            <h3>还没有 SSH 主机</h3>
            <p>添加连接信息并核对主机指纹后，即可打开远程终端。</p>
            <Button type="primary" disabled={props.busy} onClick={props.onAdd}>
              新建主机
            </Button>
          </div>
        )}
        {props.supported && props.loaded && props.connections.length > 0 && !visible.length && (
          <p className="ssh-home__message">没有匹配的主机，请尝试其他名称或地址。</p>
        )}
        {props.supported && props.loaded && visible.length > 0 && (
          <>
            <section className="ssh-host-section" aria-label="全部主机">
              <div className="ssh-host-section__heading">
                <h2>全部主机</h2>
                <span>{visible.length} 台</span>
              </div>
              <div className="ssh-host-grid">{cards(visible)}</div>
            </section>
          </>
        )}
      </div>
    </section>
  )
}
