import type { Context, Plugin } from '@deepseek-ai/cordis'
import { GitCompareArrows } from 'lucide-react'
import {
  GitModeIcon,
  GitModeTooltip,
  GitSummaryCard,
  SourceControlAlert,
} from '../../features/source-control/GitContributions.tsx'
import { SourceControlView } from '../../features/source-control/SourceControlView.tsx'
import { ChangesLeftPanel } from '../../features/source-control/ChangesLeftPanel.tsx'
import { ChangesRightPanel } from '../../features/source-control/ChangesRightPanel.tsx'

export const sourceControlUi: Plugin = {
  name: 'mydsh.source-control-ui',
  inject: ['mydshSlots'],
  apply(ctx: Context) {
    ctx.mydshSlots.registerIsland({
      id: 'changes',
      label: '变更工作台',
      icon: GitCompareArrows,
      component: SourceControlView,
      placements: ['main'],
      scope: 'project',
      order: 2,
    })
    ctx.mydshSlots.registerIsland({
      id: 'git-history',
      label: 'Git',
      icon: GitCompareArrows,
      component: ChangesRightPanel,
      placements: ['right'],
      scope: 'project',
      ariaLabel: 'Git 审阅',
      order: 6,
    })
    ctx.mydshSlots.registerMode({
      id: 'changes',
      label: '变更',
      icon: GitModeIcon,
      tooltip: GitModeTooltip,
      mainIslandId: 'changes',
      left: ChangesLeftPanel,
      defaultRightIslandId: 'git-history',
      order: 2,
    })
    ctx.mydshSlots.registerAction('session.info', 'git-summary', GitSummaryCard)
    ctx.mydshSlots.registerAction('workspace.alerts', 'git-error', SourceControlAlert)
  },
}
