/**
 * 主进程运行核心动作分发、会话搜索、会话日志导出与插件忙状态 IPC 控制器。
 *
 * 复核本地 renderer 调用方身份后分发产品动作、交互回答与斜杠命令；拥有在途会话搜索与
 * ZIP 日志导出的 `AbortController`，退出时由 `dispose()` 中止任务并等待句柄关闭。
 */

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { asRecord } from '../../shared/validation.ts'
import { callImportController } from '../runtime/import-controller.ts'
import { choosePluginDirectory, pluginOperationPayload } from '../runtime/plugin-controller.ts'
import type { createRuntimeStreamCarrier } from '../runtime/runtime-stream.ts'
import type { MydshRuntimeSupervisor } from '../runtime/runtime-supervisor.ts'
import { saveSessionLog } from '../session-exports/session-log-export.ts'
import type { ProjectIpcController } from '../workspace/project-ipc-controller.ts'
import { callDshHost } from './host-client.ts'
import { readDshWorkspaceBaseline } from './host-event-stream.ts'
import type { InteractionBroker } from './interaction-broker.ts'
import {
  HOST_CHANNELS,
  publicHostState,
  type LiveStreamsCoordinator,
} from './live-streams-coordinator.ts'

export { HOST_CHANNELS } from './live-streams-coordinator.ts'

const COMMAND_CHANNELS = Object.freeze({
  list: 'dsh-desktop:commands:list',
  listSkills: 'dsh-desktop:commands:list-skills',
  execute: 'dsh-desktop:commands:execute',
})
const SESSION_EXPORT_CHANNELS = Object.freeze({
  save: 'dsh-desktop:session-exports:save',
})
const INTERACTION_CHANNELS = Object.freeze({
  respond: 'dsh-desktop:interactions:respond',
})
const PLUGIN_BUSY_CHANNEL = 'mydsh:plugins:busy'

type RuntimeStreamCarrier = ReturnType<typeof createRuntimeStreamCarrier>

/** 安装 Host IPC 控制器的输入依赖。 */
export interface HostIpcControllerOptions {
  readonly window: BrowserWindow
  readonly targetUrl: URL
  readonly supervisor: MydshRuntimeSupervisor
  readonly runtimeStream: RuntimeStreamCarrier
  readonly liveStreams: LiveStreamsCoordinator
  readonly interactionBroker: InteractionBroker
  readonly projectController: ProjectIpcController
  readonly assertSender: (event: IpcMainInvokeEvent) => void
  readonly isQuitting: () => boolean
  readonly isDocumentEdited: () => boolean
}

/** 已安装的 Host IPC 控制器实例。 */
export interface HostIpcController {
  syncPluginBusy(): Promise<void>
  getSessionExportController(): AbortController | undefined
  abortPendingSearch(): void
  abortPendingExport(): void
  dispose(): Promise<void>
}

interface HostIpcMutableState {
  sessionSearchController: AbortController | undefined
  sessionExportController: AbortController | undefined
  sessionExportTask: Promise<unknown> | undefined
  sessionExportPickerOpen: boolean
  pluginBusyReasons: string[]
}

function resolveExportDirectory(): string {
  for (const name of ['downloads', 'documents', 'home', 'temp'] as const) {
    try {
      const directory = app.getPath(name)
      if (directory !== '') return directory
    } catch {
      /* 系统已知目录缺失或未在隔离配置下注册时顺序回退。 */
    }
  }
  return tmpdir()
}

async function dispatchSpecialHostOperation(
  options: HostIpcControllerOptions,
  state: HostIpcMutableState,
  syncPluginBusy: () => Promise<void>,
  request: { readonly operation: unknown; readonly payload: unknown },
): Promise<{ handled: true; value: unknown } | { handled: false }> {
  const { operation, payload } = request
  if (operation === 'mydshPlugins.chooseDirectory') {
    const parsed = asRecord(payload)
    if (!parsed || Object.keys(parsed).length !== 0) {
      throw new Error('选择插件目录不接受额外参数')
    }
    return { handled: true, value: await choosePluginDirectory(options.window) }
  }
  if (
    typeof operation === 'string' &&
    /^mydshImport\.(preview|commit|credentials)$/.test(operation)
  ) {
    const value = await callImportController(
      options.supervisor,
      operation,
      asRecord(payload) ?? {},
      options.isDocumentEdited() || state.pluginBusyReasons.length > 0,
    )
    return { handled: true, value }
  }
  if (
    typeof operation === 'string' &&
    /^mydshPlugins\.(list|install|update|enable|disable|uninstall|rollback)$/.test(operation)
  ) {
    const parsed = pluginOperationPayload(operation, payload)
    if (operation !== 'mydshPlugins.list') await syncPluginBusy()
    const result = (await options.supervisor.call(operation.replace('.', '/'), parsed)) as {
      ok: boolean
      value?: unknown
      error?: { message: string }
    }
    if (!result.ok) throw new Error(result.error?.message ?? '插件操作失败')
    return { handled: true, value: result.value }
  }
  return { handled: false }
}

async function invokeHostCall(
  options: HostIpcControllerOptions,
  mutable: HostIpcMutableState,
  syncPluginBusy: () => Promise<void>,
  request: { readonly operation: unknown; readonly payload: unknown },
): Promise<unknown> {
  const { targetUrl, supervisor, runtimeStream, liveStreams, projectController } = options
  const { operation, payload } = request
  const state = supervisor.getState()
  if (state.kind !== 'ready') throw new Error('MyDSH 运行核心 当前不可用')
  liveStreams.start(state)
  const special = await dispatchSpecialHostOperation(options, mutable, syncPluginBusy, request)
  if (special.handled) return special.value
  try {
    if (operation === 'loadSessionPage') liveStreams.followSessionOnPageLoad(payload, state)
    const value =
      operation === 'listWorkspaces'
        ? await readDshWorkspaceBaseline({
            openSocket: runtimeStream,
            targetUrl,
            ...(state.sessionCookie === undefined ? {} : { cookie: state.sessionCookie }),
          })
        : await callDshHost(
            targetUrl,
            operation,
            payload,
            supervisor.fetch,
            state.sessionCookie,
            liveStreams.getController()?.signal,
          )
    if (operation === 'listWorkspaces') await projectController.syncFromWorkspaceBaseline(value)
    if (operation === 'listSessions') await projectController.syncFromSessionsList(value)
    return value
  } catch (error) {
    console.warn('MyDSH 运行核心 RPC 调用失败：', error)
    throw new Error(error instanceof Error ? error.message : 'MyDSH 运行核心 RPC 调用失败', {
      cause: error,
    })
  }
}

async function invokeSessionExportSave(
  options: HostIpcControllerOptions,
  mutable: HostIpcMutableState,
  event: IpcMainInvokeEvent,
  sessionId: unknown,
): Promise<unknown> {
  const { window, supervisor, assertSender, isQuitting } = options
  if (isQuitting()) throw new Error('MyDSH 正在退出，不能导出会话日志')
  if (supervisor.getState().kind !== 'ready') throw new Error('MyDSH 运行核心 当前不可用')
  // 仅使用已安装核心所属的数据根，不能接受 renderer 指定来源路径。
  const installation = supervisor.installed
  if (installation === undefined) throw new Error('MyDSH 运行核心 当前不可用')
  if (mutable.sessionExportController !== undefined || mutable.sessionExportPickerOpen) {
    throw new Error('已有会话日志正在导出或等待选择保存位置')
  }
  const controller = new AbortController()
  mutable.sessionExportController = controller
  try {
    const task = saveSessionLog({
      dataRoot: join(installation.mydshHome, 'data'),
      sessionId,
      signal: controller.signal,
      chooseDestination: async suggestedName => {
        assertSender(event)
        if (window.isDestroyed()) throw new Error('桌面窗口已关闭，无法导出会话日志')
        // 等待已取消的选路径对话框真正关闭，避免同一窗口叠加原生对话框。
        mutable.sessionExportPickerOpen = true
        try {
          const result = await dialog.showSaveDialog(window, {
            title: '导出会话日志',
            buttonLabel: '导出',
            defaultPath: join(resolveExportDirectory(), suggestedName),
            filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }],
          })
          if (controller.signal.aborted) return null
          assertSender(event)
          return result.canceled || result.filePath === undefined ? null : result.filePath
        } finally {
          mutable.sessionExportPickerOpen = false
        }
      },
    })
    mutable.sessionExportTask = task
    return await task
  } catch (error) {
    console.warn('MyDSH 会话日志导出失败：', error)
    throw new Error(error instanceof Error ? error.message : 'MyDSH 会话日志导出失败', {
      cause: error,
    })
  } finally {
    if (mutable.sessionExportController === controller) {
      mutable.sessionExportController = undefined
      mutable.sessionExportTask = undefined
    }
  }
}

async function invokeSessionSearch(
  options: HostIpcControllerOptions,
  mutable: HostIpcMutableState,
  query: unknown,
): Promise<unknown> {
  const { targetUrl, supervisor } = options
  const state = supervisor.getState()
  if (state.kind !== 'ready') throw new Error('MyDSH 运行核心 当前不可用')
  mutable.sessionSearchController?.abort()
  const controller = new AbortController()
  mutable.sessionSearchController = controller
  try {
    return await callDshHost(
      targetUrl,
      'searchSessions',
      { query },
      supervisor.fetch,
      state.sessionCookie,
      controller.signal,
    )
  } catch (error) {
    if (controller.signal.aborted) throw new Error('会话搜索已取消', { cause: error })
    console.warn('MyDSH 会话搜索失败：', error)
    throw new Error(error instanceof Error ? error.message : 'MyDSH 会话搜索失败', {
      cause: error,
    })
  } finally {
    if (mutable.sessionSearchController === controller) mutable.sessionSearchController = undefined
  }
}

function registerSlashCommandHandlers(options: HostIpcControllerOptions): void {
  const { targetUrl, supervisor, assertSender } = options
  const invokeCommand = async (
    event: IpcMainInvokeEvent,
    operation: 'listSessionCommands' | 'listSessionSkills' | 'executeSessionCommand',
    payload: unknown,
  ): Promise<unknown> => {
    assertSender(event)
    const state = supervisor.getState()
    if (state.kind !== 'ready') throw new Error('MyDSH 运行核心 当前不可用')
    try {
      return await callDshHost(targetUrl, operation, payload, supervisor.fetch, state.sessionCookie)
    } catch (error) {
      console.warn('DSH Command 能力调用失败：', error)
      throw new Error(error instanceof Error ? error.message : 'DSH Command 能力调用失败', {
        cause: error,
      })
    }
  }
  ipcMain.handle(COMMAND_CHANNELS.list, (event, sessionId: unknown) =>
    invokeCommand(event, 'listSessionCommands', { sessionId }),
  )
  ipcMain.handle(COMMAND_CHANNELS.listSkills, (event, sessionId: unknown) =>
    invokeCommand(event, 'listSessionSkills', { sessionId }),
  )
  ipcMain.handle(COMMAND_CHANNELS.execute, (event, request: unknown) =>
    invokeCommand(event, 'executeSessionCommand', request),
  )
}

function removeAllHostIpcHandlers(): void {
  for (const channel of [
    HOST_CHANNELS.status,
    HOST_CHANNELS.call,
    HOST_CHANNELS.searchSessions,
    HOST_CHANNELS.cancelSessionSearch,
    SESSION_EXPORT_CHANNELS.save,
    INTERACTION_CHANNELS.respond,
    COMMAND_CHANNELS.list,
    COMMAND_CHANNELS.listSkills,
    COMMAND_CHANNELS.execute,
    PLUGIN_BUSY_CHANNEL,
  ]) {
    ipcMain.removeHandler(channel)
  }
}

/** 安装运行核心动作、交互、导出与插件忙状态 IPC 处理器。 */
export function installHostIpcController(options: HostIpcControllerOptions): HostIpcController {
  const { supervisor, liveStreams, interactionBroker, assertSender, isDocumentEdited } = options
  const mutable: HostIpcMutableState = {
    sessionSearchController: undefined,
    sessionExportController: undefined,
    sessionExportTask: undefined,
    sessionExportPickerOpen: false,
    pluginBusyReasons: [],
  }

  const syncPluginBusy = async (): Promise<void> => {
    if (supervisor.getState().kind !== 'ready') return
    const reasons = [
      ...(isDocumentEdited() ? ['存在未保存的文件'] : []),
      ...mutable.pluginBusyReasons,
    ]
    try {
      await supervisor.call('mydshRuntime/uiBusy', { reason: reasons.join('；').slice(0, 4096) })
    } catch (error) {
      // 重启期间只保留桌面的最新事实；核心再次就绪时统一补发，不让编辑缓冲报错。
      if (supervisor.getState().kind === 'ready') throw error
    }
  }

  ipcMain.handle(PLUGIN_BUSY_CHANNEL, async (event, reasons: unknown) => {
    assertSender(event)
    if (
      !Array.isArray(reasons) ||
      reasons.length > 32 ||
      reasons.some(
        reason => typeof reason !== 'string' || reason.length === 0 || reason.length > 512,
      )
    ) {
      throw new Error('插件占用原因无效')
    }
    mutable.pluginBusyReasons = reasons as string[]
    await syncPluginBusy()
  })

  ipcMain.handle(HOST_CHANNELS.status, event => {
    assertSender(event)
    const state = supervisor.getState()
    if (state.kind === 'ready') liveStreams.start(state)
    return publicHostState(state)
  })

  ipcMain.handle(HOST_CHANNELS.call, async (event, operation: unknown, payload: unknown) => {
    assertSender(event)
    return invokeHostCall(options, mutable, syncPluginBusy, { operation, payload })
  })

  ipcMain.handle(INTERACTION_CHANNELS.respond, async (event, submission: unknown) => {
    assertSender(event)
    return interactionBroker.respond(submission)
  })

  ipcMain.handle(HOST_CHANNELS.searchSessions, async (event, query: unknown) => {
    assertSender(event)
    return invokeSessionSearch(options, mutable, query)
  })

  ipcMain.handle(HOST_CHANNELS.cancelSessionSearch, event => {
    assertSender(event)
    mutable.sessionSearchController?.abort()
    mutable.sessionSearchController = undefined
  })

  ipcMain.handle(SESSION_EXPORT_CHANNELS.save, async (event, sessionId: unknown) => {
    assertSender(event)
    return invokeSessionExportSave(options, mutable, event, sessionId)
  })

  registerSlashCommandHandlers(options)

  return {
    syncPluginBusy,
    getSessionExportController: () => mutable.sessionExportController,
    abortPendingSearch: () => mutable.sessionSearchController?.abort(),
    abortPendingExport: () => mutable.sessionExportController?.abort(),
    async dispose() {
      mutable.sessionSearchController?.abort()
      mutable.sessionExportController?.abort()
      removeAllHostIpcHandlers()
      await mutable.sessionExportTask?.catch(() => {})
    },
  }
}
