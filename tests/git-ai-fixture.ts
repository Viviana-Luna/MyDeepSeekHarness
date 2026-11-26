/** 隔离 Git 仓库测试工具；所有写入位于系统临时目录，由调用用例清理。 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { GitAiRunner } from '../src/runtime/workspace/git-ai-process.ts'

/** 测试用 Git 适配器，不代替生产受管进程树的生命周期测试。 */
export const runGitAiTest: GitAiRunner = async command => {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...command.env }
  const child = execFile('git', ['--literal-pathspecs', ...command.args], {
    cwd: command.cwd,
    env,
    signal: command.signal,
    maxBuffer: 8 * 1024 * 1024,
  })
  child.stdin?.end(command.input)
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', data => {
      stdout += String(data)
    })
    child.stderr?.on('data', data => {
      stderr += String(data)
    })
    child.on('error', reject)
    child.on('close', code => {
      if ((command.accepted ?? [0]).includes(code ?? -1)) resolve(stdout)
      else reject(new Error(stderr))
    })
  })
}

/** 只为测试读取 Git 事实，避免开启隐式交互输入。 */
export const execGitTest = promisify(execFile)
