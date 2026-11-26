import { Form, Modal } from 'antd'
import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  SaveSshProfile,
  SshAgentAccess,
  SshConnectResult,
  SshProfile,
  SshStatus,
  SshTerminal as TerminalState,
} from '../../../../../packages/connections/ssh/types.d.ts'
import { callRemote, useWorkspaceSnapshot, useWorkspaceStore } from '../../plugins/sdk.ts'
import { AppAlert } from '../../shared/ui/AppAlert.tsx'
import { useWorkspaceTabs } from '../workspace-tabs/WorkspaceTabsProvider.tsx'
import {
  cloneSshAgentAccess,
  createDefaultSshAgentAccess,
  sanitizeSshAgentAccess,
  validateSshAgentAccessDraft,
} from './SshAgentAccessTab.tsx'
import { SshConnectionDialog } from './SshConnectionDialog.tsx'
import { SshHostList, type SshHostAction } from './SshHostList.tsx'
import { SshRecentConnections, SshShellPanel } from './SshWorkspacePanels.tsx'
import { DatabaseWorkspace } from './DatabaseWorkspace.tsx'
import { ConnectionsSidebarContent, useConnectionsNavigation } from './ConnectionsProvider.tsx'
import './connections.css'
import './ssh-workspace.css'

const empty: SshStatus = { supported: true, connections: [], terminals: [] }
const recentKey = 'mydsh.ssh.recent.v1'
const messageOf = (value: unknown) =>
  (value instanceof Error ? value.message : String(value))
    .replace(/^Error invoking remote method '[^']+': Error:\s*/u, '')
    .replace(/^Error:\s*/u, '')

function readRecentHosts(): string[] {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(recentKey) ?? '[]')
    if (!Array.isArray(value)) return []
    return [
      ...new Set(
        value.filter(
          (item): item is string =>
            typeof item === 'string' && item.length > 0 && item.length <= 128,
        ),
      ),
    ].slice(0, 6)
  } catch {
    return []
  }
}

export function ConnectionsWorkspace() {
  const { group, sidebarGroup } = useConnectionsNavigation()
  const [databaseOpened, setDatabaseOpened] = useState(false)
  useEffect(() => {
    if (group === 'databases' || sidebarGroup === 'databases') setDatabaseOpened(true)
  }, [group, sidebarGroup])
  return (
    <section className="connections-shell" aria-label="连接工作区">
      <div
        className="connections-group-content"
        hidden={group !== 'servers'}
        inert={group !== 'servers'}
      >
        <ServerWorkspace />
      </div>
      {(databaseOpened || group === 'databases' || sidebarGroup === 'databases') && (
        <div
          className="connections-group-content"
          hidden={group !== 'databases'}
          inert={group !== 'databases'}
        >
          <DatabaseWorkspace />
        </div>
      )}
    </section>
  )
}

function ServerWorkspace() {
  const workspace = useWorkspaceSnapshot()
  const workspaceStore = useWorkspaceStore()
  const publishSshGroup = useWorkspaceTabs()?.publishSshGroup
  const [state, setState] = useState<SshStatus>(empty),
    [selected, setSelected] = useState<string | null>(null)
  const [active, setActive] = useState<string | null>(null),
    [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [loaded, setLoaded] = useState(false)
  const [recentIds, setRecentIds] = useState(readRecentHosts)
  useEffect(() => {
    try {
      // 最近使用只记录连接标识，不复制服务器信息或凭据。
      window.localStorage.setItem(recentKey, JSON.stringify(recentIds))
    } catch {
      // 本地存储不可用时仍允许连接，最近列表只保留在当前窗口。
    }
  }, [recentIds])
  const [editing, setEditing] = useState<SshProfile | 'new' | null>(null),
    [formTab, setFormTab] = useState('connection'),
    [agentAccess, setAgentAccess] = useState<SshAgentAccess>(createDefaultSshAgentAccess),
    [confirm, setConfirm] = useState<
      (Extract<SshConnectResult, { kind: 'confirm-host' }> & { testOnly: boolean }) | null
    >(null)
  const [form] = Form.useForm<SaveSshProfile>()
  const [modal, modalContext] = Modal.useModal()
  const lifetime = useRef<AbortController | null>(null),
    pending = useRef<AbortController | null>(null),
    pendingTarget = useRef<{ id: string; testOnly: boolean } | null>(null)
  const selectionRevision = useRef(0)
  const call = useCallback(
    <T,>(method: string, args: Record<string, unknown> = {}, signal?: AbortSignal) =>
      callRemote(`mydshSsh/${method}`, args, signal ?? lifetime.current?.signal) as Promise<T>,
    [],
  )
  const report = useCallback((caught: unknown) => {
    if (!lifetime.current?.signal.aborted) setError(messageOf(caught))
  }, [])
  const refresh = useCallback(async () => {
    const value = await call<SshStatus>('status')
    if (lifetime.current?.signal.aborted) return
    setState(value)
    setLoaded(true)
    setSelected(current =>
      value.connections.some(item => item.id === current)
        ? current
        : (value.connections[0]?.id ?? null),
    )
  }, [call])
  useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    void refresh().catch(report)
    return () => {
      controller.abort()
      pending.current?.abort()
      void callRemote('mydshSsh/closeAll', {}).catch(() => {})
    }
  }, [refresh, report])
  const act = async (work: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await work()
    } catch (caught) {
      report(caught)
    } finally {
      if (!lifetime.current?.signal.aborted) setBusy(false)
    }
  }
  const edit = (value: SshProfile | 'new') => {
    setError(null)
    setFormTab('connection')
    setAgentAccess(
      value === 'new' ? createDefaultSshAgentAccess() : cloneSshAgentAccess(value.agentAccess),
    )
    form.resetFields()
    form.setFieldsValue(
      value === 'new'
        ? {
            name: '',
            host: '',
            port: 22,
            username: '',
            auth: 'password',
            environment: '',
            projectId: workspace.selectedProjectId,
            disabled: false,
          }
        : { ...value },
    )
    setEditing(value)
  }
  const save = async () => {
    const values = await form.validateFields()
    const accessError = validateSshAgentAccessDraft(agentAccess)
    if (accessError) {
      setFormTab('agentAccess')
      setError(accessError)
      return
    }
    const previous = editing === 'new' ? null : editing
    await act(async () => {
      const request: SaveSshProfile = {
        id: previous?.id ?? null,
        revision: previous?.revision ?? null,
        name: values.name,
        host: values.host.trim(),
        port: values.port,
        username: values.username.trim(),
        auth: values.auth,
        environment: values.environment ?? '',
        projectId: values.projectId ?? null,
        disabled: values.disabled ?? false,
        agentAccess: sanitizeSshAgentAccess(agentAccess),
        ...(values.password ? { password: values.password } : {}),
        ...(values.passphrase ? { passphrase: values.passphrase } : {}),
      }
      const saved = await call<SshProfile>('save', { request })
      form.resetFields()
      setFormTab('connection')
      setAgentAccess(createDefaultSshAgentAccess())
      setEditing(null)
      setSelected(saved.id)
      try {
        if (!previous && saved.auth === 'key')
          await call('importKey', { id: saved.id, revision: saved.revision })
      } finally {
        await refresh()
      }
    })
  }
  const connect = async (id: string, testOnly: boolean) => {
    const controller = new AbortController()
    const requestedSelection = selectionRevision.current
    pending.current = controller
    pendingTarget.current = { id, testOnly }
    try {
      const signal = AbortSignal.any([controller.signal, lifetime.current!.signal])
      const result = await call<SshConnectResult>(
        'connect',
        { id, testOnly, columns: 100, rows: 30 },
        signal,
      )
      if (signal.aborted) return
      if (result.kind === 'confirm-host') setConfirm({ ...result, testOnly })
      if (result.kind === 'tested') setNotice('连接测试成功，认证已通过。')
      if (result.kind === 'terminal') {
        setState(current => ({
          ...current,
          terminals: [
            ...current.terminals.filter(item => item.id !== result.terminal.id),
            result.terminal,
          ],
        }))
        setRecentIds(current => [id, ...current.filter(item => item !== id)].slice(0, 6))
        // 连接期间用户可能切换了标签；迟到结果保留为后台终端，不抢走当前视图。
        if (selectionRevision.current === requestedSelection) {
          setActive(result.terminal.id)
          setSelected(id)
        }
      }
    } finally {
      if (pending.current === controller) {
        pending.current = null
        pendingTarget.current = null
      }
      // 指纹确认已保存时，即使后续认证失败也必须刷新配置版本。
      await refresh().catch(() => {})
    }
  }
  const confirmationTarget = state.connections.find(item => item.id === confirm?.connectionId)
  const activeTerminal = state.terminals.find(item => item.id === active) ?? null
  const onStatus = useCallback((value: TerminalState) => {
    setState(current => ({
      ...current,
      terminals: current.terminals.map(item => (item.id === value.id ? value : item)),
    }))
  }, [])
  const close = async (id: string) => {
    const requestedSelection = selectionRevision.current
    const signal = lifetime.current?.signal
    await call('close', { id }, signal)
    if (signal?.aborted) return
    const next = state.terminals.findLast(item => item.id !== id)
    setState(current => ({
      ...current,
      terminals: current.terminals.filter(item => item.id !== id),
    }))
    if (active === id && selectionRevision.current === requestedSelection) {
      setActive(next?.id ?? null)
      if (next) setSelected(next.connectionId)
    } else setActive(current => (current === id ? null : current))
    await refresh()
  }
  const selectTerminal = (id: string | null) => {
    selectionRevision.current += 1
    if (id === null) {
      setActive(null)
      return
    }
    const terminal = state.terminals.find(item => item.id === id)
    if (!terminal) return
    setSelected(terminal.connectionId)
    setActive(terminal.id)
  }
  const openHost = (profile: SshProfile) => {
    if (busy || profile.disabled) return
    if (workspace.activeView !== 'connections') workspaceStore.setView('connections')
    selectionRevision.current += 1
    setSelected(profile.id)
    const terminal = state.terminals.find(
      item => item.connectionId === profile.id && item.status === 'connected',
    )
    if (terminal) {
      setRecentIds(current => [profile.id, ...current.filter(id => id !== profile.id)].slice(0, 6))
      setActive(terminal.id)
    } else {
      setActive(null)
      void act(() => connect(profile.id, false))
    }
  }
  const hostAction = (profile: SshProfile, action: SshHostAction) => {
    setSelected(profile.id)
    if (action === 'edit') edit(profile)
    if (action === 'test') void act(() => connect(profile.id, true))
    if (action === 'import-key')
      void act(async () => {
        await call('importKey', { id: profile.id, revision: profile.revision })
        await refresh()
      })
    if (action === 'reset-host')
      modal.confirm({
        title: '清除已保存的主机指纹？',
        content: '将关闭此服务器的终端。下次连接必须重新核对主机身份。',
        okText: '清除并断开',
        cancelText: '取消',
        onOk: () =>
          act(async () => {
            await call('resetHost', { id: profile.id, revision: profile.revision })
            await refresh()
          }),
      })
    if (action === 'remove')
      modal.confirm({
        title: `删除“${profile.name}”？`,
        content: '将关闭相关终端，并删除本机保存的连接及其凭据。',
        okText: '删除连接',
        cancelText: '取消',
        okButtonProps: { danger: true },
        onOk: () =>
          act(async () => {
            await call('remove', { id: profile.id, revision: profile.revision })
            await refresh()
          }),
      })
  }
  const actions = {
    select: selectTerminal,
    close: (id: string) => void act(() => close(id)),
    newTerminal: (id: string) => void act(() => connect(id, false)),
    clearError: () => setError(null),
    clearNotice: () => setNotice(null),
    cancel: () => pending.current?.abort(),
  }
  const tabActions = useRef(actions)
  tabActions.current = actions
  const connecting = busy && pending.current !== null
  const connectingTarget = connecting
    ? (state.connections.find(item => item.id === (pendingTarget.current?.id ?? selected)) ?? null)
    : null
  const connectingTestOnly = connecting ? (pendingTarget.current?.testOnly ?? false) : false
  const activeId = activeTerminal?.id ?? null
  useEffect(() => {
    if (!publishSshGroup) return
    const address = (terminal: TerminalState) => {
      const profile = state.connections.find(item => item.id === terminal.connectionId)
      return profile ? `${profile.username}@${profile.host}:${String(profile.port)}` : terminal.name
    }
    const activity = {
      connecting,
      target: connectingTarget,
      testOnly: connectingTestOnly,
      onCancel: () => tabActions.current.cancel(),
    }
    publishSshGroup({
      activeId,
      busy,
      tabs: state.terminals.map(terminal => ({
        id: terminal.id,
        title: terminal.name,
        description: `${address(terminal)} · ${terminal.status === 'connected' ? '已连接' : '已断开'}`,
      })),
      select: id => tabActions.current.select(id),
      close: id => tabActions.current.close(id),
      render: (id, visible, focused) => {
        const terminal = state.terminals.find(item => item.id === id)
        if (!terminal) return null
        const profile = state.connections.find(item => item.id === terminal.connectionId)
        return (
          <SshShellPanel
            terminal={terminal}
            address={address(terminal)}
            agentAccess={profile?.agentAccess}
            activity={activity}
            visible={visible}
            focused={focused}
            canNew={!busy && profile !== undefined && !profile.disabled}
            onHome={() => tabActions.current.select(null)}
            onNew={() => tabActions.current.newTerminal(terminal.connectionId)}
            onStatus={onStatus}
            onError={report}
          />
        )
      },
    })
  }, [
    activeId,
    busy,
    connecting,
    connectingTarget,
    connectingTestOnly,
    onStatus,
    publishSshGroup,
    report,
    state,
  ])
  useEffect(() => () => publishSshGroup?.(null), [publishSshGroup])
  const recentProfiles = recentIds.flatMap(id =>
    state.connections.filter(profile => profile.id === id),
  )
  return (
    <section className="connections-workspace" aria-label="服务器连接" data-connections-workspace>
      {modalContext}
      {workspace.activeView === 'connections' && editing === null && error && (
        <AppAlert
          tone="error"
          title="连接操作未完成"
          floating
          dismissAfterMs={8_000}
          onClose={actions.clearError}
        >
          {error}
        </AppAlert>
      )}
      {workspace.activeView === 'connections' && editing === null && !error && notice && (
        <AppAlert
          tone="success"
          title={notice}
          floating
          dismissAfterMs={4_500}
          onClose={actions.clearNotice}
        />
      )}
      <ConnectionsSidebarContent group="servers">
        <SshHostList
          connections={state.connections}
          selectedId={selected}
          connectingId={connectingTarget?.id ?? null}
          terminals={state.terminals}
          supported={state.supported}
          loaded={loaded}
          busy={busy}
          onAdd={() => edit('new')}
          onRefresh={() => {
            void act(refresh)
          }}
          onConnect={openHost}
          onAction={hostAction}
        />
      </ConnectionsSidebarContent>
      <SshRecentConnections
        profiles={recentProfiles}
        terminals={state.terminals}
        activity={{
          connecting,
          target: connectingTarget,
          testOnly: connectingTestOnly,
          onCancel: actions.cancel,
        }}
        busy={busy}
        loaded={loaded}
        supported={state.supported}
        hasHosts={state.connections.length > 0}
        onConnect={openHost}
        onAdd={() => edit('new')}
        onExpand={
          workspace.navigationCollapsed ? () => workspaceStore.toggleNavigation() : undefined
        }
      />
      <SshConnectionDialog
        editing={editing}
        busy={busy}
        error={error}
        form={form}
        formTab={formTab}
        agentAccess={agentAccess}
        projects={workspace.projects}
        onTabChange={setFormTab}
        onAgentAccessChange={setAgentAccess}
        onSave={() => {
          void save().catch(caught => {
            if (caught && typeof caught === 'object' && 'errorFields' in caught) {
              setFormTab('connection')
              return
            }
            report(caught)
          })
        }}
        onCancel={() => {
          if (!busy) {
            form.resetFields()
            setFormTab('connection')
            setAgentAccess(createDefaultSshAgentAccess())
            setEditing(null)
          }
        }}
      />
      <Modal
        open={confirm !== null}
        title="确认 SSH 主机指纹"
        okText="指纹一致，信任并继续"
        cancelText="取消"
        confirmLoading={busy}
        onCancel={() => setConfirm(null)}
        onOk={() => {
          const value = confirm
          if (value)
            void act(async () => {
              await call('trustHost', {
                id: value.connectionId,
                revision: value.revision,
                fingerprint: value.fingerprint,
              })
              setConfirm(null)
              await connect(value.connectionId, value.testOnly)
            })
        }}
      >
        <p>请通过服务器管理员或可信渠道核对以下指纹。只有确认一致后，MyDSH 才会发送认证信息。</p>
        <code className="connections-fingerprint">{confirm?.fingerprint}</code>
        <p>
          目标：{confirmationTarget?.name} · {confirmationTarget?.host}:{confirmationTarget?.port}
        </p>
      </Modal>
    </section>
  )
}
