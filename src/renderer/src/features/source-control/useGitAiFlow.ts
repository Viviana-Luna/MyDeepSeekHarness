/** renderer 将项目作用域 AI 状态机接入 SourceControlProvider；卸载时撤销其后台请求。 */
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { getDesktopBridge } from '../../services/desktop.ts'
import type { SessionModels } from '../../domain/session-controls.ts'
import { GitAiFlowController } from './git-ai-flow.ts'

/** 项目边界在创建状态机时固定，迟到取消不会发给新项目。 */
export function useGitAiFlow(options: {
  projectId: string | null
  models: SessionModels | null
  openDiff(value: unknown): void
  refresh(): Promise<void>
}) {
  const controller = useMemo(
    () =>
      new GitAiFlowController({
        models: null,
        call: (operation, payload) => {
          if (!options.projectId) return Promise.reject(new Error('请先选择项目'))
          return getDesktopBridge().projects!.call(operation, {
            ...payload,
            projectId: options.projectId,
          })
        },
        catalog: () => getDesktopBridge().host.call('listHostModels', {}),
        openDiff: () => {},
        refresh: async () => {},
      }),
    [options.projectId],
  )
  controller.options.models = options.models
  controller.options.openDiff = options.openDiff
  controller.options.refresh = options.refresh
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot)
  useEffect(
    () => () => {
      controller.dispose()
    },
    [controller],
  )
  return {
    ...state,
    setPlan: controller.setPlan,
    setScope: controller.setScope,
    setModel: controller.setModel,
    setWholeFileIds: controller.setWholeFileIds,
    enter: controller.enter,
    release: controller.release,
    analyze: controller.analyze,
    execute: controller.execute,
    openFile: controller.openFile,
  }
}

/** 左栏消费同一状态机，不复制方案与执行进度。 */
export type GitAiFlow = ReturnType<typeof useGitAiFlow>
