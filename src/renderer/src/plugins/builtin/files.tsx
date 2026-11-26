import type { Context, Plugin } from '@deepseek-ai/cordis'
import { Files, SquarePlay } from 'lucide-react'
import { FileViewer } from '../../features/files/FileViewer.tsx'
import { FileLeftPanel } from '../../pages/workspace/components/leftpanel/file-leftpanel/index.tsx'
import { FileRightPanel } from '../../pages/workspace/components/rightpanel/file-rightpanel/index.tsx'

export const filesUi: Plugin = {
  name: 'mydsh.files-ui',
  inject: ['mydshSlots'],
  apply(ctx: Context) {
    ctx.mydshSlots.registerIsland({
      id: 'files',
      label: '文件视图',
      icon: Files,
      component: FileViewer,
      placements: ['main'],
      scope: 'project',
      preserveWhenHidden: true,
      order: 3,
    })
    ctx.mydshSlots.registerIsland({
      id: 'file-outline-tasks',
      label: '脚本',
      icon: SquarePlay,
      component: FileRightPanel,
      placements: ['right'],
      scope: 'project',
      ariaLabel: '项目脚本',
      className: 'file-info-island',
      order: 7,
    })
    ctx.mydshSlots.registerMode({
      id: 'files',
      label: '文件',
      icon: Files,
      mainIslandId: 'files',
      left: FileLeftPanel,
      defaultRightIslandId: 'file-outline-tasks',
      order: 3,
    })
  },
}
