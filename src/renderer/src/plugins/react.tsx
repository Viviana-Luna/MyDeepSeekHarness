import { Modal } from 'antd'
import type { ConversationToolItem } from '../../../shared/session-projection.ts'
import {
  Component,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ErrorInfo,
  type ReactNode,
} from 'react'
import {
  UiRuntime,
  type ActionSlot,
  type IslandContribution,
  type ModeContribution,
  type SettingsContribution,
  type OverlayContribution,
  type PluginIcon,
  type ToolResultProps,
} from './registry.ts'
import { builtinUiPlugins } from './builtin.tsx'

// 应用只创建一份根上下文；共享依赖及模块工厂也引用此实例。
export const uiRuntime = new UiRuntime()
for (const entry of builtinUiPlugins) {
  void uiRuntime.install(entry.id, entry.plugin).catch(error => {
    console.error(`内置界面插件「${entry.id}」加载失败`, error)
  })
}
export const UiRuntimeContext = createContext(uiRuntime)
export function useUiRuntime(): UiRuntime {
  return useContext(UiRuntimeContext)
}

export function useSlotEntries<T>(name: string) {
  const { slots } = useUiRuntime()
  useSyncExternalStore(
    useCallback(listener => slots.core.subscribe(name, listener), [slots, name]),
    useCallback(() => slots.core.entries(name), [slots, name]),
  )
  return slots.core
    .winners<T>(name)
    .toSorted((a, b) => (a.options.order ?? 0) - (b.options.order ?? 0))
}
/** 同标识插件重新装配时必须重建边界，避免沿用上一代的组件错误和局部状态。 */
const contributionKeys = new WeakMap<object, number>()
let contributionSequence = 0
export function contributionKey(value: object): number {
  let key = contributionKeys.get(value)
  if (key === undefined) {
    key = ++contributionSequence
    contributionKeys.set(value, key)
  }
  return key
}

export function useModes(): readonly ModeContribution[] {
  return useSlotEntries<ModeContribution>('modes').map(entry => entry.component)
}
export function useIslands(): readonly IslandContribution[] {
  return useSlotEntries<IslandContribution>('islands').map(entry => entry.component)
}
export function usePluginSettings(): readonly SettingsContribution[] {
  return useSlotEntries<SettingsContribution>('settings').map(entry => entry.component)
}

/** 一个插件的组件错误只影响它占据的区域；移除后重新注册会创建新的错误边界。 */
export class PluginBoundary extends Component<
  { name: string; children: ReactNode; fallback?: ReactNode },
  { error: string | null }
> {
  override state = { error: null as string | null }
  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : '插件界面发生异常' }
  }
  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`界面插件「${this.props.name}」发生错误`, error, info.componentStack)
  }
  override render() {
    return this.state.error === null
      ? this.props.children
      : (this.props.fallback ?? (
          <section role="alert" className="workspace-empty">
            <strong>{this.props.name}暂时不可用</strong>
            <p>{this.state.error}</p>
          </section>
        ))
  }
}

/** 插件图标也在外壳区域内渲染；图标异常时只留出原按钮，不中断导航。 */
export function PluginIconView({
  icon: Icon,
  name,
  size,
  strokeWidth,
}: {
  icon: PluginIcon
  name: string
  size?: number
  strokeWidth?: number
}) {
  const props = {
    'aria-hidden': true,
    ...(size === undefined ? {} : { size }),
    ...(strokeWidth === undefined ? {} : { strokeWidth }),
  } as const
  return (
    <PluginBoundary key={contributionKey(Icon)} name={`${name}图标`} fallback={null}>
      <Icon {...props} />
    </PluginBoundary>
  )
}

/** 动作按声明顺序渲染；组件继续使用外壳已有的项目和会话 Provider。 */
export function PluginActions({
  name,
  scopeKey = 'application',
}: {
  name: ActionSlot
  scopeKey?: string
}) {
  return useSlotEntries<React.ComponentType>(name).map(entry => {
    const View = entry.component
    return (
      <PluginBoundary key={`${contributionKey(entry)}:${scopeKey}`} name={entry.options.id ?? name}>
        <View />
      </PluginBoundary>
    )
  })
}

/** 工具结果只替换输出区域，工具状态、输入和时间仍由同一份会话投影拥有。 */
export function PluginToolResult({
  item,
  fallback,
  scopeKey,
}: {
  item: ConversationToolItem
  fallback: ReactNode
  scopeKey: string
}) {
  const contribution = useSlotEntries<React.ComponentType<ToolResultProps>>('tool.results').find(
    entry => entry.options.key === item.name,
  )
  if (!contribution) return fallback
  const View = contribution.component
  return (
    <PluginBoundary
      key={`${contributionKey(contribution)}:${scopeKey}`}
      name={item.name ?? '工具结果'}
      fallback={fallback}
    >
      <View item={item} />
    </PluginBoundary>
  )
}

/** 通知是独立有序区域；没有贡献时不占据浮岛布局。 */
export function PluginNotifications() {
  const entries = useSlotEntries<React.ComponentType>('shell.notifications')
  if (entries.length === 0) return null
  return (
    <aside
      className="plugin-notifications"
      aria-label="扩展通知"
      role="status"
      aria-live="polite"
      aria-relevant="additions text"
    >
      <PluginActions name="shell.notifications" />
    </aside>
  )
}

function PluginOverlay({ overlay }: { overlay: OverlayContribution }) {
  const [returnFocusTo] = useState(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  )
  useEffect(
    () => () => {
      // 插件卸载会直接移除 Modal，跳过其关闭动画；等 portal 清理后补回焦点。
      // 其他浮层已经取得焦点时不抢回，原触发点随作用域销毁时也不恢复。
      queueMicrotask(() => {
        if (returnFocusTo?.isConnected && document.activeElement === document.body)
          returnFocusTo.focus({ preventScroll: true })
      })
    },
    [returnFocusTo],
  )
  const View = overlay.component
  return (
    <Modal
      title={overlay.label}
      open
      footer={null}
      onCancel={overlay.close}
      centered
      focusable={{ trap: true, focusTriggerAfterClose: true }}
      destroyOnHidden
    >
      <PluginBoundary name={overlay.label}>
        <View close={overlay.close} />
      </PluginBoundary>
    </Modal>
  )
}

/** 外壳统一拥有焦点限制、Escape 和卸载后的焦点恢复。 */
export function PluginOverlays() {
  return useSlotEntries<OverlayContribution>('shell.overlays').map(entry => (
    <PluginOverlay key={contributionKey(entry)} overlay={entry.component} />
  ))
}
