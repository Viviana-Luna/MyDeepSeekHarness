/** MyDSH 只在内部 Node 子进程入口注入 Electron 的 Node 模式，后台自身仍是 utilityProcess。 */
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { privateProcessSpec } from './private-files.mjs'

const quotePowerShellArgument = value => "'" + value.replaceAll("'", "''") + "'"

export function internalNodeSpec(spec, executable, entries) {
  if (
    !executable ||
    !entries.some(entry => spec.argv[1] && resolve(spec.argv[1]) === resolve(entry))
  )
    return spec
  if (![process.execPath, executable].some(entry => resolve(spec.argv[0]) === resolve(entry)))
    return spec
  return {
    ...spec,
    argv: [executable, ...spec.argv.slice(1)],
    env: { ...spec.env, ELECTRON_RUN_AS_NODE: '1' },
  }
}

export class MydshSubprocessRuntime extends LocalSubprocessRuntime {
  privateDirectory = process.env.MYDSH_HOME ? resolve(process.env.MYDSH_HOME, 'config') : undefined
  prepareLaunch(spec) {
    return this.privateDirectory ? privateProcessSpec(spec, this.privateDirectory) : spec
  }
  nodeSpec(spec) {
    return internalNodeSpec(spec, process.env.MYDSH_NODE_EXECUTABLE, [
      fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-sandbox-windows-acl/runner')),
    ])
  }
  spawn(spec) {
    return super.spawn(this.nodeSpec(spec))
  }
  spawnTerminal(spec) {
    const prepared = this.nodeSpec(spec)
    if (process.platform !== 'win32' || prepared === spec) return super.spawnTerminal(prepared)
    const shell = process.env.MYDSH_PWSH_EXECUTABLE
    if (!shell) throw new Error('内部终端缺少随包 PowerShell 控制台宿主')
    // Electron 是 GUI 可执行文件；控制台宿主先连接 ConPTY，避免 ACL runner 启动前管道关闭。
    // 逐参数作为 PowerShell 单引号字面量传递，Node 模式仅属于这棵内部进程树。
    const program =
      "$ErrorActionPreference='Stop'; & " +
      prepared.argv.map(quotePowerShellArgument).join(' ') +
      '; exit $LASTEXITCODE'
    return super.spawnTerminal({
      ...prepared,
      argv: [
        shell,
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(program, 'utf16le').toString('base64'),
      ],
    })
  }
}
