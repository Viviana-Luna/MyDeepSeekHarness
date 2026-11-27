/**
 * macOS DMG 构建与 hdiutil 瞬态重试工具：运行在打包与验收 Node 脚本进程中。
 * 针对 macOS CI 环境中 Spotlight 与 diskimages-helper 偶发争用卷挂载导致的
 * `Resource busy` / `temporarily unavailable` 错误提供有界退避重试；
 * `createMacosDmg` 拥有本次构建创建的临时暂存目录与半成品 `.dmg` 文件，并在退出前统一清理。
 */
import { execFile, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const HDIUTIL_BINARY = '/usr/bin/hdiutil'
const DITTO_BINARY = '/usr/bin/ditto'
// 允许 hdiutil 在冗余日志模式下输出较大缓冲，避免误触发 ENOBUFS。
const HDIUTIL_MAX_BUFFER = 10 * 1024 * 1024
const TRANSIENT_HDIUTIL_PATTERN = /resource busy|temporarily unavailable/iu

/**
 * 默认的 hdiutil 瞬态重试退避间隔（毫秒）：共 5 次尝试（首次执行 + 4 次递增重试，总等待 13s）。
 * 间隔覆盖 macOS Spotlight / diskimages-helper 释放卷锁的常见窗口，同时避免长时间阻塞 CI。
 */
export const DEFAULT_HDIUTIL_RETRY_DELAYS_MS = [1000, 2000, 4000, 6000]

/**
 * 将子进程输出归一为去除首尾空白的 UTF-8 文本。
 * @param {unknown} output 子进程返回的 stdout 或 stderr。
 * @returns {string}
 */
function decodeProcessOutput(output) {
  if (typeof output === 'string') return output.trim()
  if (Buffer.isBuffer(output)) return output.toString('utf8').trim()
  return ''
}

/**
 * 收集异常中可用于识别瞬态错误的全部文本字段。
 * @param {unknown} error 命令抛出的异常对象。
 * @returns {string[]}
 */
function collectErrorTexts(error) {
  if (error === null || error === undefined) return []
  if (typeof error === 'string') return [error.trim()].filter(Boolean)
  if (typeof error !== 'object') return [String(error).trim()].filter(Boolean)
  return [
    decodeProcessOutput(error.stderr),
    decodeProcessOutput(error.stdout),
    typeof error.message === 'string' ? error.message.trim() : '',
  ].filter(Boolean)
}

/**
 * 提取 hdiutil 异常中最具诊断价值的原始错误文本。
 * 优先保留原始 stderr，缺失时回退至 stdout 或异常 message。
 * @param {unknown} error 命令抛出的异常对象。
 * @returns {string} 可直接写入日志或外层错误信息的诊断文本。
 */
export function formatHdiutilErrorDetail(error) {
  if (error === null || error === undefined) return '未知错误'
  if (typeof error === 'string') return error.trim() || '未知错误'
  if (typeof error !== 'object') return String(error)
  const stderr = decodeProcessOutput(error.stderr)
  if (stderr !== '') return stderr
  const stdout = decodeProcessOutput(error.stdout)
  if (stdout !== '') return stdout
  const message = typeof error.message === 'string' ? error.message.trim() : ''
  return message || '未知错误'
}

/**
 * 判断 hdiutil 失败是否属于 macOS 卷挂载争用引发的明确瞬态错误。
 * 仅在命中 `Resource busy`、`temporarily unavailable` 或 `EBUSY`/`EAGAIN` 时返回 true，
 * 避免对镜像损坏、参数错误或权限拒绝等非瞬态错误做无意义重试。
 * @param {unknown} error 命令抛出的异常对象。
 * @returns {boolean}
 */
export function isTransientHdiutilError(error) {
  if (error !== null && typeof error === 'object') {
    if (error.code === 'EBUSY' || error.code === 'EAGAIN') return true
  }
  return TRANSIENT_HDIUTIL_PATTERN.test(collectErrorTexts(error).join('\n'))
}

/**
 * 默认的 hdiutil 命令执行器，捕获 stdout/stderr 以便检测瞬态错误。
 * @param {string[]} args 传给 `/usr/bin/hdiutil` 的参数列表。
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
async function defaultRunHdiutil(args) {
  const result = await execFileAsync(HDIUTIL_BINARY, args, {
    encoding: 'utf8',
    maxBuffer: HDIUTIL_MAX_BUFFER,
  })
  return {
    stdout: decodeProcessOutput(result.stdout),
    stderr: decodeProcessOutput(result.stderr),
  }
}

/**
 * 默认的重试告警输出，便于在 CI 日志中追踪瞬态争用与退避等待。
 * @param {{ args: string[], attempt: number, maxAttempts: number, delayMs: number, detail: string }} event
 */
function defaultOnRetry({ args, attempt, maxAttempts, delayMs, detail }) {
  const action = args[0] ?? '操作'
  console.warn(
    `hdiutil ${action} 遇到瞬态繁忙错误（第 ${String(attempt)}/${String(maxAttempts)} 次尝试失败），${String(delayMs)}ms 后重试：${detail}`,
  )
}

/**
 * 使用 macOS 原生 ditto 拷贝应用包，保留资源分支、符号链接与代码签名结构。
 * @param {string} applicationPath 源 `.app` 路径。
 * @param {string} targetApplicationPath 临时卷目录内的目标 `.app` 路径。
 */
function defaultCopyApplication(applicationPath, targetApplicationPath) {
  execFileSync(DITTO_BINARY, [applicationPath, targetApplicationPath], { stdio: 'inherit' })
}

/**
 * 在 DMG 卷根目录创建指向 `/Applications` 的拖拽安装符号链接。
 * @param {string} linkPath 符号链接路径。
 */
function defaultCreateApplicationsLink(linkPath) {
  symlinkSync('/Applications', linkPath)
}

/**
 * 带明确瞬态错误检测与有界递增退避的 `/usr/bin/hdiutil` 执行器。
 * 仅对 `isTransientHdiutilError` 判定的瞬态错误重试；非瞬态错误立即原样抛出。
 * 有外部进程副作用（调用 `/usr/bin/hdiutil`）；若调用方传入 `beforeRetry`，会在每次等待重试前执行清理。
 * @param {string[]} args 传给 `/usr/bin/hdiutil` 的参数数组。
 * @param {object} [options] 重试配置与可注入依赖。
 * @param {number[]} [options.retryDelaysMs] 每次重试前的退避等待毫秒数组，默认 `[1000, 2000, 4000, 6000]`（共 5 次尝试）。
 * @param {(args: string[]) => Promise<unknown> | unknown} [options.runCommand] 自定义命令执行器（用于测试注入）。
 * @param {(delayMs: number) => Promise<void>} [options.sleep] 自定义等待函数（用于测试注入）。
 * @param {(event: { args: string[], attempt: number, maxAttempts: number, delayMs: number, detail: string, error: unknown }) => Promise<void> | void} [options.beforeRetry] 每次重试前的清理回调。
 * @param {(event: { args: string[], attempt: number, maxAttempts: number, delayMs: number, detail: string, error: unknown }) => void} [options.onRetry] 每次触发重试时的通知回调。
 * @returns {Promise<unknown>} 命令成功时的返回值。
 * @throws 非瞬态错误立即原样抛出；瞬态错误耗尽全部重试后抛出包含尝试次数与原始 stderr 的中文错误（`cause` 为最后一次原始异常）。
 */
export async function runHdiutilWithRetry(args, options = {}) {
  const {
    retryDelaysMs = DEFAULT_HDIUTIL_RETRY_DELAYS_MS,
    runCommand = defaultRunHdiutil,
    sleep = delayMs => delay(delayMs),
    beforeRetry,
    onRetry = defaultOnRetry,
  } = options
  const maxAttempts = retryDelaysMs.length + 1

  async function runAttempt(attempt) {
    try {
      return await runCommand(args)
    } catch (error) {
      if (!isTransientHdiutilError(error)) throw error
      const detail = formatHdiutilErrorDetail(error)
      if (attempt >= maxAttempts) {
        const action = args[0] ?? '操作'
        throw new Error(
          `hdiutil ${action} 在 ${String(maxAttempts)} 次尝试后仍因瞬态错误失败：${detail}`,
          { cause: error },
        )
      }
      const delayMs = Math.max(0, retryDelaysMs[attempt - 1] ?? 0)
      const event = { args, attempt, maxAttempts, delayMs, detail, error }
      onRetry(event)
      // 在退避等待前立即清理残留状态（例如半成品 DMG），避免后续进程继续引用或触发已存在冲突。
      if (beforeRetry !== undefined) await beforeRetry(event)
      await sleep(delayMs)
      return runAttempt(attempt + 1)
    }
  }

  return runAttempt(1)
}

/**
 * 构建 macOS UDZO 格式 DMG 安装镜像，并在遇到 `hdiutil create` 瞬态繁忙错误时自动清理与退避重试。
 * 会在系统临时目录创建暂存卷目录，并在目标 DMG 同目录生成隐藏暂存镜像后原子重命名替换；
 * 无论成功或失败，均在 `finally` 中完整清理半成品暂存镜像与临时目录，不破坏已有的正式 DMG。
 * @param {object} options DMG 构建参数与可注入依赖。
 * @param {string} options.applicationPath 已打包好的 `.app` 目录路径。
 * @param {string} options.dmgPath 最终输出的 `.dmg` 文件路径。
 * @param {string} options.volumeName DMG 挂载卷名及 `.app` 名称前缀。
 * @param {string} [options.tempRoot] 临时卷目录的父目录，默认使用系统 `tmpdir()`。
 * @param {number[]} [options.retryDelaysMs] 重试退避毫秒数组，默认使用 `DEFAULT_HDIUTIL_RETRY_DELAYS_MS`。
 * @param {(delayMs: number) => Promise<void>} [options.sleep] 自定义等待函数（用于测试注入）。
 * @param {(event: { args: string[], attempt: number, maxAttempts: number, delayMs: number, detail: string, error: unknown }) => void} [options.onRetry] 重试回调。
 * @param {(sourcePath: string, targetPath: string) => Promise<void> | void} [options.copyApplication] 自定义应用拷贝函数（用于测试注入）。
 * @param {(linkPath: string) => void} [options.createApplicationsLink] 自定义 `/Applications` 链接创建函数（用于测试注入）。
 * @param {(args: string[]) => Promise<unknown> | unknown} [options.runHdiutil] 自定义 `hdiutil` 执行器（用于测试注入）。
 * @returns {Promise<string>} 最终生成的 DMG 文件路径。
 * @throws 拷贝应用、创建镜像或重命名失败时抛出；已有的旧版本 `dmgPath` 保持不变。
 */
export async function createMacosDmg(options) {
  const {
    applicationPath,
    dmgPath,
    volumeName,
    tempRoot = tmpdir(),
    retryDelaysMs = DEFAULT_HDIUTIL_RETRY_DELAYS_MS,
    sleep,
    onRetry,
    copyApplication = defaultCopyApplication,
    createApplicationsLink = defaultCreateApplicationsLink,
    runHdiutil,
  } = options

  const makeDirectory = dirname(dmgPath)
  mkdirSync(makeDirectory, { recursive: true })
  const temporaryDirectory = mkdtempSync(join(tempRoot, 'mydsh-dmg-'))
  // 最终重命名必须处于同一文件系统；这属于正式安装包的构建暂存，不是诊断产物。
  const candidateDmg = join(makeDirectory, `.mydsh-${randomUUID()}.dmg`)

  try {
    const volumeRoot = join(temporaryDirectory, volumeName)
    mkdirSync(volumeRoot, { recursive: true })
    await copyApplication(applicationPath, join(volumeRoot, `${volumeName}.app`))
    createApplicationsLink(join(volumeRoot, 'Applications'))

    await runHdiutilWithRetry(
      ['create', '-volname', volumeName, '-srcfolder', volumeRoot, '-format', 'UDZO', candidateDmg],
      {
        retryDelaysMs,
        sleep,
        onRetry,
        runCommand: runHdiutil,
        // 每次重试前删除可能残留的半成品临时镜像，避免下一次 hdiutil create 因目标已存在失败。
        beforeRetry: () => {
          rmSync(candidateDmg, { force: true })
        },
      },
    )

    // 镜像完整生成后才替换同版本产物，hdiutil 失败不会破坏上次可用的 DMG。
    renameSync(candidateDmg, dmgPath)
    return dmgPath
  } finally {
    rmSync(candidateDmg, { force: true })
    rmSync(temporaryDirectory, { recursive: true, force: true })
  }
}
