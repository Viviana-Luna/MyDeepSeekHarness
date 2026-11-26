import { useEffect, useMemo } from 'react'
import { getDesktopBridge } from '../services/desktop.ts'
import { WorkspaceStore } from './workspace/store.ts'

/**
 * Umi 自动注册的工作台 Model。应用期间只创建一个状态实例，卸载时释放 Host 订阅。
 * 会话事件、草稿和异步代次仍由 Store 统一协调，避免模式切换时丢失或重复创建。
 */
export default function useWorkspaceModel() {
  const store = useMemo(() => new WorkspaceStore(getDesktopBridge(), window.localStorage), [])
  useEffect(() => {
    void store.initialize()
    return () => {
      store.dispose()
    }
  }, [store])
  return { store }
}
