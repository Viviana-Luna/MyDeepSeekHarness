import { accessSync, constants, lstatSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, isAbsolute, win32 } from 'node:path'
import type { ProjectTaskLaunch } from '../../shared/project-tasks.ts'
import {
  DESKTOP_TERMINAL_LIMITS,
  type DesktopTerminalCreateRequest,
  type DesktopTerminalDescriptor,
  type DesktopTerminalEvent,
} from '../../shared/terminal.ts'
import { asRecord } from '../../shared/validation.ts'

interface Disposable {
  dispose(): void
}

export interface TerminalProcess {
  readonly pid: number
  onData(listener: (data: string) => void): Disposable
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): Disposable
  write(data: string): void | Promise<void>
  resize(columns: number, rows: number): void | Promise<void>
  kill(signal?: string): void | Promise<void>
}

export interface TerminalSpawnOptions {
  executable: string
  args: readonly string[]
  cwd: string
  env: Record<string, string>
  columns: number
  rows: number
}

type ResolvedTerminalLaunch =
  | {
      kind: 'shell'
      title: string
      executable: string
      args: readonly string[]
      cwd: string
      env: Record<string, string>
    }
  | {
      kind: 'task'
      title: string
      taskId: string
      allowConcurrent: boolean
      executable: string
      args: readonly string[]
      cwd: string
      env: Record<string, string>
    }

export type TerminalProcessFactory = (
  options: TerminalSpawnOptions,
) => TerminalProcess | Promise<TerminalProcess>

interface TerminalRecord {
  readonly id: string
  readonly ownerId: number
  readonly process: TerminalProcess
  readonly taskId?: string
  attached: boolean
  pendingOutput: string
  exitEvent?: Extract<DesktopTerminalEvent, { type: 'exit' }>
  dataSubscription?: Disposable
  exitSubscription?: Disposable
}

/** Runtime 拥有 PTY；窗口标识仅用于资源归属，事件订阅取消不销毁终端。 */
export interface TerminalService {
  create(
    ownerId: number,
    input: unknown,
    task?: ProjectTaskLaunch,
  ): Promise<DesktopTerminalDescriptor>
  ready(ownerId: number, id: unknown): void
  write(ownerId: number, id: unknown, input: unknown): void | Promise<void>
  resize(ownerId: number, id: unknown, columns: unknown, rows: unknown): void | Promise<void>
  close(ownerId: number, id: unknown): Promise<void>
  dispose(): Promise<void>
}

function terminalId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    throw new Error('终端标识无效')
  }
  return value
}

function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label}必须是 ${String(minimum)} 到 ${String(maximum)} 之间的整数`)
  }
  return value as number
}

function parseCreateRequest(value: unknown): DesktopTerminalCreateRequest {
  const input = asRecord(value)
  if (input === null) throw new Error('终端创建参数无效')
  if (
    typeof input.projectId !== 'string' ||
    input.projectId.length === 0 ||
    input.projectId.length > 512
  ) {
    throw new Error('终端项目标识无效')
  }
  return {
    projectId: input.projectId,
    ...(input.taskId === undefined ? {} : { taskId: parseTaskId(input.taskId) }),
    columns: boundedInteger(
      input.columns,
      '终端列数',
      DESKTOP_TERMINAL_LIMITS.minColumns,
      DESKTOP_TERMINAL_LIMITS.maxColumns,
    ),
    rows: boundedInteger(
      input.rows,
      '终端行数',
      DESKTOP_TERMINAL_LIMITS.minRows,
      DESKTOP_TERMINAL_LIMITS.maxRows,
    ),
  }
}

function parseTaskId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9-]{36}$/u.test(value)) {
    throw new Error('终端项目任务标识无效')
  }
  return value
}

function parseInput(value: unknown): string {
  if (typeof value !== 'string') throw new Error('终端输入必须是字符串')
  if (Buffer.byteLength(value, 'utf8') > DESKTOP_TERMINAL_LIMITS.maxInputBytes) {
    throw new Error('单次终端输入不能超过 256 KiB')
  }
  return value
}

/**
 * 一条交互终端的启动规格。可执行文件与参数必须成对决定：POSIX 的 `-l`
 * 在 cmd 与 PowerShell 上都是无效开关，不能脱离平台单独拼接参数。
 */
export interface TerminalShellSpec {
  readonly executable: string
  readonly args: readonly string[]
}

/** 系统 Windows PowerShell 5.1 的固定位置，作为最后的兜底候选。 */
const WINDOWS_POWERSHELL_SUFFIX = [
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
] as const
/** PowerShell 的免配置交互参数，与 `packages/terminal/terminal-bash` 的 pwsh 方言默认值一致。 */
const POWERSHELL_ARGS = ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass']

/**
 * Windows 候选探测：用 lstat 打开条目本身而不跟随重解析点。Microsoft Store 的
 * `pwsh` 是应用执行别名，stat 会撞上目标 ACL 报 EACCES，而 CreateProcess 两者都能启动。
 */
function windowsCandidate(path: string): boolean {
  try {
    const info = lstatSync(path)
    return info.isFile() || info.isSymbolicLink()
  } catch {
    // ENOENT 表示候选在列出后消失；其他错误同样是不可能启动的路径，继续下一个候选。
    return false
  }
}

/** POSIX 候选探测：沿用原有语义，要求绝对路径且带执行位。 */
function posixCandidate(path: string): boolean {
  if (!isAbsolute(path) || path.includes('\0')) return false
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * 默认交互 Shell。POSIX 读 `$SHELL`（带执行位校验），缺失时沿用既有的 `/bin/zsh`；
 * Windows 没有 `$SHELL`，按 PowerShell 7、PATH（含 Store 别名）、系统 Windows
 * PowerShell 5.1 的顺序探测，候选顺序与 `packages/shell/pwsh-local` 保持一致，
 * 全部缺失时交给 CreateProcess 按 PATH 解析 `pwsh`。
 * @param env - 探测使用的环境，默认当前进程环境。
 * @param platform - 目标平台，默认当前平台，显式传入便于按平台覆盖测试。
 * @param runnable - 候选可用性判定，默认按平台选择，测试可注入。
 * @returns 可执行文件与配套的交互参数。
 */
export function resolveLoginShell(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  runnable: (path: string) => boolean = platform === 'win32' ? windowsCandidate : posixCandidate,
): TerminalShellSpec {
  if (platform !== 'win32') {
    const configured = env.SHELL
    if (configured !== undefined && runnable(configured))
      return { executable: configured, args: ['-l'] }
    return { executable: '/bin/zsh', args: ['-l'] }
  }
  if (env.MYDSH_PWSH_EXECUTABLE) {
    if (!runnable(env.MYDSH_PWSH_EXECUTABLE))
      throw new Error('随包 PowerShell 不可用，请修复核心安装')
    return { executable: env.MYDSH_PWSH_EXECUTABLE, args: POWERSHELL_ARGS }
  }
  // 按目标平台拼接，跨平台检查时也必须保留 Windows 路径规则。
  const candidates = [
    win32.join(env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
    ...(env.PATH ?? '')
      .split(';')
      .map(entry => entry.trim().replace(/^"|"$/g, ''))
      .filter(entry => entry.length > 0)
      .map(entry => win32.join(entry, 'pwsh.exe')),
    win32.join(env.SystemRoot ?? 'C:\\Windows', ...WINDOWS_POWERSHELL_SUFFIX),
  ]
  for (const candidate of candidates) {
    if (runnable(candidate)) return { executable: candidate, args: POWERSHELL_ARGS }
  }
  return { executable: 'pwsh', args: POWERSHELL_ARGS }
}

function terminalEnvironment(
  overrides: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )
  return {
    ...env,
    ...overrides,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'MyDSH',
  }
}

export function createTerminalService(options: {
  onEvent: (event: DesktopTerminalEvent) => void
  resolveProjectDirectory: (projectId: unknown) => string
  processFactory: TerminalProcessFactory
  resolveShell?: () => TerminalShellSpec
}): TerminalService {
  const {
    onEvent,
    resolveProjectDirectory,
    processFactory,
    resolveShell = resolveLoginShell,
  } = options
  const terminals = new Map<string, TerminalRecord>()
  const pendingTaskIds = new Set<string>()
  let disposed = false
  let pendingCreates = 0
  const creating = new Set<Promise<DesktopTerminalDescriptor>>()
  const closing = new Map<string, Promise<void>>()
  const allocationCleanupFailures: unknown[] = []
  let disposeTask: Promise<void> | undefined

  const send = (event: DesktopTerminalEvent): void => {
    if (!disposed) onEvent(event)
  }

  const removeRecord = (entry: TerminalRecord): void => {
    if (terminals.get(entry.id) !== entry) return
    terminals.delete(entry.id)
    entry.dataSubscription?.dispose()
    entry.exitSubscription?.dispose()
  }

  const closeRecord = (entry: TerminalRecord): Promise<void> => {
    const pending = closing.get(entry.id)
    if (pending) return pending
    const task = Promise.resolve()
      .then(() => entry.process.kill())
      .then(() => {
        removeRecord(entry)
      })
    closing.set(entry.id, task)
    void task.then(
      () => closing.delete(entry.id),
      () => closing.delete(entry.id),
    )
    return task
  }

  const ownedTerminal = (ownerId: number, idInput: unknown): TerminalRecord => {
    const id = terminalId(idInput)
    const entry = terminals.get(id)
    if (entry === undefined || entry.ownerId !== ownerId) {
      throw new Error('终端不存在或不属于当前窗口')
    }
    return entry
  }

  const createOne = async (
    ownerId: number,
    input: unknown,
    task?: ProjectTaskLaunch,
  ): Promise<DesktopTerminalDescriptor> => {
    if (disposed) throw new Error('终端控制器已经关闭')
    if (terminals.size + pendingCreates >= DESKTOP_TERMINAL_LIMITS.maxTerminals) {
      throw new Error(`一个窗口最多同时打开 ${String(DESKTOP_TERMINAL_LIMITS.maxTerminals)} 个终端`)
    }
    const request = parseCreateRequest(input)
    pendingCreates += 1
    let reservedTaskId: string | undefined
    let processHandle: TerminalProcess | undefined
    let registered = false
    try {
      let launch: ResolvedTerminalLaunch
      if (request.taskId === undefined) {
        const shell = resolveShell()
        launch = {
          kind: 'shell',
          // 标签去掉 Windows 可执行扩展名，与 POSIX 下的 `zsh` 保持同样形态。
          title: basename(shell.executable).replace(/\.exe$/i, ''),
          executable: shell.executable,
          args: shell.args,
          cwd: resolveProjectDirectory(request.projectId),
          env: terminalEnvironment(),
        }
      } else {
        if (!task || task.taskId !== request.taskId) throw new Error('项目任务尚未由桌面确认')
        launch = {
          kind: 'task',
          title: task.name,
          taskId: task.taskId,
          allowConcurrent: task.allowConcurrent,
          executable: task.executable,
          args: task.args,
          cwd: task.cwd,
          env: terminalEnvironment(task.env),
        }
      }
      if (launch.kind === 'task' && launch.allowConcurrent !== true) {
        if (
          pendingTaskIds.has(launch.taskId) ||
          [...terminals.values()].some(entry => entry.taskId === launch.taskId)
        ) {
          throw new Error('该项目任务已经在终端中运行')
        }
        reservedTaskId = launch.taskId
        pendingTaskIds.add(reservedTaskId)
      }
      processHandle = await processFactory({
        executable: launch.executable,
        args: launch.args,
        cwd: launch.cwd,
        env: launch.env,
        columns: request.columns,
        rows: request.rows,
      })
      if (disposed) throw new Error('终端窗口已经关闭')
      const id = randomUUID()
      const entry: TerminalRecord = {
        id,
        ownerId,
        process: processHandle,
        ...(launch.kind === 'task' ? { taskId: launch.taskId } : {}),
        attached: false,
        pendingOutput: '',
      }
      terminals.set(id, entry)
      registered = true
      entry.dataSubscription = processHandle.onData(data => {
        if (terminals.get(id) !== entry) return
        if (entry.attached) {
          send({ type: 'data', terminalId: id, data })
          return
        }
        entry.pendingOutput = `${entry.pendingOutput}${data}`.slice(
          -DESKTOP_TERMINAL_LIMITS.maxPendingOutputCharacters,
        )
      })
      entry.exitSubscription = processHandle.onExit(exit => {
        if (terminals.get(id) !== entry) return
        entry.dataSubscription?.dispose()
        delete entry.dataSubscription
        entry.exitEvent = {
          type: 'exit',
          terminalId: id,
          exitCode: exit.exitCode,
          ...(exit.signal === undefined ? {} : { signal: exit.signal }),
        }
        if (entry.attached) {
          send(entry.exitEvent)
          removeRecord(entry)
        }
      })
      const descriptor: DesktopTerminalDescriptor = {
        id,
        pid: processHandle.pid,
        kind: launch.kind,
        title: launch.title,
        ...(launch.kind === 'task' ? { taskId: launch.taskId } : {}),
      }
      return descriptor
    } catch (error) {
      if (processHandle !== undefined && !registered) {
        try {
          await processHandle.kill()
        } catch (cleanupError) {
          allocationCleanupFailures.push(cleanupError)
          // oxlint-disable-next-line preserve-caught-error -- 两个错误都保留在 errors，cause 另行记录清理失败。
          throw new AggregateError([error, cleanupError], '终端分配失败且清理未完成', {
            cause: cleanupError,
          })
        }
      }
      throw error
    } finally {
      pendingCreates -= 1
      if (reservedTaskId !== undefined) pendingTaskIds.delete(reservedTaskId)
    }
  }

  const create = (
    ownerId: number,
    input: unknown,
    task?: ProjectTaskLaunch,
  ): Promise<DesktopTerminalDescriptor> => {
    const pending = createOne(ownerId, input, task)
    creating.add(pending)
    void pending.then(
      () => creating.delete(pending),
      () => creating.delete(pending),
    )
    return pending
  }

  const ready = (ownerId: number, idInput: unknown): void => {
    const entry = ownedTerminal(ownerId, idInput)
    if (entry.attached) return
    entry.attached = true
    if (entry.pendingOutput !== '') {
      send({ type: 'data', terminalId: entry.id, data: entry.pendingOutput })
      entry.pendingOutput = ''
    }
    if (entry.exitEvent !== undefined) {
      send(entry.exitEvent)
      removeRecord(entry)
    }
  }

  const write = (ownerId: number, idInput: unknown, input: unknown): void | Promise<void> => {
    const entry = ownedTerminal(ownerId, idInput)
    return entry.process.write(parseInput(input))
  }

  const resize = (
    ownerId: number,
    idInput: unknown,
    columnsInput: unknown,
    rowsInput: unknown,
  ): void | Promise<void> => {
    const entry = ownedTerminal(ownerId, idInput)
    const columns = boundedInteger(
      columnsInput,
      '终端列数',
      DESKTOP_TERMINAL_LIMITS.minColumns,
      DESKTOP_TERMINAL_LIMITS.maxColumns,
    )
    const rows = boundedInteger(
      rowsInput,
      '终端行数',
      DESKTOP_TERMINAL_LIMITS.minRows,
      DESKTOP_TERMINAL_LIMITS.maxRows,
    )
    return entry.process.resize(columns, rows)
  }

  const close = (ownerId: number, idInput: unknown): Promise<void> => {
    return closeRecord(ownedTerminal(ownerId, idInput))
  }

  const dispose = (): Promise<void> => {
    if (disposeTask) return disposeTask
    disposed = true
    disposeTask = (async () => {
      const cleanup = [...terminals.values()].map(closeRecord)
      // 分配中的 PTY 在发布前复核 disposed，自行等待清理，不能遗落在退出之后。
      await Promise.allSettled(creating)
      const results = await Promise.allSettled([...cleanup, ...closing.values()])
      const failures = results
        .filter(result => result.status === 'rejected')
        .map(result => result.reason as unknown)
      failures.push(...allocationCleanupFailures)
      if (failures.length) throw new AggregateError(failures, '终端进程清理失败')
    })()
    return disposeTask
  }

  return { create, ready, write, resize, close, dispose }
}
