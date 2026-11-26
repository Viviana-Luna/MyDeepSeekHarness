import type { Plugin } from '@deepseek-ai/cordis'
import { sessionUi } from './builtin/session.tsx'
import { sourceControlUi } from './builtin/source-control.tsx'
import { filesUi } from './builtin/files.tsx'
import { terminalUi } from './builtin/terminal.tsx'
import { connectionsUi } from './builtin/connections.tsx'
import { browserUi } from './builtin/browser.tsx'
import { settingsUi } from './builtin/settings.tsx'
import { pluginManagerUi } from './builtin/plugin-manager.tsx'

/** 装配顺序只决定安装先后；模式与浮岛顺序由各插件自己的贡献声明。 */
export const builtinUiPlugins: readonly { id: string; plugin: Plugin }[] = [
  { id: 'mydsh.session-ui', plugin: sessionUi },
  { id: 'mydsh.source-control-ui', plugin: sourceControlUi },
  { id: 'mydsh.files-ui', plugin: filesUi },
  { id: 'mydsh.terminal-ui', plugin: terminalUi },
  { id: 'mydsh.connections-ui', plugin: connectionsUi },
  { id: 'mydsh.browser-ui', plugin: browserUi },
  { id: 'mydsh.settings-ui', plugin: settingsUi },
  { id: 'mydsh.plugin-manager-ui', plugin: pluginManagerUi },
]
