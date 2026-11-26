import { useModel } from '@umijs/max'
import { createContext, useContext, useSyncExternalStore } from 'react'
import type { WorkspaceSnapshot, WorkspaceStore } from '../models/workspace/store.ts'

export const SessionScope = createContext<string | null>(null)

/** 获取 Umi Model 持有的工作台操作入口；组件不自行创建状态实例。 */
export function useWorkspaceStore(): WorkspaceStore {
  return useModel('workspace', model => model.store)
}

/** 直接订阅同一份快照；Host 事件不经第二份 React 状态转存。 */
export function useWorkspaceSnapshot(): WorkspaceSnapshot {
  const store = useWorkspaceStore()
  const sessionId = useContext(SessionScope)
  const snapshot = () =>
    sessionId === null ? store.getSnapshot() : store.sessionSnapshot(sessionId)
  return useSyncExternalStore(store.subscribe, snapshot, snapshot)
}
