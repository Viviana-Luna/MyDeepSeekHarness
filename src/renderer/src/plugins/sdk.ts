/** 用户插件的唯一界面开发入口；由宿主共享实例，不应打入插件产物。 */
export {
  MydshSlots,
  type IslandContribution,
  type IslandPlacement,
  type IslandPresentationProps,
  type IslandScope,
  type IslandVisibility,
  type ModeContribution,
  type SettingsContribution,
  type SettingsPageProps,
  type ActionSlot,
  type ToolResultProps,
  type OverlayContribution,
} from './registry.ts'
export { useUiRuntime, useModes, useIslands, PluginActions, PluginBoundary } from './react.tsx'
export { useWorkspaceSnapshot, useWorkspaceStore } from '../hooks/useWorkspace.ts'
export { useProjectWorkspace } from '../features/project-workspace/ProjectWorkspaceProvider.tsx'
export { getDesktopBridge } from '../services/desktop.ts'

import { getDesktopBridge } from '../services/desktop.ts'

let callSequence = 0

/**
 * 调用运行时公开方法，参数由 Typert 校验。Signal 留在 renderer，通过请求编号取消后台调用；
 * 取消后不等待远端返回，也不会在重连时重放。插件应在其生命周期清理时 abort。
 */
export function callRemote(
  endpoint: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  if (signal?.aborted) return Promise.reject(new DOMException('调用已取消', 'AbortError'))
  const remote = getDesktopBridge().remote
  if (!signal) return remote.call(endpoint, args)
  if (callSequence >= 999_999_999_999)
    return Promise.reject(new Error('本页调用编号已耗尽，请重新启动 MyDSH'))
  const id = String(++callSequence)
  // 必须先提交请求再发送取消，保证主进程可定位同一条活动调用。
  const pending = remote.call(endpoint, args, id)
  return new Promise((resolve, reject) => {
    const abort = () => {
      void remote.cancelCall(id).catch(() => undefined)
      reject(new DOMException('调用已取消', 'AbortError'))
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    // 即使本地先取消，也消费远端迟到的拒绝，避免产生未处理的 Promise。
    pending.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', abort)
    })
  })
}

/** 订阅逻辑流；请通过 ctx.effect(() => followRemote(...)) 在插件停用时取消。 */
export function followRemote(
  endpoint: string,
  args: Record<string, unknown>,
  onItem: (value: unknown) => void,
  onError: (message: string) => void,
): () => void {
  return getDesktopBridge().remote.follow(endpoint, args, onItem, onError)
}
