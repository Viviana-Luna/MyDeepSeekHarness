import { Context, Service, type Fiber, type Plugin } from '@deepseek-ai/cordis'
import type { ComponentType } from 'react'
import type { ConversationToolItem } from '../../../shared/session-projection.ts'
import type { useSettingsCenter } from '../features/settings/useSettingsCenter.ts'
import { SlotCore, type SlotOptions } from './slot-core.ts'

export type PluginIcon = ComponentType<{
  size?: number
  strokeWidth?: number
  'aria-hidden'?: boolean | 'true' | 'false'
}>
export type IslandPlacement = 'main' | 'right'
export type IslandScope = 'session' | 'project' | 'window'
export type IslandVisibility = 'foreground' | 'hidden'
export interface IslandPresentationProps {
  placement: IslandPlacement
  visibility: IslandVisibility
  /** 仅用户从右侧选择器明确选择该浮岛时递增；布局恢复与协同呈现不触发。 */
  selectionRevision?: number
}
export interface IslandContribution {
  id: string
  label: string
  icon: PluginIcon
  order?: number
  component: ComponentType<IslandPresentationProps>
  placements: readonly IslandPlacement[]
  scope: IslandScope
  ariaLabel?: string
  className?: string
  /** 临时文档由会话内容打开，不占用栏目入口，也不作为默认浮岛。 */
  contextual?: boolean
  /** 只有无法安全重建交互现场的主区组件才声明；插件卸载仍会销毁组件。 */
  preserveWhenHidden?: boolean
}
export interface ModeContribution {
  id: string
  label: string
  icon: PluginIcon
  tooltip?: ComponentType
  order?: number
  mainIslandId: string
  left?: ComponentType
  /** 只在当前会话尚未建立右侧现场时使用，不能覆盖用户选择。 */
  defaultRightIslandId?: string
  /** 切换会话时进入的模式；有多个声明时按模式顺序取第一个。 */
  sessionHome?: boolean
  /** true 临时收起两侧，right 只收起右侧；离开时恢复未被用户修改的状态。 */
  collapsePanelsOnEnter?: boolean | 'right'
  /** 当前模式是否呈现会话输入区及其尺寸控制。 */
  showComposer?: boolean
}
export type SettingsPageProps = ReturnType<typeof useSettingsCenter>
export interface SettingsContribution {
  id: string
  label: string
  icon: PluginIcon
  order?: number
  component: ComponentType<SettingsPageProps>
}
export type ActionSlot =
  | 'composer.actions'
  | 'composer.readings'
  | 'workspace.toolbar'
  | 'workspace.alerts'
  | 'session.info'
  | 'shell.notifications'
export interface ToolResultProps {
  item: ConversationToolItem
}
export interface OverlayContribution {
  id: string
  label: string
  order?: number
  component: ComponentType<{ close(): void }>
  close(): void
}

function validContributionId(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= 200 && value.trim() === value
  )
}

function validContributionLabel(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 200
}

function validComponent(value: unknown): boolean {
  return (
    typeof value === 'function' ||
    (typeof value === 'object' && value !== null && '$$typeof' in value)
  )
}

function validOrder(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value))
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    mydshSlots: MydshSlots
  }
}

/**
 * 原型方法必须保留：Cordis 的 Service 代理将 this.ctx 绑定到调用者，
 * 注册产生的副作用因此属于插件，而不是长驻的外壳服务。
 */
export class MydshSlots extends Service {
  readonly core = new SlotCore()
  private readonly blockers = new Map<symbol, string>()
  private readonly blockerListeners = new Set<() => void>()
  private reasons: readonly string[] = []
  get busyReasons(): readonly string[] {
    return this.reasons
  }
  subscribeBusy(listener: () => void): () => void {
    this.blockerListeners.add(listener)
    return () => {
      this.blockerListeners.delete(listener)
    }
  }
  private publishBusy(): void {
    this.reasons = [...new Set(this.blockers.values())]
    const listeners = [...this.blockerListeners]
    for (const listener of listeners) listener()
  }
  /** 未保存缓冲等阻止启停的原因属于注册插件；解除占用或卸载时撤销。 */
  blockSwitch(reason: string): () => void {
    const message = reason.trim()
    if (!message || message.length > 500) throw new Error('插件占用原因必须是 1 到 500 字的说明')
    if (this.blockers.size >= 32) throw new Error('插件占用声明超过上限')
    const token = Symbol()
    return this.ctx.effect(() => {
      this.blockers.set(token, message)
      this.publishBusy()
      return () => {
        this.blockers.delete(token)
        this.publishBusy()
      }
    })
  }
  constructor(ctx: Context) {
    super(ctx, 'mydshSlots')
    ctx.effect(() =>
      this.core.register(
        {
          name: 'root',
          registrant: 'mydsh.shell',
          children: {
            modes: { kind: 'keyed', scope: 'application' },
            islands: { kind: 'keyed', scope: 'application' },
            settings: { kind: 'keyed', scope: 'application' },
            'tool.results': { kind: 'keyed', scope: 'session' },
            'composer.actions': { kind: 'list', scope: 'session' },
            'composer.readings': { kind: 'list', scope: 'session' },
            'workspace.toolbar': { kind: 'list', scope: 'project' },
            'workspace.alerts': { kind: 'list', scope: 'project' },
            'session.info': { kind: 'list', scope: 'project' },
            'shell.overlays': { kind: 'list', scope: 'application' },
            'shell.notifications': { kind: 'list', scope: 'application' },
          },
        },
        null,
      ),
    )
  }

  registerMode(mode: ModeContribution): () => void {
    if (
      !validContributionId(mode.id) ||
      !validContributionLabel(mode.label) ||
      !validComponent(mode.icon) ||
      !validOrder(mode.order)
    )
      throw new Error('模式贡献的标识、名称、图标或顺序无效')
    if (mode.tooltip !== undefined && !validComponent(mode.tooltip))
      throw new Error(`模式「${mode.id}」的提示组件无效`)
    if (!validContributionId(mode.mainIslandId))
      throw new Error(
        `模式「${mode.id}」使用了旧版界面契约，请改为声明 mainIslandId 并单独注册浮岛`,
      )
    if (
      mode.defaultRightIslandId !== undefined &&
      !validContributionId(mode.defaultRightIslandId)
    ) {
      throw new Error(`模式「${mode.id}」的默认右侧浮岛标识无效`)
    }
    if (mode.left !== undefined && !validComponent(mode.left))
      throw new Error(`模式「${mode.id}」的左侧视图无效`)
    if (
      (mode.sessionHome !== undefined && typeof mode.sessionHome !== 'boolean') ||
      (mode.collapsePanelsOnEnter !== undefined &&
        typeof mode.collapsePanelsOnEnter !== 'boolean' &&
        mode.collapsePanelsOnEnter !== 'right') ||
      (mode.showComposer !== undefined && typeof mode.showComposer !== 'boolean')
    ) {
      throw new Error(`模式「${mode.id}」的展示行为声明无效`)
    }
    return this.register({ name: 'modes', key: mode.id, order: mode.order ?? 100 }, mode)
  }
  registerIsland(island: IslandContribution): () => void {
    if (
      !validContributionId(island.id) ||
      !validContributionLabel(island.label) ||
      !validComponent(island.icon) ||
      !validComponent(island.component) ||
      !validOrder(island.order)
    ) {
      throw new Error('浮岛贡献的标识、名称、图标、组件或顺序无效')
    }
    if (
      !Array.isArray(island.placements) ||
      island.placements.length === 0 ||
      new Set(island.placements).size !== island.placements.length ||
      island.placements.some(placement => placement !== 'main' && placement !== 'right')
    ) {
      throw new Error(`浮岛「${island.id}」必须声明 main 或 right 位置`)
    }
    if (island.scope !== 'session' && island.scope !== 'project' && island.scope !== 'window') {
      throw new Error(`浮岛「${island.id}」的作用域必须是 session、project 或 window`)
    }
    if (island.preserveWhenHidden !== undefined && typeof island.preserveWhenHidden !== 'boolean') {
      throw new Error(`浮岛「${island.id}」的隐藏保留标记无效`)
    }
    if (island.contextual !== undefined && typeof island.contextual !== 'boolean') {
      throw new Error(`浮岛「${island.id}」的临时文档标记无效`)
    }
    return this.register({ name: 'islands', key: island.id, order: island.order ?? 100 }, island)
  }
  registerSettings(page: SettingsContribution): () => void {
    if (
      !validContributionId(page.id) ||
      !validContributionLabel(page.label) ||
      !validComponent(page.icon) ||
      !validComponent(page.component) ||
      !validOrder(page.order)
    ) {
      throw new Error('设置贡献的标识、名称、图标、组件或顺序无效')
    }
    return this.register({ name: 'settings', key: page.id, order: page.order ?? 100 }, page)
  }
  /** 按工具名称选择结果视图；未命中或视图失败时沿用内置文本。 */
  registerToolResult(
    toolName: string,
    component: ComponentType<ToolResultProps>,
    priority = 0,
  ): () => void {
    return this.register({ name: 'tool.results', key: toolName, priority }, component)
  }
  /** 浮层由外壳 Modal 管理焦点、Escape 和关闭；插件只提供内容。 */
  registerOverlay(overlay: Omit<OverlayContribution, 'close'>, onClose?: () => void): () => void {
    let closed = false
    const close = () => {
      if (closed) return
      closed = true
      release()
      onClose?.()
    }
    const release = this.register(
      { name: 'shell.overlays', id: overlay.id, order: overlay.order ?? 100 },
      { ...overlay, close },
    )
    return release
  }
  /** 插件样式属于调用方生命周期，停用和更新时移除。 */
  addStyle(css: string): () => void {
    return this.ctx.effect(() => {
      const element = document.createElement('style')
      element.dataset.mydshPlugin = this.ctx.fiber.name
      element.textContent = css
      document.head.append(element)
      return () => {
        element.remove()
      }
    })
  }
  registerAction(slot: ActionSlot, id: string, component: ComponentType, order = 100): () => void {
    return this.register({ name: slot, id, order }, component)
  }
  /** 插件可声明自己的子插槽；父注册撤销时所有子贡献同时失效。 */
  register<T>(options: SlotOptions, component: T): () => void {
    return this.ctx.effect(() =>
      this.core.register({ ...options, registrant: this.ctx.fiber.name }, component),
    )
  }
  /** 等待动态父声明，每次重建都使用新的生命周期，旧 disposer 可重复调用。 */
  inject(name: string, callback: () => () => void): () => void {
    return this.ctx.effect(() => {
      let cleanup: (() => void) | undefined
      let epoch = -1
      const update = () => {
        const current = this.core.declarationEpoch(name)
        if (current === epoch) return
        epoch = current
        cleanup?.()
        cleanup = undefined
        if (this.core.spec(name)) cleanup = callback()
      }
      const unsubscribe = this.core.subscribeDeclaration(name, update)
      update()
      return () => {
        unsubscribe()
        cleanup?.()
      }
    })
  }
}

/** 一个页面只拥有一个前端 Cordis 根；插件卸载必须等待异步清理结束。 */
export class UiRuntime {
  readonly context = new Context()
  readonly slots: MydshSlots
  private readonly plugins = new Map<string, Fiber>()
  constructor() {
    this.slots = new MydshSlots(this.context)
  }
  async install(id: string, plugin: Plugin): Promise<void> {
    if (this.plugins.has(id)) await this.uninstall(id)
    const fiber = this.context.plugin(plugin)
    this.plugins.set(id, fiber)
    try {
      await fiber
    } catch (error) {
      await fiber.dispose()
      this.plugins.delete(id)
      throw error
    }
  }
  async uninstall(id: string): Promise<void> {
    const fiber = this.plugins.get(id)
    if (fiber === undefined) return
    await fiber.dispose()
    this.plugins.delete(id)
  }
  async dispose(): Promise<void> {
    await this.context.fiber.dispose()
    this.plugins.clear()
  }
}
