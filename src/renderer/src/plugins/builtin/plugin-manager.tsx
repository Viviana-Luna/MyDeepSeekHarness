import type { Context, Plugin } from '@deepseek-ai/cordis'
import { Puzzle } from 'lucide-react'
import { PluginManager } from '../../features/plugins/PluginManager.tsx'
import { useSettingsCenter } from '../../features/settings/useSettingsCenter.ts'
import { ChatLeftPanel } from '../../pages/workspace/components/leftpanel/chat-leftpanel/index.tsx'

function PluginWorkspace() {
  const settings = useSettingsCenter(true)
  return <PluginManager {...settings} standalone />
}

export const pluginManagerUi: Plugin = {
  name: 'mydsh.plugin-manager-ui',
  inject: ['mydshSlots'],
  apply(ctx: Context) {
    ctx.mydshSlots.registerIsland({
      id: 'plugins',
      label: '插件',
      icon: Puzzle,
      component: PluginWorkspace,
      placements: ['main'],
      scope: 'window',
      ariaLabel: '插件管理',
    })
    ctx.mydshSlots.registerMode({
      id: 'plugins',
      label: '插件',
      icon: Puzzle,
      mainIslandId: 'plugins',
      left: ChatLeftPanel,
      collapsePanelsOnEnter: true,
      order: 5,
    })
  },
}
