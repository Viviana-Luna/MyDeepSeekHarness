import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { TerminalProcessFactory } from './terminal-service.ts'

/** 桌面保留标签和窗口归属，PTY 与进程树的寿命交给 DSH 子进程服务。 */
export function managedTerminalFactory(
  subprocess: Pick<SubprocessRuntime, 'spawnTerminal'>,
): TerminalProcessFactory {
  return async options => {
    const handle = await subprocess.spawnTerminal({
      argv: [options.executable, ...options.args],
      cwd: options.cwd,
      env: options.env,
      rows: options.rows,
      cols: options.columns,
      terminalType: 'xterm-256color',
      graceMs: 1_000,
    })
    handle.output.setEncoding('utf8')
    return {
      pid: handle.pid,
      onData(listener) {
        handle.output.on('data', listener)
        return {
          dispose() {
            handle.output.off('data', listener)
          },
        }
      },
      onExit(listener) {
        let active = true
        void handle.done.then(
          outcome => {
            if (active) listener({ exitCode: outcome.exitCode ?? 1 })
          },
          () => {
            if (active) listener({ exitCode: 1 })
          },
        )
        return {
          dispose() {
            active = false
          },
        }
      },
      write: data => handle.write(data),
      resize: (columns, rows) => handle.resize(columns, rows),
      kill: () => handle.terminate(),
    }
  }
}
