/**
 * 设置中心内置插件：向前端插槽注册通用设置、外观、模型、Agent 预设、已归档会话与自动化页面。
 * 运行在 renderer；注册项随所属 Cordis 插件生命周期自动卸载。
 */
import type { Context, Plugin } from '@deepseek-ai/cordis'
import { Archive, Bot, Database, MonitorSmartphone, Palette, Settings2 } from 'lucide-react'
import { ArchivedSessionsSettings } from '../../features/settings/ArchivedSessionsSettings.tsx'
import { AgentPresetsSettings } from '../../features/settings/AgentPresetsSettings.tsx'
import { AppearanceSettings } from '../../features/settings/AppearanceSettings.tsx'
import { AutomationSettings } from '../../features/settings/AutomationSettings.tsx'
import { GeneralSettings } from '../../features/settings/GeneralSettings.tsx'
import { ModelsSettings } from '../../features/settings/ModelsSettings.tsx'
import type { SettingsPageProps } from '../registry.ts'

/** 注册设置中心默认分类页的内置前端插件。 */
export const settingsUi: Plugin = {
  name: 'mydsh.settings-ui',
  inject: ['mydshSlots'],
  apply(ctx: Context) {
    ctx.mydshSlots.registerSettings({
      id: 'general',
      label: '通用设置',
      icon: Settings2,
      order: 0,
      component: ({ state, mutate }: SettingsPageProps) => (
        <GeneralSettings
          document={state.document}
          presetRoster={state.presetRoster}
          saving={state.saving}
          mutate={mutate}
        />
      ),
    })
    ctx.mydshSlots.registerSettings({
      id: 'appearance',
      label: '外观',
      icon: Palette,
      component: AppearanceSettings,
      order: 1,
    })
    ctx.mydshSlots.registerSettings({
      id: 'models',
      label: '模型',
      icon: Database,
      order: 2,
      component: ({ state, mutate, setCredential, unsetCredential, load }: SettingsPageProps) => (
        <ModelsSettings
          document={state.document}
          modelCatalog={state.modelCatalog}
          providers={state.modelProviders}
          credentials={state.credentials}
          saving={state.saving}
          mutate={mutate}
          setCredential={setCredential}
          unsetCredential={unsetCredential}
          reload={load}
        />
      ),
    })
    ctx.mydshSlots.registerSettings({
      id: 'presets',
      label: 'Agent 预设',
      icon: Bot,
      order: 4,
      component: ({ state, mutate, load }: SettingsPageProps) => (
        <AgentPresetsSettings
          document={state.document}
          roster={state.presetRoster}
          saving={state.saving}
          mutate={mutate}
          reload={load}
        />
      ),
    })
    ctx.mydshSlots.registerSettings({
      id: 'archived-sessions',
      label: '已归档会话',
      icon: Archive,
      component: ArchivedSessionsSettings,
      order: 5,
    })
    ctx.mydshSlots.registerSettings({
      id: 'automation',
      label: '浏览器与桌面操控',
      icon: MonitorSmartphone,
      component: AutomationSettings,
      order: 6,
    })
  },
}
