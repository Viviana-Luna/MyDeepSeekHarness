/** renderer 为数据库对象树添加分组与连接操作菜单，不读取远端数据库。 */
import { Button, Dropdown, type MenuProps, type TreeDataNode } from 'antd'
import { Folder, MoreHorizontal, Unplug } from 'lucide-react'
import type { DatabaseProfile } from '../../../../../packages/connections/database/types.d.ts'
import type { ObjectNode } from './DatabaseNavigator.tsx'
import type { DatabaseGroup } from './useDatabaseGroups.ts'

/** 分组节点不对应连接，点击时只负责展开与折叠。 */
export interface DatabaseGroupNode extends Omit<TreeDataNode, 'children'> {
  name: string
  groupId: string
  needsLoad: false
  children: ObjectNode[]
}

/** 分组键与连接对象的键保持不同命名范围。 */
export const databaseGroupKey = (id: string) => `database-group:${id}`

/** 数据库导航中的分组操作。 */
export interface DatabaseGrouping {
  groups: readonly DatabaseGroup[]
  assignments: Readonly<Record<string, string>>
  onMove(id: string, groupId: string | null): void
  onRename(group: DatabaseGroup): void
  onRemove(group: DatabaseGroup): void
}

/** 数据库侧栏连接项三点菜单对应的工作区操作。 */
export interface DatabaseConnectionMenuActions {
  busy: boolean
  isConnected?(profileId: string): boolean
  onDisconnect?(profile: DatabaseProfile): void
  onEdit(profile: DatabaseProfile): void
  onEditAccess(profile: DatabaseProfile): void
  onTest(profile: DatabaseProfile): void
  onRemove(profile: DatabaseProfile): void
}

function buildConnectionMenuItems({
  profile,
  grouping,
  actions,
  connected,
}: {
  profile: DatabaseProfile
  grouping: DatabaseGrouping
  actions: DatabaseConnectionMenuActions
  connected: boolean
}): NonNullable<MenuProps['items']> {
  const groupItems: NonNullable<MenuProps['items']> =
    grouping.groups.length > 0
      ? [
          { type: 'divider' },
          {
            type: 'group',
            key: 'move-group',
            label: '移动到分组',
            children: [
              {
                key: 'none',
                label: '未分组',
                onClick: () => grouping.onMove(profile.id, null),
              },
              ...grouping.groups.map(group => ({
                key: group.id,
                label: group.name,
                onClick: () => grouping.onMove(profile.id, group.id),
              })),
            ],
          },
        ]
      : []
  return [
    ...(connected && actions.onDisconnect
      ? [
          {
            key: 'disconnect',
            label: '断开连接',
            disabled: actions.busy,
            onClick: () => actions.onDisconnect?.(profile),
          },
          { type: 'divider' as const },
        ]
      : []),
    {
      key: 'edit',
      label: '编辑连接',
      disabled: actions.busy,
      onClick: () => actions.onEdit(profile),
    },
    {
      key: 'agentAccess',
      label: 'Agent 权限配置',
      disabled: actions.busy,
      onClick: () => actions.onEditAccess(profile),
    },
    {
      key: 'test',
      label: '测试连接',
      disabled: actions.busy || profile.disabled,
      onClick: () => actions.onTest(profile),
    },
    ...groupItems,
    { type: 'divider' },
    {
      key: 'remove',
      label: '删除连接',
      danger: true,
      disabled: actions.busy,
      onClick: () => actions.onRemove(profile),
    },
  ]
}

function TreeMenu({
  label,
  items,
  disabled,
}: {
  label: string
  items: NonNullable<MenuProps['items']>
  disabled: boolean
}) {
  return (
    <Dropdown
      disabled={disabled}
      trigger={['click']}
      popupRender={menu => <div onClick={event => event.stopPropagation()}>{menu}</div>}
      menu={{
        className: 'database-tree-menu-list',
        items,
        onClick: event => event.domEvent.stopPropagation(),
      }}
    >
      <Button
        type="text"
        size="small"
        className="database-tree-menu"
        aria-label={label}
        aria-haspopup="menu"
        title={label}
        icon={<MoreHorizontal size={14} />}
        disabled={disabled}
        onClick={event => event.stopPropagation()}
        onKeyDown={event => event.stopPropagation()}
      />
    </Dropdown>
  )
}

/** 将未分组连接留在根部，分组只包裹连接，不改变对象键、搜索和读取行为。 */
export function groupDatabaseNodes({
  nodes,
  grouping,
  actions,
  disabled,
}: {
  nodes: ObjectNode[]
  grouping: DatabaseGrouping
  actions: DatabaseConnectionMenuActions
  disabled: boolean
}): (ObjectNode | DatabaseGroupNode)[] {
  const connections = nodes.map(node => {
    const connected = actions.isConnected?.(node.profile.id) ?? false
    return {
      ...node,
      title: (
        <span className="database-tree-entry">
          {node.title}
          {connected && actions.onDisconnect && (
            <Button
              type="text"
              size="small"
              className="database-tree-quick-action"
              aria-label={`断开连接 ${node.name}`}
              title="断开连接"
              icon={<Unplug size={12} />}
              disabled={disabled || actions.busy}
              onClick={event => {
                event.stopPropagation()
                actions.onDisconnect?.(node.profile)
              }}
              onKeyDown={event => event.stopPropagation()}
            />
          )}
          <TreeMenu
            label={`连接 ${node.name} 操作`}
            disabled={disabled}
            items={buildConnectionMenuItems({
              profile: node.profile,
              grouping,
              actions,
              connected,
            })}
          />
        </span>
      ),
    }
  })
  const groups: DatabaseGroupNode[] = grouping.groups.map(group => ({
    key: databaseGroupKey(group.id),
    name: group.name,
    groupId: group.id,
    needsLoad: false,
    selectable: false,
    isLeaf: false,
    icon: <Folder size={15} />,
    title: (
      <span className="database-tree-entry">
        <span className="database-tree-title" data-database-group={group.id} title={group.name}>
          <span>{group.name}</span>
          <small>
            {connections.filter(node => grouping.assignments[node.profile.id] === group.id).length}
          </small>
        </span>
        <TreeMenu
          label={`分组 ${group.name} 操作`}
          disabled={disabled}
          items={[
            { key: 'rename', label: '重命名分组', onClick: () => grouping.onRename(group) },
            { key: 'remove', label: '删除分组', onClick: () => grouping.onRemove(group) },
          ]}
        />
      </span>
    ),
    children: connections.filter(node => grouping.assignments[node.profile.id] === group.id),
  }))
  return [
    ...groups,
    ...connections.filter(
      node => !grouping.groups.some(group => group.id === grouping.assignments[node.profile.id]),
    ),
  ]
}
