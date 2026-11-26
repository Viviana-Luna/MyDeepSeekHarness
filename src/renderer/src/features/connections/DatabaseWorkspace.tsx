import { Button, Dropdown, Form, Input, Modal } from 'antd'
import {
  ChevronLeft,
  ChevronRight,
  Database,
  Eye,
  LockKeyhole,
  MoreHorizontal,
  Play,
  RefreshCw,
  Square,
  Table2,
  Unplug,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  DatabaseAgentAccess,
  DatabaseColumn,
  DatabaseEngine,
  DatabaseProfile,
  DatabaseResult,
  DatabaseStatus,
  DatabaseTable,
  DatabaseTestResult,
  SaveDatabaseProfile,
} from '../../../../../packages/connections/database/types.d.ts'
import type { SshProfile, SshStatus } from '../../../../../packages/connections/ssh/types.d.ts'
import { callRemote, useWorkspaceSnapshot, useWorkspaceStore } from '../../plugins/sdk.ts'
import { AppAlert } from '../../shared/ui/AppAlert.tsx'
import {
  cloneAgentAccess,
  createDefaultAgentAccess,
  formatAgentAccessSummary,
  validateAgentAccessDraft,
} from './DatabaseAgentAccessTab.tsx'
import { ConnectionsSidebarContent } from './ConnectionsProvider.tsx'
import { DatabaseConnectionModal } from './DatabaseConnectionModal.tsx'
import {
  engineMeta,
  formatConnectionSummary,
  formatConnectionTooltip,
} from './database-engine-meta.ts'
import {
  connectionStateLabel,
  databaseTableCacheKey,
  emptyTableMessage,
  loadFirstAccessiblePostgresCatalog,
  orderPostgresCatalogCandidates,
  pickDefaultSchema,
  resolveConnectionState,
  tableKindLabel,
  tablesBySchemaForCatalog,
  type DatabaseConnectionState,
} from './database-workspace-helpers.ts'
import { DatabaseEngineIcon } from './DatabaseEngineIcon.tsx'
import { databaseNodeKey } from './DatabaseNavigator.tsx'
import { DatabaseSidebar } from './DatabaseSidebar.tsx'
import { databaseGroupKey } from './DatabaseTreeGroups.tsx'
import { DatabaseHome } from './DatabaseHome.tsx'
import { useDatabaseHistory, type DatabaseHistoryEntry } from './useDatabaseHistory.ts'
import { useDatabaseGroups } from './useDatabaseGroups.ts'

interface DatabaseView {
  sql: string
  catalogs: string[] | null
  catalog: string | null
  catalogSchemas: Record<string, string[]>
  failedCatalogs: Record<string, string>
  schemas: string[] | null
  schema: string | null
  tables: Record<string, DatabaseTable[]>
  table: string | null
  columns: DatabaseColumn[]
  page: number
  preview: DatabaseResult | null
  query: DatabaseResult | null
  mode: 'tables' | 'preview' | 'columns' | 'sql'
  error: string | null
  connectionError: string | null
  notice: string | null
  noticeTone: 'info' | 'success'
}
const emptyView = (
  profile?: Pick<DatabaseProfile, 'engine' | 'database'> | null,
): DatabaseView => ({
  sql: '',
  catalogs: null,
  catalog: profile?.engine === 'postgresql' ? (profile.database ?? null) : null,
  catalogSchemas: {},
  failedCatalogs: {},
  schemas: null,
  schema: profile?.engine === 'postgresql' ? null : (profile?.database ?? null),
  tables: {},
  table: null,
  columns: [],
  page: 0,
  preview: null,
  query: null,
  mode: 'tables',
  error: null,
  connectionError: null,
  notice: null,
  noticeTone: 'info',
})
const messageOf = (value: unknown) =>
  (value instanceof Error ? value.message : String(value)).replace(
    /^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/u,
    '',
  )
const PAGE_SIZE = 100

/** 查询草稿留在所属连接；请求结束前切换目标时取消，迟到结果不能进入另一连接。 */
export function DatabaseWorkspace() {
  const workspace = useWorkspaceSnapshot()
  const workspaceStore = useWorkspaceStore()
  const ensureDatabaseView = () => {
    if (workspace.activeView !== 'database') workspaceStore.setView('database')
  }
  const [state, setState] = useState<DatabaseStatus>({
    supported: true,
    connections: [],
    busyIds: [],
  })
  const [selected, setSelected] = useState<string | null>(null)
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  const [views, setViews] = useState<Record<string, DatabaseView>>({})
  const history = useDatabaseHistory()
  const groups = useDatabaseGroups()
  const [expanded, setExpanded] = useState<string[]>([]),
    [search, setSearch] = useState('')
  const [loaded, setLoaded] = useState(false),
    [error, setError] = useState<string | null>(null)
  const [operation, setOperation] = useState<{ id: string; label: string } | null>(null)
  const [editing, setEditing] = useState<DatabaseProfile | 'new' | null>(null)
  const [formTab, setFormTab] = useState('connection')
  const [agentAccess, setAgentAccess] = useState<DatabaseAgentAccess>(createDefaultAgentAccess)
  const [saving, setSaving] = useState(false),
    [cancelling, setCancelling] = useState(false)
  const [ssh, setSsh] = useState<SshProfile[]>([])
  const [form] = Form.useForm<SaveDatabaseProfile>()
  const [modal, modalContext] = Modal.useModal()
  const lifetime = useRef<AbortController | null>(null)
  const pending = useRef<AbortController | null>(null)
  const savePending = useRef(false)
  const statusRevision = useRef(0)
  const call = useCallback(
    <T,>(method: string, args: Record<string, unknown> = {}, signal?: AbortSignal) =>
      callRemote(`mydshDatabase/${method}`, args, signal ?? lifetime.current?.signal) as Promise<T>,
    [],
  )
  const updateView = (id: string, patch: Partial<DatabaseView>) => {
    setViews(current => ({
      ...current,
      [id]: {
        ...emptyView(state.connections.find(item => item.id === id)),
        ...current[id],
        ...patch,
      },
    }))
  }
  const refresh = useCallback(async () => {
    const revision = ++statusRevision.current
    const value = await call<DatabaseStatus>('status')
    if (lifetime.current?.signal.aborted || revision !== statusRevision.current) return
    setState(value)
    setLoaded(true)
    setSelected(current => (value.connections.some(item => item.id === current) ? current : null))
    setViews(current =>
      Object.fromEntries(
        Object.entries(current).filter(([id]) => value.connections.some(item => item.id === id)),
      ),
    )
  }, [call])
  const report = useCallback((cause: unknown) => {
    if (!lifetime.current?.signal.aborted) setError(messageOf(cause))
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    void refresh().catch(report)
    return () => {
      controller.abort()
      pending.current?.abort()
      void callRemote('mydshDatabase/closeAll', {}).catch(() => {})
    }
  }, [refresh, report])
  const chooseConnection = (id: string | null) => {
    if (id !== null) ensureDatabaseView()
    pending.current?.abort()
    pending.current = null
    selectedRef.current = id
    setSelected(id)
    setOperation(null)
    setError(null)
  }
  const run = async <T,>(
    id: string,
    label: string,
    work: (signal: AbortSignal) => Promise<T>,
    commit: (value: T) => void,
  ) => {
    if (pending.current || saving || cancelling) return
    const controller = new AbortController()
    pending.current = controller
    const signal = AbortSignal.any([controller.signal, lifetime.current!.signal])
    setOperation({ id, label })
    updateView(id, { error: null, notice: null })
    try {
      const value = await work(signal)
      if (!signal.aborted && pending.current === controller && selectedRef.current === id)
        commit(value)
    } catch (cause) {
      if (!signal.aborted && pending.current === controller && selectedRef.current === id) {
        const msg = messageOf(cause)
        setViews(current => {
          const profile = state.connections.find(item => item.id === id)
          const base = current[id] ?? emptyView(profile)
          const isConnected =
            profile?.engine === 'postgresql' ? Boolean(base.catalogs) : Boolean(base.schemas)
          return {
            ...current,
            [id]: {
              ...base,
              error: msg,
              connectionError: isConnected ? base.connectionError : msg,
            },
          }
        })
      }
    } finally {
      if (pending.current === controller) {
        pending.current = null
        if (!lifetime.current?.signal.aborted) setOperation(null)
      }
    }
  }
  const cancel = async () => {
    const id = operation?.id
    if (!id || cancelling) return
    setCancelling(true)
    pending.current?.abort()
    try {
      await call('close', { id })
      if (selectedRef.current === id)
        updateView(id, { notice: '操作已取消，连接已关闭。', noticeTone: 'info' })
    } catch (cause) {
      if (selectedRef.current === id) updateView(id, { error: `取消未完成：${messageOf(cause)}` })
    } finally {
      if (!lifetime.current?.signal.aborted) setCancelling(false)
    }
  }
  const disconnect = (profile: DatabaseProfile) => {
    if (saving || cancelling) return
    if (operation?.id === profile.id) {
      pending.current?.abort()
      pending.current = null
      setOperation(null)
    }
    void call('close', { id: profile.id }).catch(() => {})
    setViews(current => ({
      ...current,
      [profile.id]: { ...emptyView(profile), sql: current[profile.id]?.sql ?? '' },
    }))
    setExpanded(current =>
      current.filter(key => {
        if (key === databaseNodeKey(profile.id)) return false
        try {
          const parsed: unknown = JSON.parse(key)
          if (Array.isArray(parsed)) {
            return parsed[0] === 'catalog' ? parsed[1] !== profile.id : parsed[0] !== profile.id
          }
        } catch {
          // 非 JSON 格式的分组键直接保留。
        }
        return true
      }),
    )
  }
  const chosen = state.connections.find(item => item.id === selected)
  const view = selected ? (views[selected] ?? emptyView(chosen)) : emptyView()
  const busy = operation !== null || saving || cancelling
  const usable = chosen !== undefined && !chosen.disabled && !busy
  const expandPath = (id: string, schema?: string | null, catalog?: string | null) =>
    setExpanded(current => [
      ...new Set([
        ...current,
        ...(groups.assignments[id] ? [databaseGroupKey(groups.assignments[id])] : []),
        databaseNodeKey(id),
        ...(catalog ? [databaseNodeKey(id, undefined, undefined, catalog)] : []),
        ...(schema ? [databaseNodeKey(id, schema, undefined, catalog)] : []),
      ]),
    ])
  const browse = (profile: DatabaseProfile) =>
    run(
      profile.id,
      '正在读取结构…',
      async signal => {
        if (profile.engine === 'postgresql') {
          const catalogs = await call<string[]>('databases', { id: profile.id }, signal)
          const candidates = orderPostgresCatalogCandidates({
            catalogs,
            previous: views[profile.id]?.catalog,
            configured: profile.database,
          })
          const probed = await loadFirstAccessiblePostgresCatalog({
            candidates,
            previousCatalog: views[profile.id]?.catalog,
            previousSchema: views[profile.id]?.schema,
            configuredDatabase: profile.database,
            fetchSchemas: catalog => call<string[]>('schemas', { id: profile.id, catalog }, signal),
            fetchTables: (catalog, schema) =>
              call<DatabaseTable[]>('tables', { id: profile.id, catalog, schema }, signal),
            messageOf,
            signal,
          })
          return {
            catalogs,
            catalog: probed.catalog,
            schemas: probed.schemas,
            schema: probed.schema,
            tables: probed.tables,
            error: probed.error,
          }
        }
        const schemas = await call<string[]>('schemas', { id: profile.id, catalog: null }, signal)
        const schema = pickDefaultSchema({
          engine: profile.engine,
          schemas,
          previous: views[profile.id]?.schema,
          configured: profile.database,
        })
        const tables = schema
          ? await call<DatabaseTable[]>('tables', { id: profile.id, catalog: null, schema }, signal)
          : []
        return { catalogs: null, catalog: null, schemas, schema, tables, error: null }
      },
      value => {
        setViews(current => {
          const base = current[profile.id] ?? emptyView(profile)
          const tableKey = value.schema ? databaseTableCacheKey(value.schema, value.catalog) : null
          return {
            ...current,
            [profile.id]: {
              ...base,
              catalogs: value.catalogs,
              catalog: value.catalog,
              // 刷新结构时仅保留本次新拉取的库与表缓存，避免已删除对象残留在侧栏树中。
              catalogSchemas:
                value.catalog && value.schemas ? { [value.catalog]: value.schemas } : {},
              failedCatalogs: {},
              schemas: value.schemas,
              schema: value.schema,
              tables: tableKey ? { [tableKey]: value.tables } : {},
              table: null,
              columns: [],
              preview: null,
              page: 0,
              mode: 'tables',
              error: value.error,
              connectionError: value.error,
            },
          }
        })
        expandPath(profile.id, value.schema, value.catalog)
      },
    )
  const selectCatalog = (profile: DatabaseProfile, catalog: string) => {
    const id = profile.id
    const cachedSchemas = views[id]?.catalogSchemas[catalog]
    const cachedSchema = cachedSchemas
      ? pickDefaultSchema({
          engine: profile.engine,
          schemas: cachedSchemas,
          previous: null,
          configured: profile.database,
        })
      : null
    chooseConnection(id)
    expandPath(id, cachedSchema, catalog)
    updateView(id, {
      catalog,
      schemas: cachedSchemas ?? null,
      schema: cachedSchema,
      table: null,
      columns: [],
      preview: null,
      page: 0,
      mode: 'tables',
      error: null,
      notice: null,
    })
    const missingTables =
      cachedSchema !== null && !views[id]?.tables[databaseTableCacheKey(cachedSchema, catalog)]
    if (!cachedSchemas || missingTables)
      void run(
        id,
        '正在读取结构…',
        async signal => {
          let schemas: string[]
          try {
            schemas = cachedSchemas ?? (await call<string[]>('schemas', { id, catalog }, signal))
          } catch (cause) {
            if (!signal.aborted) {
              const reason = messageOf(cause)
              setViews(current => {
                const base = current[id] ?? emptyView(profile)
                return {
                  ...current,
                  [id]: {
                    ...base,
                    failedCatalogs: { ...base.failedCatalogs, [catalog]: reason },
                  },
                }
              })
            }
            throw cause
          }
          const schema =
            cachedSchema ??
            pickDefaultSchema({
              engine: profile.engine,
              schemas,
              previous: null,
              configured: profile.database,
            })
          const tableKey = schema ? databaseTableCacheKey(schema, catalog) : null
          const tables =
            schema && (!tableKey || !views[id]?.tables[tableKey])
              ? await call<DatabaseTable[]>('tables', { id, catalog, schema }, signal)
              : null
          return { schemas, schema, tables }
        },
        value => {
          setViews(current => {
            const base = current[id] ?? emptyView(profile)
            const tableKey = value.schema ? databaseTableCacheKey(value.schema, catalog) : null
            const nextFailed = { ...base.failedCatalogs }
            delete nextFailed[catalog]
            return {
              ...current,
              [id]: {
                ...base,
                catalog,
                catalogSchemas: { ...base.catalogSchemas, [catalog]: value.schemas },
                failedCatalogs: nextFailed,
                connectionError: null,
                schemas: value.schemas,
                schema: value.schema,
                tables:
                  tableKey && value.tables
                    ? { ...base.tables, [tableKey]: value.tables }
                    : base.tables,
              },
            }
          })
          expandPath(id, value.schema, catalog)
        },
      )
  }
  const selectSchema = (profile: DatabaseProfile, schema: string, catalogArg?: string) => {
    const id = profile.id
    const catalog =
      profile.engine === 'postgresql' ? (catalogArg ?? views[id]?.catalog ?? null) : null
    const cachedSchemas = catalog ? views[id]?.catalogSchemas[catalog] : undefined
    const tableKey = databaseTableCacheKey(schema, catalog)
    chooseConnection(id)
    expandPath(id, schema, catalog)
    updateView(id, {
      ...(catalog ? { catalog, ...(cachedSchemas ? { schemas: cachedSchemas } : {}) } : {}),
      schema,
      table: null,
      columns: [],
      preview: null,
      page: 0,
      mode: 'tables',
      error: null,
      notice: null,
    })
    if (!views[id]?.tables[tableKey])
      void run(
        id,
        '正在读取表…',
        signal => call<DatabaseTable[]>('tables', { id, catalog, schema }, signal),
        tables => {
          setViews(current => {
            const base = current[id] ?? emptyView(profile)
            return {
              ...current,
              [id]: { ...base, tables: { ...base.tables, [tableKey]: tables } },
            }
          })
        },
      )
  }
  const selectTable = (
    profile: DatabaseProfile,
    schema: string,
    table: string,
    catalogArg?: string,
  ) => {
    const id = profile.id
    const catalog =
      profile.engine === 'postgresql' ? (catalogArg ?? views[id]?.catalog ?? null) : null
    const cachedSchemas = catalog ? views[id]?.catalogSchemas[catalog] : undefined
    chooseConnection(id)
    expandPath(id, schema, catalog)
    updateView(id, {
      ...(catalog ? { catalog, ...(cachedSchemas ? { schemas: cachedSchemas } : {}) } : {}),
      schema,
      table,
      columns: [],
      preview: null,
      page: 0,
      mode: 'preview',
    })
    void run(
      id,
      '正在读取表…',
      async signal => {
        const columns = await call<DatabaseColumn[]>(
          'columns',
          { id, catalog, schema, table },
          signal,
        )
        const preview = await call<DatabaseResult>(
          'preview',
          { id, catalog, schema, table, page: 0, pageSize: PAGE_SIZE },
          signal,
        )
        return { columns, preview }
      },
      value => updateView(id, value),
    )
  }
  const openObject = (
    profile: DatabaseProfile,
    schema?: string,
    table?: string,
    catalog?: string,
  ) => {
    if (saving || cancelling) return
    if (profile.disabled) {
      chooseConnection(profile.id)
      return
    }
    if (schema && table) selectTable(profile, schema, table, catalog)
    else if (schema) selectSchema(profile, schema, catalog)
    else if (catalog) selectCatalog(profile, catalog)
    else {
      chooseConnection(profile.id)
      expandPath(profile.id)
      const loadedStructure =
        profile.engine === 'postgresql' ? views[profile.id]?.catalogs : views[profile.id]?.schemas
      if (!loadedStructure) void browse(profile)
    }
  }
  const openQuery = (profile: DatabaseProfile, entry?: DatabaseHistoryEntry) => {
    if (profile.disabled || saving || cancelling) return
    chooseConnection(profile.id)
    expandPath(profile.id)
    const currentView = views[profile.id]
    const entryCatalog =
      entry && profile.engine === 'postgresql' && entry.catalog !== undefined
        ? entry.catalog
        : undefined
    const cachedSchemas = entryCatalog ? currentView?.catalogSchemas[entryCatalog] : undefined
    const scopeChanged =
      entry !== undefined &&
      ((entryCatalog !== undefined && entryCatalog !== (currentView?.catalog ?? null)) ||
        entry.schema !== (currentView?.schema ?? null))
    updateView(profile.id, {
      mode: 'sql',
      ...(entry
        ? {
            sql: entry.sql,
            ...(entryCatalog !== undefined ? { catalog: entryCatalog } : {}),
            ...(cachedSchemas ? { schemas: cachedSchemas } : {}),
            schema: entry.schema,
            ...(scopeChanged ? { table: null, columns: [], preview: null, page: 0 } : {}),
            query: null,
          }
        : {}),
    })
  }
  const previewPage = (page: number) => {
    if (!chosen || !view.schema || !view.table) return
    const id = chosen.id,
      catalog = chosen.engine === 'postgresql' ? view.catalog : null,
      schema = view.schema,
      table = view.table
    void run(
      id,
      '正在读取数据…',
      signal =>
        call<DatabaseResult>(
          'preview',
          { id, catalog, schema, table, page, pageSize: PAGE_SIZE },
          signal,
        ),
      preview => updateView(id, { preview, page }),
    )
  }
  const query = () => {
    if (!chosen || !view.sql.trim() || !usable) return
    const id = chosen.id,
      sql = view.sql,
      catalog = chosen.engine === 'postgresql' ? view.catalog : null,
      schema = view.schema
    updateView(id, { query: null })
    void run(
      id,
      '正在执行查询…',
      signal => call<DatabaseResult>('query', { id, catalog, schema, sql }, signal),
      result => {
        updateView(id, { query: result })
        history.record({ profile: chosen, catalog, schema, sql, result })
      },
    )
  }
  const edit = (profile: DatabaseProfile | 'new', initialTab = 'connection') => {
    form.resetFields()
    form.setFieldsValue(
      profile === 'new'
        ? {
            engine: 'mysql',
            name: '',
            host: '',
            port: 3306,
            username: '',
            database: null,
            filePath: '',
            tlsEnabled: false,
            tlsServerName: '',
            tlsCa: '',
            sshConnectionId: null,
            environment: '',
            projectId: workspace.selectedProjectId,
            disabled: false,
          }
        : {
            ...profile,
            filePath: profile.filePath ?? '',
            tlsEnabled: profile.tlsEnabled !== false,
          },
    )
    setAgentAccess(
      profile === 'new' ? createDefaultAgentAccess() : cloneAgentAccess(profile.agentAccess),
    )
    setError(null)
    setFormTab(initialTab)
    setEditing(profile)
    void callRemote('mydshSsh/status', {}, lifetime.current?.signal)
      .then(value => {
        if (!lifetime.current?.signal.aborted) setSsh((value as SshStatus).connections)
      })
      .catch(report)
  }
  const save = async () => {
    if (saving) return
    const values = await form.validateFields()
    const previous = editing === 'new' ? null : editing
    const engine: DatabaseEngine =
      (values.engine as DatabaseEngine | undefined) ??
      (form.getFieldValue('engine') as DatabaseEngine | undefined) ??
      previous?.engine ??
      'mysql'
    const normalizedAccess: DatabaseAgentAccess = {
      ...agentAccess,
      tableRules: agentAccess.tableRules.map(rule => ({
        ...rule,
        schema: rule.schema.trim(),
        table: rule.table.trim(),
      })),
    }
    const accessError = validateAgentAccessDraft(normalizedAccess, engine)
    if (accessError) {
      setError(accessError)
      setFormTab('agentAccess')
      return
    }
    if (savePending.current) return
    savePending.current = true
    setSaving(true)
    setError(null)
    try {
      const request: SaveDatabaseProfile =
        engine === 'sqlite'
          ? {
              id: previous?.id ?? null,
              revision: previous?.revision ?? null,
              engine,
              name: values.name.trim(),
              host: '',
              port: 0,
              username: '',
              database: null,
              filePath: (values.filePath ?? '').trim(),
              tlsEnabled: false,
              tlsServerName: '',
              tlsCa: '',
              sshConnectionId: null,
              environment: values.environment?.trim() ?? '',
              projectId: values.projectId ?? null,
              disabled: values.disabled ?? false,
              agentAccess: normalizedAccess,
            }
          : {
              id: previous?.id ?? null,
              revision: previous?.revision ?? null,
              engine,
              name: values.name.trim(),
              host: (values.host ?? '').trim(),
              port: values.port,
              username: (values.username ?? '').trim(),
              database: values.database?.trim() || null,
              filePath: null,
              tlsEnabled: values.tlsEnabled === true,
              tlsServerName: values.tlsServerName?.trim() ?? '',
              tlsCa: values.tlsCa?.trim() ?? '',
              sshConnectionId: values.sshConnectionId ?? null,
              environment: values.environment?.trim() ?? '',
              projectId: values.projectId ?? null,
              disabled: values.disabled ?? false,
              agentAccess: normalizedAccess,
              ...(values.password ? { password: values.password } : {}),
            }
      const saved = await call<DatabaseProfile>('save', { request })
      if (lifetime.current?.signal.aborted) return
      form.resetFields()
      setEditing(null)
      setSelected(saved.id)
      selectedRef.current = saved.id
      // 更新目标后保留 SQL 草稿，清除属于旧连接目标的结构和结果。
      setViews(current => ({
        ...current,
        [saved.id]: { ...emptyView(saved), sql: current[saved.id]?.sql ?? '' },
      }))
      await refresh()
    } catch (cause) {
      report(cause)
    } finally {
      savePending.current = false
      if (!lifetime.current?.signal.aborted) setSaving(false)
    }
  }
  const remove = (profile: DatabaseProfile) =>
    modal.confirm({
      title: `删除“${profile.name}”？`,
      content: '将关闭此数据库连接，删除本机保存的连接配置和凭据。数据库中的数据不受影响。',
      okText: '删除连接',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: async () => {
        setSaving(true)
        try {
          await call('remove', { id: profile.id, revision: profile.revision })
          await refresh()
        } catch (cause) {
          report(cause)
          throw cause
        } finally {
          if (!lifetime.current?.signal.aborted) setSaving(false)
        }
      },
    })
  const result = view.mode === 'sql' ? view.query : view.preview
  const activeCatalog = chosen?.engine === 'postgresql' ? view.catalog : null
  const structureLoaded = chosen
    ? chosen.engine === 'postgresql'
      ? Boolean(view.catalogs)
      : Boolean(view.schemas)
    : false
  const tables = view.schema
    ? view.tables[databaseTableCacheKey(view.schema, activeCatalog)]
    : undefined
  const showingTable = view.mode === 'preview' || view.mode === 'columns'
  const connectionStates: Record<string, DatabaseConnectionState> = Object.fromEntries(
    state.connections.map(item => [
      item.id,
      resolveConnectionState({
        profile: item,
        view: views[item.id],
        connectingId: operation?.id ?? null,
        busyIds: state.busyIds,
      }),
    ]),
  )
  const chosenState: DatabaseConnectionState = chosen
    ? (connectionStates[chosen.id] ?? 'disconnected')
    : 'disconnected'
  const activeError = error ?? view.error
  const showFloatingFeedback = workspace.activeView === 'database' && editing === null
  const testConnection = (profile: DatabaseProfile | undefined = chosen) => {
    if (!profile || profile.disabled || busy) return
    if (selectedRef.current !== profile.id) chooseConnection(profile.id)
    const label = engineMeta(profile.engine).label
    void run(
      profile.id,
      '正在测试连接…',
      signal => call<DatabaseTestResult>('test', { id: profile.id }, signal),
      tested => {
        const version = tested.serverVersion.trim()
        const prefixed =
          version && !version.toLowerCase().includes(label.toLowerCase())
            ? `${label} ${version}`
            : version || label
        updateView(profile.id, {
          notice: `连接测试成功 · ${prefixed}`,
          noticeTone: 'success',
          connectionError: null,
        })
      },
    )
  }
  return (
    <section
      className="connections-workspace database-workspace"
      aria-label="数据库连接"
      data-database-workspace
    >
      {modalContext}
      {showFloatingFeedback && activeError && (
        <AppAlert
          tone="error"
          title="数据库操作未完成"
          floating
          dismissAfterMs={8_000}
          onClose={() => {
            setError(null)
            if (selected) updateView(selected, { error: null })
          }}
        >
          {activeError}
        </AppAlert>
      )}
      {showFloatingFeedback && !activeError && view.notice && (
        <AppAlert
          tone={view.noticeTone}
          title={view.notice}
          floating
          dismissAfterMs={4_500}
          onClose={() => {
            if (selected) updateView(selected, { notice: null })
          }}
        />
      )}
      <ConnectionsSidebarContent group="databases">
        <DatabaseSidebar
          groups={groups}
          busy={busy}
          loaded={loaded}
          supported={state.supported}
          onAdd={() => {
            ensureDatabaseView()
            edit('new')
          }}
          onRefresh={() => {
            void refresh().catch(report)
          }}
          connections={state.connections}
          views={views}
          connectionStates={connectionStates}
          selected={selected}
          catalog={structureLoaded ? activeCatalog : null}
          schema={structureLoaded ? view.schema : null}
          table={showingTable ? view.table : null}
          expanded={expanded}
          search={search}
          disabled={saving || cancelling}
          onSearch={setSearch}
          onExpand={setExpanded}
          onOpen={(profile, schema, table, catalog) => {
            ensureDatabaseView()
            openObject(profile, schema, table, catalog)
          }}
          connectionActions={{
            busy,
            isConnected: id => connectionStates[id] === 'connected',
            onDisconnect: disconnect,
            onEdit: profile => {
              ensureDatabaseView()
              edit(profile)
            },
            onEditAccess: profile => {
              ensureDatabaseView()
              edit(profile, 'agentAccess')
            },
            onTest: profile => {
              ensureDatabaseView()
              testConnection(profile)
            },
            onRemove: remove,
          }}
        />
      </ConnectionsSidebarContent>
      <main className="connections-content database-content">
        {!state.supported ? (
          <div className="connections-empty">
            <Database size={28} />
            <h3>数据库连接暂仅支持 macOS 与 Windows</h3>
          </div>
        ) : !chosen ? (
          <DatabaseHome
            connections={state.connections}
            connectionStates={connectionStates}
            history={history.entries}
            loaded={loaded}
            busy={busy}
            onAdd={() => edit('new')}
            onOpen={openObject}
            onNewQuery={openQuery}
            onRestore={entry => {
              const profile = state.connections.find(item => item.id === entry.connectionId)
              if (profile) openQuery(profile, entry)
            }}
            onRefresh={() => {
              void refresh().catch(report)
            }}
          />
        ) : (
          <>
            <header className="connections-heading database-heading">
              <div className="database-heading-title">
                <Button
                  type="text"
                  aria-label="返回数据库首页"
                  title="返回数据库首页"
                  icon={<ChevronLeft size={17} />}
                  disabled={saving || cancelling}
                  onClick={() => chooseConnection(null)}
                />
                <span className="database-heading-icon" data-engine={chosen.engine}>
                  <DatabaseEngineIcon engine={chosen.engine} size={20} />
                </span>
                <div>
                  <div className="database-heading__title-row">
                    <h2 title={chosen.name}>{chosen.name}</h2>
                    <span
                      className={`database-state-pill database-state-pill--${chosenState}`}
                      data-connection-state={chosenState}
                    >
                      <i aria-hidden="true" />
                      {connectionStateLabel(chosenState)}
                    </span>
                  </div>
                  <p title={formatConnectionTooltip(chosen)}>{formatConnectionSummary(chosen)}</p>
                </div>
              </div>
              <div className="connections-actions">
                <Button
                  size="small"
                  type={structureLoaded ? 'default' : 'primary'}
                  disabled={!usable}
                  icon={<RefreshCw size={13} />}
                  onClick={() => {
                    void browse(chosen)
                  }}
                >
                  {structureLoaded ? '刷新结构' : '连接数据库'}
                </Button>
                {chosenState === 'connected' && (
                  <Button
                    size="small"
                    disabled={busy}
                    aria-label="断开当前数据库连接"
                    title="断开连接"
                    icon={<Unplug size={13} />}
                    onClick={() => disconnect(chosen)}
                  >
                    断开
                  </Button>
                )}
                <Dropdown
                  trigger={['click']}
                  menu={{
                    items: [
                      ...(chosenState === 'connected'
                        ? [
                            {
                              key: 'disconnect',
                              label: '断开连接',
                              disabled: busy,
                              onClick: () => disconnect(chosen),
                            },
                            { type: 'divider' as const },
                          ]
                        : []),
                      {
                        key: 'edit',
                        label: '编辑连接',
                        disabled: busy,
                        onClick: () => edit(chosen),
                      },
                      {
                        key: 'agentAccess',
                        label: 'Agent 权限配置',
                        disabled: busy,
                        onClick: () => edit(chosen, 'agentAccess'),
                      },
                      {
                        key: 'test',
                        label: '测试连接',
                        disabled: !usable,
                        onClick: () => testConnection(chosen),
                      },
                      { type: 'divider' },
                      {
                        key: 'remove',
                        label: '删除连接',
                        danger: true,
                        disabled: busy,
                        onClick: () => remove(chosen),
                      },
                    ],
                  }}
                >
                  <Button
                    size="small"
                    type="text"
                    aria-label="数据库连接操作"
                    title="连接操作"
                    icon={<MoreHorizontal size={18} />}
                  />
                </Dropdown>
              </div>
            </header>
            <div className="database-subbar">
              <nav className="database-object-path" aria-label="当前数据库对象">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => updateView(chosen.id, { mode: 'tables' })}
                >
                  {chosen.name}
                </button>
                {structureLoaded && activeCatalog && (
                  <>
                    <ChevronRight size={12} aria-hidden="true" />
                    <button
                      type="button"
                      disabled={busy || chosen.disabled}
                      onClick={() => selectCatalog(chosen, activeCatalog)}
                    >
                      {activeCatalog}
                    </button>
                  </>
                )}
                {structureLoaded && view.schema && (
                  <>
                    <ChevronRight size={12} aria-hidden="true" />
                    <button
                      type="button"
                      disabled={busy || chosen.disabled}
                      onClick={() => selectSchema(chosen, view.schema!, activeCatalog ?? undefined)}
                    >
                      {view.schema}
                    </button>
                  </>
                )}
                {showingTable && view.table && (
                  <>
                    <ChevronRight size={12} aria-hidden="true" />
                    <strong title={view.table}>{view.table}</strong>
                    <span className="database-object-path__count">{view.columns.length} 字段</span>
                  </>
                )}
              </nav>
              <div
                className="database-readonly-pill"
                role="note"
                aria-label="数据库只读说明"
                title="工作区手动浏览仅只读（单条 SELECT）· 模型可按「Agent 权限」读写或 DDL（写入/DDL 需你确认）"
              >
                <LockKeyhole size={12} aria-hidden="true" />
                <span>只读浏览（单条 SELECT）· 模型变更需确认</span>
              </div>
            </div>
            <div className="database-toolbar-row">
              <nav className="database-view-tabs" aria-label="数据库视图">
                {(['tables', 'preview', 'columns', 'sql'] as const).map(mode => (
                  <button
                    type="button"
                    key={mode}
                    disabled={(mode === 'preview' || mode === 'columns') && !view.table}
                    aria-pressed={view.mode === mode}
                    onClick={() => updateView(chosen.id, { mode })}
                  >
                    {mode === 'tables'
                      ? '表列表'
                      : mode === 'preview'
                        ? '表数据'
                        : mode === 'columns'
                          ? '字段结构'
                          : 'SQL 查询'}
                  </button>
                ))}
              </nav>
              <div className="database-toolbar-row__actions">
                {showingTable && view.table && (
                  <Button
                    type="text"
                    size="small"
                    aria-label="刷新表数据"
                    title="刷新表数据与字段"
                    disabled={!usable}
                    icon={<RefreshCw size={13} />}
                    onClick={() =>
                      selectTable(chosen, view.schema!, view.table!, activeCatalog ?? undefined)
                    }
                  >
                    刷新表
                  </Button>
                )}
              </div>
            </div>
            {view.mode === 'sql' && (
              <div className="database-sql">
                <div className="database-sql__header">
                  <label htmlFor="database-sql-input">SQL 草稿</label>
                  <span className="database-sql__shortcut">⌘↵ / Ctrl+Enter 运行</span>
                </div>
                <Input.TextArea
                  id="database-sql-input"
                  aria-label="SQL 查询内容"
                  value={view.sql}
                  spellCheck={false}
                  autoSize={false}
                  rows={5}
                  placeholder="SELECT * FROM table_name LIMIT 100;"
                  onChange={event => updateView(chosen.id, { sql: event.target.value })}
                  onKeyDown={event => {
                    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                      event.preventDefault()
                      query()
                    }
                  }}
                />
                <div className="database-sql-actions">
                  <details>
                    <summary>支持的读取范围</summary>
                    <p>
                      单条 SELECT，支持单表筛选、排序及常见聚合。暂不支持 JOIN、子查询、CTE 或
                      UNION。
                    </p>
                  </details>
                  <Button
                    type="primary"
                    size="small"
                    icon={<Play size={13} />}
                    disabled={!usable || !view.sql.trim()}
                    onClick={query}
                  >
                    运行查询
                  </Button>
                </div>
              </div>
            )}
            <div
              className="database-operation"
              role="status"
              aria-live="polite"
              hidden={!operation && !chosen.disabled}
            >
              <span>
                {operation?.id === chosen.id
                  ? operation.label
                  : chosen.disabled
                    ? '连接已禁用，请在连接操作中编辑并启用。'
                    : ''}
              </span>
              {operation && (
                <Button
                  size="small"
                  icon={<Square size={12} />}
                  loading={cancelling}
                  onClick={() => {
                    void cancel()
                  }}
                >
                  取消
                </Button>
              )}
            </div>
            {view.mode === 'tables' ? (
              <div
                className="database-results database-object-list"
                tabIndex={0}
                aria-label="数据库表列表"
              >
                {tables?.length ? (
                  <table>
                    <thead>
                      <tr>
                        <th>对象名称</th>
                        <th>类型</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tables.map(item => (
                        <tr
                          key={item.name}
                          className={view.table === item.name ? 'is-selected' : undefined}
                          onClick={event => {
                            if (
                              event.defaultPrevented ||
                              chosen.disabled ||
                              saving ||
                              cancelling ||
                              (event.target instanceof Element && event.target.closest('button'))
                            )
                              return
                            selectTable(chosen, view.schema!, item.name, activeCatalog ?? undefined)
                          }}
                        >
                          <td>
                            <button
                              type="button"
                              disabled={chosen.disabled || saving || cancelling}
                              onClick={() =>
                                selectTable(
                                  chosen,
                                  view.schema!,
                                  item.name,
                                  activeCatalog ?? undefined,
                                )
                              }
                            >
                              {item.kind === 'table' ? (
                                <Table2 size={15} className="database-tree-table-icon" />
                              ) : (
                                <Eye size={15} className="database-tree-view-icon" />
                              )}
                              <span className="database-object-list__name">{item.name}</span>
                              <ChevronRight size={13} className="database-object-list__arrow" />
                            </button>
                          </td>
                          <td>
                            <span
                              className={`database-kind-badge database-kind-badge--${item.kind}`}
                            >
                              {tableKindLabel(item.kind)}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <div className="database-empty-result">
                    <span className="database-empty-result__icon" aria-hidden="true">
                      <Database size={24} />
                    </span>
                    <p>
                      {activeCatalog && view.failedCatalogs[activeCatalog]
                        ? `无法访问数据库「${activeCatalog}」：${view.failedCatalogs[activeCatalog]}`
                        : emptyTableMessage({
                            busy: Boolean(operation),
                            structureLoaded,
                            hasTablesEntry: Boolean(tables),
                            hasSchema: Boolean(view.schema),
                          })}
                    </p>
                    {!operation && (
                      <Button
                        size="small"
                        type="primary"
                        disabled={!usable}
                        onClick={() => {
                          if (structureLoaded && view.schema)
                            selectSchema(chosen, view.schema, activeCatalog ?? undefined)
                          else if (structureLoaded && activeCatalog)
                            selectCatalog(chosen, activeCatalog)
                          else void browse(chosen)
                        }}
                      >
                        {!structureLoaded ? '连接并加载结构' : '重新读取'}
                      </Button>
                    )}
                  </div>
                )}
              </div>
            ) : view.mode === 'columns' ? (
              <div
                className="database-results database-columns-list"
                tabIndex={0}
                aria-label="字段结构表"
              >
                {view.columns.length ? (
                  <table>
                    <thead>
                      <tr>
                        <th>字段</th>
                        <th>类型</th>
                        <th>允许 NULL</th>
                        <th>索引</th>
                      </tr>
                    </thead>
                    <tbody>
                      {view.columns.map(column => (
                        <tr key={column.name}>
                          <td>
                            <code className="database-col-name">{column.name}</code>
                          </td>
                          <td>
                            <code className="database-type-badge">{column.type}</code>
                          </td>
                          <td>
                            <span
                              className={
                                column.nullable
                                  ? 'database-null-badge is-nullable'
                                  : 'database-null-badge'
                              }
                            >
                              {column.nullable ? '是' : '否'}
                            </span>
                          </td>
                          <td>
                            {column.key ? (
                              <span className="database-key-badge">{column.key}</span>
                            ) : (
                              <span className="database-col-empty">—</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <div className="database-empty-result">
                    <span className="database-empty-result__icon" aria-hidden="true">
                      <Table2 size={22} />
                    </span>
                    <p>选择数据表查看字段结构。</p>
                  </div>
                )}
              </div>
            ) : (
              <ResultTable
                result={result}
                offset={view.mode === 'preview' ? view.page * PAGE_SIZE : 0}
                empty={
                  operation
                    ? '正在读取数据…'
                    : view.mode === 'sql'
                      ? '输入 SQL 并运行，结果会显示在这里。'
                      : '选择左侧数据表预览前 100 行。'
                }
              />
            )}
            <footer className="database-result-footer">
              <span className="database-result-footer__summary">
                {view.mode === 'tables'
                  ? `${tables?.length ?? 0} 个对象`
                  : view.mode === 'columns'
                    ? `${view.columns.length} 个字段`
                    : result
                      ? `${result.rowCount} 行 · ${(result.bytes / 1024).toFixed(1)} KB · ${result.elapsedMs} ms${result.truncated ? (view.mode === 'preview' && result.rowCount === PAGE_SIZE ? ' · 还有更多数据' : ' · 已达到结果上限，请用 SQL 缩小读取范围') : ''}`
                      : '尚无结果'}
              </span>
              <div className="database-result-footer__right">
                {view.mode === 'preview' && result && (
                  <div className="connections-actions database-pagination">
                    <span>100 行 / 页</span>
                    <Button
                      size="small"
                      aria-label="上一页数据"
                      icon={<ChevronLeft size={14} />}
                      disabled={!usable || view.page === 0}
                      onClick={() => previewPage(view.page - 1)}
                    />
                    <span>第 {view.page + 1} 页</span>
                    <Button
                      size="small"
                      aria-label="下一页数据"
                      icon={<ChevronRight size={14} />}
                      disabled={!usable || !result.truncated || result.rowCount < PAGE_SIZE}
                      onClick={() => previewPage(view.page + 1)}
                    />
                  </div>
                )}
                <span className="database-connection-note">
                  {chosen.engine === 'sqlite'
                    ? `本地 SQLite · ${formatAgentAccessSummary(chosen.agentAccess ?? createDefaultAgentAccess())}`
                    : `${chosen.sshConnectionId ? 'SSH 通道' : '直连'} · TLS ${chosen.tlsEnabled !== false ? '开启' : '关闭'} · ${formatAgentAccessSummary(chosen.agentAccess ?? createDefaultAgentAccess())}`}
                  {view.mode === 'sql' ? ' · 最多 500 行 / 20 秒超时' : ''}
                </span>
              </div>
            </footer>
          </>
        )}
      </main>
      <DatabaseConnectionModal
        editing={editing}
        saving={saving}
        error={error}
        form={form}
        formTab={formTab}
        agentAccess={agentAccess}
        ssh={ssh}
        projects={workspace.projects}
        availableSchemas={editing !== 'new' && editing ? (views[editing.id]?.schemas ?? []) : []}
        availableTables={
          editing !== 'new' && editing
            ? tablesBySchemaForCatalog(
                views[editing.id]?.schemas ?? null,
                views[editing.id]?.tables ?? {},
                editing.engine === 'postgresql' ? (views[editing.id]?.catalog ?? null) : null,
              )
            : {}
        }
        onTabChange={setFormTab}
        onAgentAccessChange={setAgentAccess}
        onSave={() => {
          void save().catch(cause => {
            if (cause && typeof cause === 'object' && 'errorFields' in cause)
              setFormTab('connection')
            else report(cause)
          })
        }}
        onCancel={() => {
          if (!saving) {
            form.resetFields()
            setEditing(null)
          }
        }}
        onReportError={report}
      />
    </section>
  )
}

function ResultTable({
  result,
  empty,
  offset,
}: {
  result: DatabaseResult | null
  empty: string
  offset: number
}) {
  return (
    <div className="database-results" tabIndex={0} aria-label="数据库查询结果">
      {result ? (
        <>
          <table>
            <thead>
              <tr>
                <th className="database-row-number" aria-label="行号">
                  #
                </th>
                {result.columns.map((column, index) => (
                  <th key={index} title={column.type}>
                    {column.name}
                    <small>{column.type}</small>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  <td className="database-row-number">{offset + rowIndex + 1}</td>
                  {row.map((cell, index) => (
                    <td key={index}>
                      {cell === null ? (
                        <em className="database-null">NULL</em>
                      ) : (
                        <span title={cell}>{cell}</span>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {result.rows.length === 0 && (
            <p className="database-empty-result">查询完成，没有返回记录。</p>
          )}
        </>
      ) : (
        <div className="database-empty-result">
          <Table2 size={24} />
          <p>{empty}</p>
        </div>
      )}
    </div>
  )
}
