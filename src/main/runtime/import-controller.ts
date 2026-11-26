import { homedir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  commitDshImport,
  importDshCredentials,
  previewDshImport,
  type SessionImportCatalog,
} from '../../runtime/import/dsh-import.ts'
import type { MydshRuntimeSupervisor } from './runtime-supervisor.ts'

interface ImportState {
  closing: boolean
  controller?: AbortController
  active?: Promise<unknown>
}
const states = new WeakMap<MydshRuntimeSupervisor, ImportState>()
function stateFor(runtime: MydshRuntimeSupervisor): ImportState {
  let state = states.get(runtime)
  if (!state) {
    state = { closing: false }
    states.set(runtime, state)
  }
  return state
}

/** 主进程退出时先取消并等待导入，避免 data 原子替换和 Runtime 重启发生在退出之后。 */
export async function shutdownImportController(runtime: MydshRuntimeSupervisor): Promise<void> {
  const state = stateFor(runtime)
  state.closing = true
  state.controller?.abort(new Error('应用正在退出，已取消导入'))
  await state.active?.catch(() => {})
}

/** 导入只由经过发送方校验的设置页触发，不注册为 Agent Remote 或工具。 */
export async function callImportController(
  runtime: MydshRuntimeSupervisor,
  operation: string,
  payload: Record<string, unknown>,
  documentEdited: boolean,
): Promise<unknown> {
  const state = stateFor(runtime)
  if (state.closing) throw new Error('应用正在退出，不能开始导入')
  if (state.active) throw new Error('已有数据导入操作正在进行，请等待完成')
  const controller = new AbortController()
  state.controller = controller
  const active = performImport(
    runtime,
    operation,
    payload,
    documentEdited,
    controller.signal,
    state,
  )
  state.active = active
  try {
    return await active
  } finally {
    delete state.active
    delete state.controller
  }
}

async function performImport(
  runtime: MydshRuntimeSupervisor,
  operation: string,
  payload: Record<string, unknown>,
  documentEdited: boolean,
  signal: AbortSignal,
  state: ImportState,
): Promise<unknown> {
  const installation = runtime.installed
  if (!installation) throw new Error('运行核心尚未安装')
  const sourceInput = payload.sourceHome
  if (typeof sourceInput !== 'string') throw new Error('请选择 DSH 数据目录')
  const sourceHome = sourceInput === '~/.dsh' ? join(homedir(), '.dsh') : sourceInput
  if (!isAbsolute(sourceHome)) throw new Error('数据来源必须是绝对路径')
  if (operation === 'mydshImport.credentials') {
    if (
      !Array.isArray(payload.names) ||
      payload.names.length > 256 ||
      !payload.names.every(
        name => typeof name === 'string' && name.length <= 247 && /^(ref|record):/.test(name),
      )
    )
      throw new Error('凭据选择无效')
    // 导入与运行核心共用 DSH 文件提供方；它的文件锁和重载机制协调两边写入。
    const moduleUrl = (name: string) =>
      pathToFileURL(join(installation.runtimeDirectory, 'node_modules', name, 'lib/index.js')).href
    const { Context } = await import(moduleUrl('@deepseek-ai/cordis'))
    const { LocalCredentialProvider } = await import(
      moduleUrl('@deepseek-ai/dsh-credentials-local')
    )
    const { credentialRef, parseCredentialKey } = await import(
      moduleUrl('@deepseek-ai/dsh-credentials')
    )
    const ctx = new Context()
    try {
      await ctx
        .plugin(LocalCredentialProvider, {
          path: join(installation.mydshHome, 'config/credentials.yaml'),
          watch: false,
        })
        .await()
      return await importDshCredentials({
        sourceHome,
        names: payload.names as string[],
        writeCredential: async entry => {
          signal.throwIfAborted()
          const key = entry.name.replace(/^(ref|record):/, '')
          if (entry.name.startsWith('ref:'))
            await ctx.credentials.set(credentialRef(key), entry.value)
          else await ctx.credentials.modifyRecord(parseCredentialKey(key), () => entry.value)
        },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  }
  const formatModule = (await import(
    pathToFileURL(
      join(
        installation.runtimeDirectory,
        'node_modules/@deepseek-ai/dsh-session-format-catalog/lib/index.js',
      ),
    ).href
  )) as { sessionFormatCatalog: SessionImportCatalog }
  const options = {
    sourceHome,
    mydshHome: installation.mydshHome,
    sessionFormat: formatModule.sessionFormatCatalog,
    signal,
  }
  if (operation === 'mydshImport.preview') return previewDshImport(options)
  if (operation !== 'mydshImport.commit') throw new Error('未知的数据导入操作')
  if (documentEdited) throw new Error('请先保存或放弃未保存的文件，再导入数据')
  if (
    typeof payload.expectedFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(payload.expectedFingerprint)
  )
    throw new Error('请先预览待导入数据')
  const status = (await runtime.call('mydshRuntime/status', {}, signal)) as {
    ok: boolean
    value?: { busy: boolean }
  }
  if (!status.ok || status.value?.busy) throw new Error('请等待运行中的 Agent 任务结束，再导入数据')
  signal.throwIfAborted()
  await runtime.stop()
  try {
    return await commitDshImport({ ...options, expectedFingerprint: payload.expectedFingerprint })
  } finally {
    if (!state.closing) await runtime.retry()
  }
}
