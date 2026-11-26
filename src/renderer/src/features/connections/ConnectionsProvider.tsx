import { createContext, useContext, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useWorkspaceSnapshot } from '../../plugins/sdk.ts'

type ConnectionGroup = 'servers' | 'databases'
const ConnectionsContext = createContext<{
  group: ConnectionGroup
  sidebarGroup: ConnectionGroup
  host: HTMLDivElement | null
  setHost(host: HTMLDivElement | null): void
} | null>(null)

/** 仅协调左右浮岛的位置与导航；连接、终端和草稿仍归常驻主视图所有。 */
export function ConnectionsProvider({ children }: { children: ReactNode }) {
  const { activeView, navigationView } = useWorkspaceSnapshot()
  const group: ConnectionGroup = activeView === 'database' ? 'databases' : 'servers'
  const sidebarGroup: ConnectionGroup =
    (navigationView ?? activeView) === 'database' ? 'databases' : 'servers'
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  return (
    <ConnectionsContext.Provider value={{ group, sidebarGroup, host, setHost }}>
      {children}
    </ConnectionsContext.Provider>
  )
}
export function useConnectionsNavigation() {
  const value = useContext(ConnectionsContext)
  if (!value) throw new Error('连接工作区需要 ConnectionsProvider')
  return value
}
export function ConnectionsSidebar() {
  const { sidebarGroup, setHost } = useConnectionsNavigation()
  return (
    <section
      className="connections-navigation"
      aria-label={sidebarGroup === 'databases' ? '数据库导航' : 'SSH 导航'}
    >
      <div className="connections-navigation-list" ref={setHost} />
    </section>
  )
}
export function ConnectionsSidebarContent({
  group,
  children,
}: {
  group: ConnectionGroup
  children: ReactNode
}) {
  const navigation = useConnectionsNavigation()
  return navigation.host && navigation.sidebarGroup === group
    ? createPortal(children, navigation.host)
    : null
}
