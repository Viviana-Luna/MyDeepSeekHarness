/** renderer 数据库对象树，负责分组展示、连接与库级实时状态标识、PostgreSQL 四级展开（连接→库→Schema→对象）和已加载对象搜索。 */
import { Popover, Tree, type TreeDataNode } from 'antd'
import { AlertTriangle, Database, Eye, Layers, Table2 } from 'lucide-react'
import type { ReactNode } from 'react'
import type {
  DatabaseProfile,
  DatabaseTable,
} from '../../../../../packages/connections/database/types.d.ts'
import { engineMeta } from './database-engine-meta.ts'
import {
  connectionStateLabel,
  databaseTableCacheKey,
  isSystemDatabaseNamespace,
  resolveConnectionState,
  tableKindLabel,
  type DatabaseConnectionState,
} from './database-workspace-helpers.ts'
import { DatabaseEngineIcon } from './DatabaseEngineIcon.tsx'
import {
  groupDatabaseNodes,
  type DatabaseConnectionMenuActions,
  type DatabaseGrouping,
  type DatabaseGroupNode,
} from './DatabaseTreeGroups.tsx'

/** 连接、物理库、命名空间与表使用同一套稳定对象键。 */
export const databaseNodeKey = (
  id: string,
  schema?: string,
  table?: string,
  catalog?: string | null,
) =>
  catalog
    ? JSON.stringify(['catalog', id, catalog, schema, table])
    : JSON.stringify([id, schema, table])

/** 对应实际连接或库表对象的树节点，分组不参与远端读取。 */
export interface ObjectNode extends Omit<TreeDataNode, 'children' | 'title'> {
  title: ReactNode
  profile: DatabaseProfile
  catalog?: string
  schema?: string
  table?: string
  name: string
  needsLoad: boolean
  children?: ObjectNode[]
}

/** 左侧对象树使用的连接视图结构。 */
export interface NavigatorConnectionView {
  schemas: string[] | null
  tables: Record<string, DatabaseTable[]>
  catalogs?: string[] | null
  catalog?: string | null
  catalogSchemas?: Record<string, string[]>
  connectionError?: string | null
  failedCatalogs?: Record<string, string>
}

const parentKeys = (items: (ObjectNode | DatabaseGroupNode)[]): string[] =>
  items.flatMap(node =>
    node.children?.length ? [String(node.key), ...parentKeys(node.children)] : [],
  )

function tableTitle(item: DatabaseTable): string {
  return item.kind === 'table' ? item.name : `${item.name}（${tableKindLabel(item.kind)}）`
}

function renderConnectionIndicator(
  profile: DatabaseProfile,
  state: DatabaseConnectionState,
  view: NavigatorConnectionView | undefined,
): ReactNode {
  if (profile.disabled) return <small className="database-tree-engine">已禁用</small>
  if (state === 'connecting') {
    return (
      <span
        className="database-status-dot database-status-dot--connecting"
        role="img"
        data-connection-state="connecting"
        aria-label="连接中"
        title="正在连接数据库…"
      />
    )
  }
  if (state === 'connected') {
    const failed = Object.entries(view?.failedCatalogs ?? {})
    const warnTitle = failed.map(([name, reason]) => `${name}：${reason}`).join('\n')
    return (
      <>
        <span
          className="database-status-dot database-status-dot--connected"
          role="img"
          data-connection-state="connected"
          aria-label="已连接"
          title="已连接"
        />
        {failed.length > 0 && (
          <span
            className="database-tree-warn"
            role="img"
            aria-label="部分数据库无法访问"
            title={warnTitle}
          >
            <AlertTriangle size={12} aria-hidden="true" />
          </span>
        )}
      </>
    )
  }
  if (state === 'error') {
    return (
      <span
        className="database-tree-warn database-tree-warn--error"
        role="img"
        data-connection-state="error"
        aria-label="连接异常"
        title={view?.connectionError ?? '连接异常'}
      >
        <AlertTriangle size={12} aria-hidden="true" />
      </span>
    )
  }
  return null
}

function buildTableNodes(input: {
  profile: DatabaseProfile
  schema: string
  catalog?: string
  items: readonly DatabaseTable[] | undefined
}): ObjectNode[] {
  const { profile, schema, catalog, items } = input
  return (
    items?.map(item => {
      const node: ObjectNode = {
        key: databaseNodeKey(profile.id, schema, item.name, catalog),
        name: item.name,
        profile,
        schema,
        table: item.name,
        needsLoad: false,
        isLeaf: true,
        icon:
          item.kind === 'table' ? (
            <Table2 size={14} className="database-tree-table-icon" />
          ) : (
            <Eye size={14} className="database-tree-view-icon" />
          ),
        title: (
          <span
            className="database-tree-title"
            data-database-table={item.name}
            title={tableTitle(item)}
          >
            <span>{item.name}</span>
          </span>
        ),
      }
      if (catalog) node.catalog = catalog
      return node
    }) ?? []
  )
}

function buildSchemaNodes(input: {
  profile: DatabaseProfile
  schemas: readonly string[] | undefined | null
  tables: Readonly<Record<string, DatabaseTable[]>>
  catalog?: string
}): ObjectNode[] {
  const { profile, schemas, tables, catalog } = input
  const isTopDatabaseLevel = catalog === undefined
  return (
    schemas?.map(name => {
      const cached = tables[databaseTableCacheKey(name, catalog)]
      const isSystem = isSystemDatabaseNamespace(name)
      const isLoaded = cached !== undefined
      const icon = isTopDatabaseLevel ? (
        <Database
          size={14}
          className={isLoaded ? 'database-tree-db-icon is-active' : 'database-tree-db-icon'}
        />
      ) : (
        <Layers
          size={13}
          className={isSystem ? 'database-tree-schema-icon is-system' : 'database-tree-schema-icon'}
        />
      )
      const node: ObjectNode = {
        key: databaseNodeKey(profile.id, name, undefined, catalog),
        name,
        profile,
        schema: name,
        needsLoad: !isLoaded,
        isLeaf: cached?.length === 0,
        icon,
        title: (
          <span className="database-tree-title" data-database-schema={name} title={name}>
            <span className={isSystem ? 'database-tree-muted' : undefined}>{name}</span>
            {isTopDatabaseLevel && isLoaded && (
              <span
                className="database-status-dot database-status-dot--connected"
                role="img"
                data-schema-state="connected"
                aria-label="已连接"
                title="已加载此库"
              />
            )}
            {cached && <small>{cached.length}</small>}
          </span>
        ),
        children: buildTableNodes({
          profile,
          schema: name,
          ...(catalog ? { catalog } : {}),
          items: cached,
        }),
      }
      if (catalog) node.catalog = catalog
      return node
    }) ?? []
  )
}

function buildPostgresCatalogNodes(
  profile: DatabaseProfile,
  view: NavigatorConnectionView | undefined,
): ObjectNode[] {
  return (
    view?.catalogs?.map(catalog => {
      const dbSchemas =
        view.catalogSchemas?.[catalog] ??
        (view.catalog === catalog && view.schemas ? view.schemas : undefined)
      const isLoaded = Array.isArray(dbSchemas)
      const failedReason = view.failedCatalogs?.[catalog]
      return {
        key: databaseNodeKey(profile.id, undefined, undefined, catalog),
        name: catalog,
        profile,
        catalog,
        needsLoad: !isLoaded,
        isLeaf: dbSchemas?.length === 0,
        icon: (
          <Database
            size={14}
            className={isLoaded ? 'database-tree-db-icon is-active' : 'database-tree-db-icon'}
          />
        ),
        title: (
          <span
            className="database-tree-title"
            data-database-catalog={catalog}
            title={failedReason ? `${catalog}（${failedReason}）` : catalog}
          >
            <span>{catalog}</span>
            {isLoaded && (
              <span
                className="database-status-dot database-status-dot--connected"
                role="img"
                data-catalog-state="connected"
                aria-label="已连接"
                title="已加载此库"
              />
            )}
            {!isLoaded && failedReason && (
              <span
                className="database-tree-warn"
                role="img"
                data-catalog-state="error"
                aria-label="无法连接此库"
                title={failedReason}
              >
                <AlertTriangle size={12} aria-hidden="true" />
              </span>
            )}
            {dbSchemas && <small>{dbSchemas.length}</small>}
          </span>
        ),
        children: buildSchemaNodes({
          profile,
          schemas: dbSchemas,
          tables: view.tables,
          catalog,
        }),
      }
    }) ?? []
  )
}

function ConnectionHoverCard({
  profile,
  state,
  view,
}: {
  profile: DatabaseProfile
  state: DatabaseConnectionState
  view: NavigatorConnectionView | undefined
}) {
  const rows: [string, string][] = [
    ['名称', profile.name],
    ['类型', engineMeta(profile.engine).label],
  ]
  if (profile.engine === 'sqlite') {
    rows.push(['路径', profile.filePath || '本地数据库文件'])
  } else {
    rows.push(['主机', profile.host], ['端口', String(profile.port)], ['用户名', profile.username])
    if (profile.database) rows.push(['默认库', profile.database])
    if (profile.sshConnectionId) rows.push(['通道', 'SSH 通道'])
  }
  const failedCount = Object.keys(view?.failedCatalogs ?? {}).length
  return (
    <dl
      className="database-connection-card"
      onClick={event => {
        // 阻止悬停详情卡片内的点击经由 Portal 冒泡回 Tree.onSelect 误触发连接打开。
        event.stopPropagation()
      }}
    >
      {rows.map(([label, value]) => (
        <div key={label} className="database-connection-card__row">
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
      <div className="database-connection-card__row">
        <dt>状态</dt>
        <dd className="database-connection-card__status">
          <span
            className={`database-status-dot database-status-dot--${state}`}
            aria-hidden="true"
          />
          <span>
            {connectionStateLabel(state)}
            {failedCount > 0 ? `（${String(failedCount)} 个库受限）` : ''}
          </span>
        </dd>
      </div>
      {view?.connectionError && (
        <div className="database-connection-card__row database-connection-card__row--error">
          <dt>异常</dt>
          <dd>{view.connectionError}</dd>
        </div>
      )}
    </dl>
  )
}

function buildConnectionNode(
  profile: DatabaseProfile,
  view: NavigatorConnectionView | undefined,
  state: DatabaseConnectionState,
): ObjectNode {
  const isPg = profile.engine === 'postgresql'
  return {
    key: databaseNodeKey(profile.id),
    name: profile.name,
    profile,
    needsLoad: isPg ? !view?.catalogs : !view?.schemas,
    isLeaf: isPg ? view?.catalogs?.length === 0 : view?.schemas?.length === 0,
    icon: <DatabaseEngineIcon engine={profile.engine} size={16} />,
    title: (
      <Popover
        trigger={['hover', 'focus']}
        placement="right"
        mouseEnterDelay={0.35}
        mouseLeaveDelay={0.08}
        classNames={{ root: 'database-connection-popover' }}
        content={<ConnectionHoverCard profile={profile} state={state} view={view} />}
      >
        <span className="database-tree-title" data-database-connection={profile.id}>
          <span>{profile.name}</span>
          {renderConnectionIndicator(profile, state, view)}
        </span>
      </Popover>
    ),
    children: isPg
      ? buildPostgresCatalogNodes(profile, view)
      : buildSchemaNodes({
          profile,
          schemas: view?.schemas,
          tables: view?.tables ?? {},
        }),
  }
}

/** 搜索仅过滤已加载的对象，不为输入关键词发起数据库请求。 */
export function DatabaseNavigator({
  connections,
  views,
  connectionStates,
  selected,
  catalog,
  schema,
  table,
  expanded,
  search,
  disabled,
  onExpand,
  onOpen,
  grouping,
  connectionActions,
}: {
  connections: DatabaseProfile[]
  views: Record<string, NavigatorConnectionView>
  connectionStates?: Readonly<Record<string, DatabaseConnectionState>>
  selected: string | null
  catalog?: string | null
  schema: string | null
  table: string | null
  expanded: string[]
  search: string
  disabled: boolean
  onExpand(keys: string[]): void
  onOpen(profile: DatabaseProfile, schema?: string, table?: string, catalog?: string): void
  grouping: DatabaseGrouping
  connectionActions: DatabaseConnectionMenuActions
}) {
  const nodes: ObjectNode[] = connections.map(profile => {
    const view = views[profile.id]
    const state =
      connectionStates?.[profile.id] ??
      resolveConnectionState({ profile, view, connectingId: null, busyIds: [] })
    return buildConnectionNode(profile, view, state)
  })
  const needle = search.trim().toLocaleLowerCase()
  const filter = (items: ObjectNode[]): ObjectNode[] =>
    items.flatMap(node => {
      if (node.name.toLocaleLowerCase().includes(needle)) return [node]
      const children = node.children ? filter(node.children) : []
      return children.length ? [{ ...node, children }] : []
    })
  const grouped = groupDatabaseNodes({ nodes, grouping, actions: connectionActions, disabled })
  const visible = needle
    ? grouped.flatMap<ObjectNode | DatabaseGroupNode>(node => {
        if (node.name.toLocaleLowerCase().includes(needle)) return [node]
        const children = node.children ? filter(node.children) : []
        return children.length ? [{ ...node, children }] : []
      })
    : grouped
  const selectedProfile = selected ? connections.find(item => item.id === selected) : undefined
  const activeCatalog =
    selectedProfile?.engine === 'postgresql' ? (catalog ?? undefined) : undefined
  return (
    <div className="database-tree-scroll">
      <Tree<ObjectNode | DatabaseGroupNode>
        aria-label="数据库对象"
        className="database-tree"
        blockNode
        showIcon
        virtual={false}
        disabled={disabled}
        treeData={visible}
        expandedKeys={needle ? parentKeys(visible) : expanded}
        selectedKeys={
          selected
            ? [databaseNodeKey(selected, schema ?? undefined, table ?? undefined, activeCatalog)]
            : []
        }
        onExpand={(keys, info) => {
          onExpand(keys.map(String))
          if (info.expanded && info.node.needsLoad && 'profile' in info.node)
            onOpen(info.node.profile, info.node.schema, undefined, info.node.catalog)
        }}
        onSelect={(_, info) => {
          if ('profile' in info.node)
            onOpen(info.node.profile, info.node.schema, info.node.table, info.node.catalog)
        }}
      />
      {needle && !visible.length && (
        <p className="connections-empty-list">
          没有匹配的对象。搜索范围为分组和已加载的连接、数据库、表。
        </p>
      )}
    </div>
  )
}
