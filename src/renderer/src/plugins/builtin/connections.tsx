import type { Context, Plugin } from '@deepseek-ai/cordis'
import { Database, Server } from 'lucide-react'
import { ConnectionsWorkspace } from '../../features/connections/ConnectionsWorkspace.tsx'
import { ConnectionsSidebar } from '../../features/connections/ConnectionsProvider.tsx'

export const connectionsUi: Plugin = {
  name: 'mydsh.connections-ui',
  inject: ['mydshSlots'],
  apply(ctx: Context) {
    ctx.mydshSlots.registerIsland({
      id: 'connections',
      label: '连接',
      icon: Server,
      component: ConnectionsWorkspace,
      placements: ['main'],
      scope: 'window',
      preserveWhenHidden: true,
      ariaLabel: '连接工作区',
    })
    ctx.mydshSlots.registerMode({
      id: 'connections',
      label: 'SSH',
      icon: Server,
      mainIslandId: 'connections',
      left: ConnectionsSidebar,
      collapsePanelsOnEnter: 'right',
      showComposer: false,
      order: 4.5,
    })
    ctx.mydshSlots.registerMode({
      id: 'database',
      label: '数据库',
      icon: Database,
      mainIslandId: 'connections',
      left: ConnectionsSidebar,
      collapsePanelsOnEnter: 'right',
      showComposer: false,
      order: 4.6,
    })
  },
}
