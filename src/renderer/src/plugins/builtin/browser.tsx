import type { Context, Plugin } from '@deepseek-ai/cordis'
import { Globe } from 'lucide-react'
import { BrowserPanel } from '../../features/browser/BrowserPanel.tsx'
export const browserUi: Plugin = {
  name: 'mydsh.browser-ui',
  inject: ['mydshSlots'],
  apply(ctx: Context) {
    ctx.mydshSlots.registerIsland({
      id: 'browser',
      label: '浏览器',
      icon: Globe,
      component: BrowserPanel,
      placements: ['main'],
      scope: 'window',
      order: 3,
    })
    ctx.mydshSlots.registerMode({
      id: 'browser',
      label: '浏览器',
      icon: Globe,
      mainIslandId: 'browser',
      defaultRightIslandId: 'git-history',
      order: 8,
    })
  },
}
