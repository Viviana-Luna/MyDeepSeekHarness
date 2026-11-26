/** 后台 Git 子进程适配：读取有界输出，取消和超时等待受管进程树退出，不记录差异。 */
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { GIT_AI_COMMAND_TIMEOUT_MS } from '../../shared/git-ai.ts'

async function cleanup(child: SubprocessHandle) {
  child.terminate()
  // 等待受管范围真正退出，不能因另一个超时先删除仍被 hook 使用的索引或目录。
  await child.waitForExit()
}

/** 仅供后台构造 Git 参数；renderer 与模型不能传入命令。 */
export interface GitAiCommand {
  cwd: string
  args: string[]
  input?: string
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  accepted?: number[]
}

/** Git 执行接口，测试可注入隔离仓库适配器。 */
export type GitAiRunner = (command: GitAiCommand) => Promise<string>

/** 使用已有子进程服务；清理完成前不交还索引锁或临时文件。 */
export function createGitAiRunner(service: Pick<SubprocessRuntime, 'spawn'>): GitAiRunner {
  return async command => {
    const signal = AbortSignal.any([
      ...(command.signal ? [command.signal] : []),
      AbortSignal.timeout(GIT_AI_COMMAND_TIMEOUT_MS),
    ])
    signal.throwIfAborted()
    const env: NodeJS.ProcessEnv = {}
    // 禁止继承调用环境中改变仓库、对象库、配置或索引位置的 Git 覆盖值。
    for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) env[key] = undefined
    const child = service.spawn({
      argv: [process.env.MYDSH_GIT_EXECUTABLE ?? 'git', '--literal-pathspecs', ...command.args],
      cwd: command.cwd,
      env: { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', ...command.env },
      signal,
      graceMs: 1_000,
      stdio: {
        stdin: command.input === undefined ? 'ignore' : { data: command.input },
        stdout: { maxBytes: 8 * 1024 * 1024 },
        // Hook 与签名程序可能写出敏感信息，只排空管道，不保留正文。
        stderr: { maxBytes: 0 },
      },
    })
    try {
      const outcome = await child.done
      signal.throwIfAborted()
      const stdout = child.collected.stdout?.readFrom(0)
      if (stdout?.lossy) throw new Error('Git 输出超过安全读取上限')
      if (!(command.accepted ?? [0]).includes(outcome.exitCode ?? -1))
        throw new Error(`Git 操作失败（退出码 ${String(outcome.exitCode)}）`)
      return stdout?.text ?? ''
    } finally {
      await cleanup(child)
    }
  }
}
