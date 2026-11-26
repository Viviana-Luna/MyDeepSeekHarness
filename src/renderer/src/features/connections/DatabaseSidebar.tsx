/** renderer 数据库侧栏，顶部集成搜索与紧凑操作按钮，拥有分组编辑弹窗。 */
import { Alert, Button, Input, Modal } from 'antd'
import { FolderPlus, Plus, RefreshCw, Search } from 'lucide-react'
import { useState, type ComponentProps } from 'react'
import { AppAlert } from '../../shared/ui/AppAlert.tsx'
import { DatabaseNavigator } from './DatabaseNavigator.tsx'
import { databaseGroupKey } from './DatabaseTreeGroups.tsx'
import type { DatabaseGroup, useDatabaseGroups } from './useDatabaseGroups.ts'

type SidebarProps = Omit<ComponentProps<typeof DatabaseNavigator>, 'grouping'> & {
  groups: ReturnType<typeof useDatabaseGroups>
  busy: boolean
  loaded: boolean
  supported: boolean
  onSearch(value: string): void
  onAdd(): void
  onRefresh(): void
}

/** 分组操作只改变导航归属，连接的编辑与读取仍由工作区处理。 */
export function DatabaseSidebar({
  groups,
  busy,
  loaded,
  supported,
  onAdd,
  onRefresh,
  onSearch,
  ...navigation
}: SidebarProps) {
  const [editing, setEditing] = useState<DatabaseGroup | 'new' | null>(null)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [dialogError, setDialogError] = useState<string | null>(null)
  const [modal, modalContext] = Modal.useModal()
  const editGroup = (group: DatabaseGroup | 'new') => {
    setName(group === 'new' ? '' : group.name)
    setDialogError(null)
    setEditing(group)
  }
  const saveGroup = () => {
    try {
      const id = groups.saveGroup(name, editing === 'new' ? null : editing?.id)
      navigation.onExpand([...new Set([...navigation.expanded, databaseGroupKey(id)])])
      setEditing(null)
    } catch (cause) {
      setDialogError((cause as Error).message)
    }
  }
  const moveConnection = (id: string, groupId: string | null) => {
    try {
      groups.moveConnection(id, groupId)
      if (groupId)
        navigation.onExpand([...new Set([...navigation.expanded, databaseGroupKey(groupId)])])
    } catch (cause) {
      setError((cause as Error).message)
    }
  }
  const removeGroup = (group: DatabaseGroup) => {
    const confirmation = modal.confirm({
      title: `删除分组“${group.name}”？`,
      content: '组内连接将移回未分组列表，连接配置和数据库中的数据会保留。',
      okText: '删除分组',
      cancelText: '取消',
      onOk: () => {
        try {
          groups.removeGroup(group.id)
        } catch (cause) {
          confirmation.update({ content: <Alert type="error" title={(cause as Error).message} /> })
          return Promise.reject(cause)
        }
      },
    })
  }
  return (
    <div className="connections-list database-navigation-list">
      {modalContext}
      <header className="database-navigation-toolbar" role="toolbar" aria-label="数据库操作">
        <div className="database-tree-search" role="search">
          <Input
            aria-label="搜索数据库对象"
            placeholder="搜索对象…"
            prefix={<Search size={14} />}
            allowClear
            value={navigation.search}
            onChange={event => onSearch(event.target.value)}
          />
        </div>
        <div className="database-navigation-toolbar__actions">
          <Button
            type="text"
            aria-label="新增数据库连接"
            title="新增连接"
            icon={<Plus size={15} />}
            disabled={busy || !supported}
            onClick={onAdd}
          />
          <Button
            type="text"
            aria-label="新增数据库分组"
            title="新增分组"
            icon={<FolderPlus size={15} />}
            disabled={busy || !supported}
            onClick={() => editGroup('new')}
          />
          <Button
            type="text"
            aria-label="刷新数据库连接"
            title="刷新连接"
            icon={<RefreshCw size={14} />}
            disabled={busy}
            onClick={onRefresh}
          />
        </div>
      </header>
      {error && (
        <AppAlert
          tone="error"
          title="分组操作未完成"
          floating
          dismissAfterMs={6_000}
          onClose={() => setError(null)}
        >
          {error}
        </AppAlert>
      )}
      <DatabaseNavigator
        {...navigation}
        grouping={{
          groups: groups.groups,
          assignments: groups.assignments,
          onMove: moveConnection,
          onRename: editGroup,
          onRemove: removeGroup,
        }}
      />
      {loaded && !navigation.connections.length && (
        <p className="connections-empty-list">点击右上角「+」添加数据库连接。</p>
      )}
      <Modal
        title={editing === 'new' ? '新增分组' : '重命名分组'}
        open={editing !== null}
        okText="保存分组"
        cancelText="取消"
        onOk={saveGroup}
        onCancel={() => setEditing(null)}
        destroyOnHidden
      >
        {dialogError && <Alert type="error" title={dialogError} showIcon />}
        <label className="database-group-name">
          分组名称
          <Input
            aria-label="数据库分组名称"
            autoFocus
            maxLength={60}
            value={name}
            onChange={event => setName(event.target.value)}
            onPressEnter={saveGroup}
          />
        </label>
      </Modal>
    </div>
  )
}
