import type { Context, Plugin } from '@deepseek-ai/cordis'
import { SquareTerminal } from 'lucide-react'
import { TerminalWorkspace } from '../../features/terminal/TerminalWorkspace.tsx'

export const terminalUi: Plugin = {
  name: 'mydsh.terminal-ui',
  inject: ['mydshSlots'],
  apply(ctx: Context) {
    ctx.mydshSlots.registerIsland({
      id: 'terminal',
      label: '终端',
      icon: SquareTerminal,
      component: TerminalWorkspace,
      placements: ['main', 'right'],
      scope: 'window',
      preserveWhenHidden: true,
      order: 4,
    })
    ctx.mydshSlots.registerMode({
      id: 'terminal',
      label: '终端',
      icon: SquareTerminal,
      mainIslandId: 'terminal',
      defaultRightIslandId: 'file-outline-tasks',
      order: 4,
    })
  },
}
