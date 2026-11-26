/** renderer 保存数据库导航分组，仅存名称和连接标识，不复制连接配置或凭据。 */
import { useEffect, useRef, useState } from 'react'

/** 数据库连接的单层导航分组。 */
export interface DatabaseGroup {
  readonly id: string
  readonly name: string
}

interface GroupState {
  groups: DatabaseGroup[]
  assignments: Record<string, string>
}
const storageKey = 'mydsh.database.groups.v1'
const emptyState = (): GroupState => ({ groups: [], assignments: {} })

function readGroups(): GroupState {
  try {
    const value = JSON.parse(window.localStorage.getItem(storageKey) ?? 'null') as GroupState | null
    if (!value || !Array.isArray(value.groups)) return emptyState()
    const groups = value.groups
      .filter(
        group =>
          group &&
          typeof group.id === 'string' &&
          group.id.length > 0 &&
          group.id.length <= 128 &&
          typeof group.name === 'string' &&
          group.name.trim().length > 0 &&
          group.name.length <= 60,
      )
      .slice(0, 100)
    const assignments = Object.fromEntries(
      Object.entries(value.assignments ?? {}).filter(
        ([id, group]) => id.length <= 128 && groups.some(item => item.id === group),
      ),
    )
    return { groups, assignments }
  } catch {
    return emptyState()
  }
}

/** 分组写入成功后才更新界面，写入失败由操作入口提示，跨窗口变更同步到导航。 */
export function useDatabaseGroups() {
  const [value, setValue] = useState(readGroups)
  const latest = useRef(value)
  const save = (next: GroupState) => {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(next))
    } catch {
      throw new Error('无法保存数据库分组，请检查本地存储后重试。')
    }
    latest.current = next
    setValue(next)
  }
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key !== storageKey && event.key !== null) return
      latest.current = readGroups()
      setValue(latest.current)
    }
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [])
  const saveGroup = (name: string, id: string | null = null) => {
    const current = latest.current
    const trimmed = name.trim()
    if (id && !current.groups.some(group => group.id === id))
      throw new Error('分组已不存在，请重新选择。')
    if (!trimmed || trimmed.length > 60) throw new Error('分组名称需为 1～60 个字符。')
    if (current.groups.some(group => group.id !== id && group.name === trimmed))
      throw new Error('已有同名分组，请换一个名称。')
    if (!id && current.groups.length >= 100) throw new Error('分组最多可创建 100 个。')
    const group = { id: id ?? crypto.randomUUID(), name: trimmed }
    const groups = id
      ? current.groups.map(item => (item.id === id ? group : item))
      : [...current.groups, group]
    save({ ...current, groups })
    return group.id
  }
  const moveConnection = (id: string, groupId: string | null) => {
    const current = latest.current
    if (groupId && !current.groups.some(group => group.id === groupId))
      throw new Error('分组已不存在，请重新选择。')
    const assignments = { ...current.assignments }
    if (groupId) assignments[id] = groupId
    else delete assignments[id]
    save({ ...current, assignments })
  }
  const removeGroup = (id: string) => {
    const current = latest.current
    save({
      groups: current.groups.filter(group => group.id !== id),
      assignments: Object.fromEntries(
        Object.entries(current.assignments).filter(([, group]) => group !== id),
      ),
    })
  }
  return { ...value, saveGroup, moveConnection, removeGroup }
}
