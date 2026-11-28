/**
 * 主进程运行核心双路实时事件流（Session 流与 Host `$events` 流）协调器。
 *
 * 将两条长连接作为同一代订阅协同管理、指数退避重连并向受信任本地 renderer 推送帧；
 * 页面导航或应用退出时由 `stop()` 中止长连接并清空待响应交互状态。
 */

import type { BrowserWindow } from 'electron'
import type { DesktopSessionFrame } from '../../shared/session-live.ts'
import { asRecord } from '../../shared/validation.ts'
import type { createRuntimeStreamCarrier } from '../runtime/runtime-stream.ts'
import type { RuntimeState as DshHostState } from '../runtime/runtime-supervisor.ts'
import { followDshHostEventStream, type DshRemoteInteractionTarget } from './host-event-stream.ts'
import { followDshSessionStream } from './session-stream.ts'

/** 主进程到 renderer 的 Host 状态与实时流 IPC 通道名。 */
export const HOST_CHANNELS = Object.freeze({
  status: 'dsh-desktop:host:status',
  call: 'dsh-desktop:host:call',
  searchSessions: 'dsh-desktop:host:search-sessions',
  cancelSessionSearch: 'dsh-desktop:host:cancel-session-search',
  changed: 'dsh-desktop:host:status-changed',
  sessionFrame: 'dsh-desktop:host:session-frame',
  hostFrame: 'dsh-desktop:host:host-frame',
})

type ReadyHostState = Extract<DshHostState, { kind: 'ready' }>
type RuntimeStreamCarrier = ReturnType<typeof createRuntimeStreamCarrier>

/** 将主进程内部运行时状态裁剪为可发往 renderer 的公开快照。 */
export function publicHostState(state: DshHostState): Record<string, unknown> {
  return state.kind === 'ready'
    ? {
        kind: 'ready',
        ownership: state.ownership,
        identity: { reportedVersion: state.identity.reportedVersion },
      }
    : { kind: state.kind, message: state.message }
}

/** 创建实时事件流协调器的输入依赖。 */
export interface LiveStreamsCoordinatorOptions {
  readonly window: BrowserWindow
  readonly targetUrl: URL
  readonly runtimeStream: RuntimeStreamCarrier
  readonly isQuitting: () => boolean
  readonly isTrustedRendererPage: (url: string) => boolean
  readonly getCurrentHost: () => ReadyHostState | undefined
  readonly observeInteractionFrame: (
    frame: DesktopSessionFrame,
    remote?: DshRemoteInteractionTarget,
  ) => void
  readonly clearPendingInteractions: () => void
}

/** 实时事件流协调器实例。 */
export interface LiveStreamsCoordinator {
  readonly commandRunIdsObserved: Set<string>
  readonly commandDoneIdsObserved: Set<string>
  start(state: ReadyHostState): void
  stop(): Promise<void>
  followSessionOnPageLoad(payload: unknown, state: ReadyHostState): void
  getController(): AbortController | undefined
  isSessionStreamFrameObserved(): boolean
  isHostEventStreamFrameObserved(): boolean
}

function waitForAbortableDelay(signal: AbortSignal, delayMs: number): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) {
      resolve()
      return
    }
    const done = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, delayMs)
    timer.unref()
    signal.addEventListener('abort', done, { once: true })
  })
}

function recordObservedCommandLifecycle(
  frame: DesktopSessionFrame,
  runIds: Set<string>,
  doneIds: Set<string>,
): void {
  if (frame.type !== 'session/event') return
  if (frame.event.type !== 'command/run' && frame.event.type !== 'command/done') return
  const data = frame.event.data
  if (typeof data !== 'object' || data === null || !('commandId' in data)) return
  if (typeof data.commandId !== 'string') return
  const target = frame.event.type === 'command/run' ? runIds : doneIds
  target.add(data.commandId)
}

interface GenerationContext {
  readonly options: LiveStreamsCoordinatorOptions
  readonly state: ReadyHostState
  readonly controller: AbortController
  readonly commandRunIdsObserved: Set<string>
  readonly commandDoneIdsObserved: Set<string>
  readonly bindSelectSession: (select: ((id: string | undefined) => void) | undefined) => void
  readonly getFollowedSessionId: () => string | undefined
  readonly markSessionFrameObserved: () => void
  readonly markHostFrameObserved: () => void
  readonly onBothStreamsHealthy: () => void
  readonly markResetPending: () => void
}

function startSessionStreamTask(
  ctx: GenerationContext,
  signal: AbortSignal,
  canDeliver: () => boolean,
  onReady: () => void,
) {
  const { options, state } = ctx
  const initialSessionId = ctx.getFollowedSessionId()
  return followDshSessionStream({
    openSocket: options.runtimeStream,
    targetUrl: options.targetUrl,
    ...(state.sessionCookie === undefined ? {} : { cookie: state.sessionCookie }),
    signal,
    ...(initialSessionId === undefined ? {} : { sessionId: initialSessionId }),
    subscribeSelection: select => {
      ctx.bindSelectSession(select)
      const latestSessionId = ctx.getFollowedSessionId()
      if (latestSessionId !== initialSessionId) select(latestSessionId)
      return () => {
        ctx.bindSelectSession(undefined)
      }
    },
    onFrame: frame => {
      if (!canDeliver()) return
      ctx.markResetPending()
      onReady()
      ctx.markSessionFrameObserved()
      recordObservedCommandLifecycle(frame, ctx.commandRunIdsObserved, ctx.commandDoneIdsObserved)
      options.observeInteractionFrame(frame)
      options.window.webContents.send(HOST_CHANNELS.sessionFrame, frame)
    },
  })
}

function startHostStreamTask(
  ctx: GenerationContext,
  signal: AbortSignal,
  canDeliver: () => boolean,
  onReady: () => void,
) {
  const { options, state } = ctx
  return followDshHostEventStream({
    openSocket: options.runtimeStream,
    targetUrl: options.targetUrl,
    ...(state.sessionCookie === undefined ? {} : { cookie: state.sessionCookie }),
    signal,
    onFrame: frame => {
      if (!canDeliver()) return
      ctx.markResetPending()
      onReady()
      ctx.markHostFrameObserved()
      options.window.webContents.send(HOST_CHANNELS.hostFrame, frame)
    },
    onSessionFrame: (frame, remote) => {
      if (!canDeliver()) return
      ctx.markResetPending()
      options.observeInteractionFrame(frame, remote)
      options.window.webContents.send(HOST_CHANNELS.sessionFrame, frame)
    },
  })
}

async function runSingleStreamGeneration(
  ctx: GenerationContext,
): Promise<
  | { readonly outcome: 'aborted' }
  | { readonly outcome: 'capability-unavailable'; readonly stream: 'session' | 'host' }
  | { readonly outcome: 'disconnected' }
> {
  const { options, state, controller } = ctx
  const generation = new AbortController()
  let sessionReady = false
  let hostReady = false
  const abortGeneration = (): void => generation.abort()
  controller.signal.addEventListener('abort', abortGeneration, { once: true })

  const canDeliver = (): boolean =>
    !controller.signal.aborted &&
    !generation.signal.aborted &&
    options.getCurrentHost() === state &&
    !options.window.isDestroyed() &&
    options.isTrustedRendererPage(options.window.webContents.getURL())

  try {
    const sessionTask = startSessionStreamTask(ctx, generation.signal, canDeliver, () => {
      sessionReady = true
      if (hostReady) ctx.onBothStreamsHealthy()
    })
    const hostTask = startHostStreamTask(ctx, generation.signal, canDeliver, () => {
      hostReady = true
      if (sessionReady) ctx.onBothStreamsHealthy()
    })
    const first = await Promise.race([
      sessionTask.then(
        result => ({ stream: 'session' as const, result }),
        (error: unknown) => ({ stream: 'session' as const, error }),
      ),
      hostTask.then(
        result => ({ stream: 'host' as const, result }),
        (error: unknown) => ({ stream: 'host' as const, error }),
      ),
    ])
    generation.abort()
    await Promise.allSettled([sessionTask, hostTask])
    if ('error' in first) throw first.error
    if (first.result.kind === 'aborted' || controller.signal.aborted) return { outcome: 'aborted' }
    if (first.result.kind === 'capability-unavailable') {
      return { outcome: 'capability-unavailable', stream: first.stream }
    }
    return { outcome: 'disconnected' }
  } catch (error) {
    generation.abort()
    throw error
  } finally {
    controller.signal.removeEventListener('abort', abortGeneration)
  }
}

async function runCoordinatorReconnectLoop(options: {
  readonly baseContext: Omit<GenerationContext, 'onBothStreamsHealthy' | 'markResetPending'>
  readonly resetBeforeGeneration: () => void
  readonly reportStreamState: (message?: string, exhausted?: boolean) => void
  readonly publishStreamReset: () => void
  readonly markResetPending: () => void
}): Promise<void> {
  const {
    baseContext,
    resetBeforeGeneration,
    reportStreamState,
    publishStreamReset,
    markResetPending,
  } = options
  const { controller } = baseContext
  let retryDelayMs = 400
  let consecutiveErrors = 0
  /* oxlint-disable no-await-in-loop -- 两条长连接必须作为同一代重建，并按退避顺序重试。 */
  while (!controller.signal.aborted) {
    const startedAt = Date.now()
    resetBeforeGeneration()
    try {
      const result = await runSingleStreamGeneration({
        ...baseContext,
        onBothStreamsHealthy: () => reportStreamState(),
        markResetPending,
      })
      if (result.outcome === 'aborted' || controller.signal.aborted) return
      if (result.outcome === 'capability-unavailable') {
        publishStreamReset()
        reportStreamState('运行核心的事件接口不可用，请修复 MyDSH 安装后重试。', true)
        console.warn(
          `当前 MyDSH 运行核心 未提供公开 ${result.stream === 'session' ? 'Session' : 'Host'} 事件流，实时消息、运行状态与队列已降级。`,
        )
        return
      }
      publishStreamReset()
      reportStreamState('实时连接已断开，正在恢复…')
      await waitForAbortableDelay(controller.signal, retryDelayMs)
      retryDelayMs = Math.min(retryDelayMs * 2, 4_000)
    } catch (error) {
      if (controller.signal.aborted) return
      publishStreamReset()
      if (Date.now() - startedAt >= 10_000) consecutiveErrors = 0
      consecutiveErrors += 1
      console.warn('DSH 实时事件流失败：', error)
      if (consecutiveErrors >= 3) {
        reportStreamState('实时连接恢复失败，请切换会话重试；若仍失败，请重新打开应用。', true)
        return
      }
      reportStreamState('实时连接失败，正在重试…')
      await waitForAbortableDelay(controller.signal, retryDelayMs)
      retryDelayMs = Math.min(retryDelayMs * 2, 4_000)
    }
  }
  /* oxlint-enable no-await-in-loop */
}

interface CoordinatorMutableState {
  liveStreamsController: AbortController | undefined
  liveStreamsHost: ReadyHostState | undefined
  selectLiveSession: ((sessionId: string | undefined) => void) | undefined
  followedSessionId: string | undefined
  liveStreamsTask: Promise<void> | undefined
  sessionStreamFrameObserved: boolean
  hostEventStreamFrameObserved: boolean
  readonly commandRunIdsObserved: Set<string>
  readonly commandDoneIdsObserved: Set<string>
}

function startLiveStreamGeneration(
  options: LiveStreamsCoordinatorOptions,
  mutable: CoordinatorMutableState,
  stop: () => Promise<void>,
  state: ReadyHostState,
): void {
  const { window, isQuitting, isTrustedRendererPage, getCurrentHost, clearPendingInteractions } =
    options
  if (isQuitting() || window.isDestroyed() || !isTrustedRendererPage(window.webContents.getURL())) {
    return
  }
  if (mutable.liveStreamsHost === state) return
  void stop()
  const controller = new AbortController()
  mutable.liveStreamsController = controller
  mutable.liveStreamsHost = state
  let resetPublished = false
  let streamDisconnected = true

  const isActiveHostOnPage = (): boolean =>
    !controller.signal.aborted &&
    getCurrentHost() === state &&
    !window.isDestroyed() &&
    isTrustedRendererPage(window.webContents.getURL())

  const task = runCoordinatorReconnectLoop({
    baseContext: {
      options,
      state,
      controller,
      commandRunIdsObserved: mutable.commandRunIdsObserved,
      commandDoneIdsObserved: mutable.commandDoneIdsObserved,
      bindSelectSession: select => {
        mutable.selectLiveSession = select
      },
      getFollowedSessionId: () => mutable.followedSessionId,
      markSessionFrameObserved: () => {
        mutable.sessionStreamFrameObserved = true
      },
      markHostFrameObserved: () => {
        mutable.hostEventStreamFrameObserved = true
      },
    },
    resetBeforeGeneration: () => {
      mutable.sessionStreamFrameObserved = false
    },
    reportStreamState: (message, exhausted = false) => {
      if (!isActiveHostOnPage()) return
      if (message === undefined && !streamDisconnected) return
      streamDisconnected = message !== undefined
      const payload =
        message === undefined
          ? publicHostState(state)
          : { kind: exhausted ? 'unavailable' : 'connecting', message }
      window.webContents.send(HOST_CHANNELS.changed, payload)
    },
    publishStreamReset: () => {
      if (resetPublished || !isActiveHostOnPage()) return
      resetPublished = true
      clearPendingInteractions()
      window.webContents.send(HOST_CHANNELS.sessionFrame, { type: 'session/stream-reset' })
    },
    markResetPending: () => {
      resetPublished = false
    },
  })

  mutable.liveStreamsTask = task
  void task.finally(() => {
    if (mutable.liveStreamsController === controller) {
      mutable.liveStreamsController = undefined
      mutable.liveStreamsTask = undefined
      mutable.liveStreamsHost = undefined
    }
  })
}

/** 创建主进程双路实时流协调器。 */
export function createLiveStreamsCoordinator(
  options: LiveStreamsCoordinatorOptions,
): LiveStreamsCoordinator {
  const mutable: CoordinatorMutableState = {
    liveStreamsController: undefined,
    liveStreamsHost: undefined,
    selectLiveSession: undefined,
    followedSessionId: undefined,
    liveStreamsTask: undefined,
    sessionStreamFrameObserved: false,
    hostEventStreamFrameObserved: false,
    commandRunIdsObserved: new Set<string>(),
    commandDoneIdsObserved: new Set<string>(),
  }

  const stop = (): Promise<void> => {
    const task = mutable.liveStreamsTask
    mutable.liveStreamsController?.abort()
    mutable.liveStreamsController = undefined
    mutable.liveStreamsHost = undefined
    mutable.selectLiveSession = undefined
    mutable.liveStreamsTask = undefined
    options.clearPendingInteractions()
    return task ?? Promise.resolve()
  }

  const start = (state: ReadyHostState): void =>
    startLiveStreamGeneration(options, mutable, stop, state)

  return {
    commandRunIdsObserved: mutable.commandRunIdsObserved,
    commandDoneIdsObserved: mutable.commandDoneIdsObserved,
    start,
    stop,
    followSessionOnPageLoad(payload, state) {
      const request = asRecord(payload)
      const nextSessionId = request?.sessionId
      if (
        request?.beforeSeq === undefined &&
        typeof nextSessionId === 'string' &&
        nextSessionId.length > 0 &&
        nextSessionId.length <= 512 &&
        nextSessionId !== mutable.followedSessionId
      ) {
        mutable.followedSessionId = nextSessionId
        mutable.selectLiveSession?.(nextSessionId)
        start(state)
      }
    },
    getController: () => mutable.liveStreamsController,
    isSessionStreamFrameObserved: () => mutable.sessionStreamFrameObserved,
    isHostEventStreamFrameObserved: () => mutable.hostEventStreamFrameObserved,
  }
}
