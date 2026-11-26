/** SSH 首页和工作标签的内容。会话的建立与关闭仍由连接工作区处理。 */
import { Button } from 'antd'
import { Clock3, LayoutGrid, Loader2, Plus, Server } from 'lucide-react'
import type {
  SshAgentAccess,
  SshProfile,
  SshTerminal as TerminalState,
} from '../../../../../packages/connections/ssh/types.d.ts'
import { formatSshAgentAccessSummary, formatSshAgentBadge } from './SshAgentAccessTab.tsx'
import { SshHostCard } from './SshHostList.tsx'
import { SshTerminal } from './SshTerminal.tsx'

/** 连接操作在首页和当前终端共用的连接进度反馈。 */
export interface SshActivityProps {
  readonly connecting: boolean
  readonly target?: SshProfile | null | undefined
  readonly testOnly?: boolean | undefined
  onCancel(): void
}

function connectingTitle(target?: SshProfile | null, testOnly?: boolean): string {
  if (!target) return '正在连接主机…'
  return `${testOnly ? '正在测试' : '正在连接'} ${target.name}`
}

function SshConnectingStage({
  target,
  testOnly,
  onCancel,
}: {
  target?: SshProfile | null | undefined
  testOnly?: boolean | undefined
  onCancel(): void
}) {
  const title = connectingTitle(target, testOnly)
  const detail = testOnly
    ? '正在验证 SSH 握手与登录认证凭据…'
    : '正在建立 SSH 安全通道并核对主机身份…'
  return (
    <div className="ssh-connecting-stage">
      <div className="ssh-connecting-card" role="status" aria-live="polite">
        <div className="ssh-connecting-card__visual" aria-hidden="true">
          <Server size={22} />
        </div>
        <div className="ssh-connecting-card__copy">
          <strong>{title}</strong>
          {target && (
            <code className="ssh-connecting-card__address">
              {target.username}@{target.host}:{target.port}
            </code>
          )}
          <p className="ssh-connecting-card__detail">
            <Loader2 size={14} className="ssh-spin" aria-hidden="true" />
            <span>{detail}</span>
          </p>
        </div>
        <div className="ssh-connecting-card__actions">
          <Button onClick={onCancel}>取消连接</Button>
        </div>
      </div>
    </div>
  )
}

function SshActivity(props: SshActivityProps) {
  if (!props.connecting) return null
  return (
    <div className="ssh-connecting">
      <span className="ssh-connecting__status" role="status">
        <Loader2 size={15} className="ssh-spin" aria-hidden="true" />
        <strong>{connectingTitle(props.target, props.testOnly)}</strong>
        {props.target && (
          <small>
            {props.target.username}@{props.target.host}:{props.target.port}
          </small>
        )}
      </span>
      <Button size="small" onClick={props.onCancel}>
        取消连接
      </Button>
    </div>
  )
}

/** 在主区列出成功连接过的主机，按最近使用顺序展示。 */
export function SshRecentConnections({
  profiles,
  terminals,
  activity,
  busy,
  loaded,
  supported,
  hasHosts,
  onConnect,
  onAdd,
  onExpand,
}: {
  profiles: readonly SshProfile[]
  terminals: readonly TerminalState[]
  activity: SshActivityProps
  busy: boolean
  loaded: boolean
  supported: boolean
  hasHosts: boolean
  onConnect(profile: SshProfile): void
  onAdd(): void
  onExpand?: (() => void) | undefined
}) {
  return (
    <main className="connections-content">
      {activity.connecting && (
        <SshConnectingStage
          target={activity.target}
          testOnly={activity.testOnly}
          onCancel={activity.onCancel}
        />
      )}
      <section className="ssh-recent" aria-label="最近连接" hidden={activity.connecting}>
        <header className="ssh-recent__heading">
          <h2>
            <Clock3 size={18} aria-hidden="true" />
            最近连接
          </h2>
          {onExpand && <Button onClick={onExpand}>展开主机列表</Button>}
        </header>
        {!supported && <p>SSH 连接暂仅支持 macOS 与 Windows。</p>}
        {supported && !loaded && <p role="status">正在读取连接记录…</p>}
        {supported && loaded && profiles.length === 0 && (
          <div className="ssh-recent__empty">
            <p>
              {hasHosts
                ? '从左侧选择主机。连接成功后，这里会显示最近用过的主机。'
                : '添加主机后，即可打开远程终端。'}
            </p>
            {!hasHosts && (
              <Button disabled={busy} onClick={onAdd}>
                新建主机
              </Button>
            )}
          </div>
        )}
        {supported && profiles.length > 0 && (
          <div className="ssh-recent__grid">
            {profiles.map(profile => (
              <SshHostCard
                key={profile.id}
                profile={profile}
                selected={false}
                connecting={activity.connecting && activity.target?.id === profile.id}
                connected={terminals.some(
                  item => item.connectionId === profile.id && item.status === 'connected',
                )}
                busy={busy}
                onConnect={onConnect}
              />
            ))}
          </div>
        )}
      </section>
    </main>
  )
}

/** 将已连接的终端放在稳定的顶部标签宿主中，隐藏时保留终端实例。 */
export function SshShellPanel({
  terminal,
  address,
  agentAccess,
  activity,
  visible,
  focused,
  canNew,
  onHome,
  onNew,
  onStatus,
  onError,
}: {
  terminal: TerminalState
  address: string
  agentAccess?: SshAgentAccess | undefined
  activity: SshActivityProps
  visible: boolean
  focused: boolean
  canNew: boolean
  onHome(): void
  onNew(): void
  onStatus(value: TerminalState): void
  onError(error: unknown): void
}) {
  const agentBadge = formatSshAgentBadge(agentAccess)
  return (
    <div className="connections-content">
      {focused && <SshActivity {...activity} />}
      <header className="ssh-terminal-heading">
        <span title={address}>{address}</span>
        {agentBadge && (
          <span
            className="ssh-terminal-heading__agent"
            title={formatSshAgentAccessSummary(agentAccess)}
          >
            {agentBadge}
          </span>
        )}
        <span>{terminal.status === 'connected' ? '已连接' : '已断开'}</span>
        <div className="ssh-terminal-heading__actions">
          <Button
            type="text"
            aria-label="返回最近连接"
            title="返回最近连接"
            icon={<LayoutGrid size={15} />}
            onClick={onHome}
          />
          <Button
            type="text"
            aria-label="为当前主机新建终端"
            title="为当前主机新建终端"
            icon={<Plus size={16} />}
            disabled={!canNew}
            onClick={onNew}
          />
        </div>
      </header>
      <SshTerminal
        terminal={terminal}
        active={visible}
        focusOnActivate={focused}
        onStatus={onStatus}
        onError={onError}
      />
    </div>
  )
}
