/**
 * 运行时规范路径解析：统一消除 Windows 8.3 短文件名，同时兼容 `.asar` 归档内部虚拟路径。
 * 运行在后台 Runtime 与构建期工具进程；无持久状态或外部句柄。
 */
import * as nodeFs from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'

const requireModule = createRequire(import.meta.url)
// Electron 环境取未包装的 original-fs，避免 .asar 归档文件在 realpathSync.native 下被虚拟目录层拦截。
const physicalRealpathNative = (process.versions.electron ? requireModule('original-fs') : nodeFs)
  .realpathSync.native
const ASAR_SEGMENT_PATTERN = /^(.+?\.asar)(?:[\\/](.+))?$/iu

function resolveExistingPrefix(targetPath) {
  const tail = []
  let current = resolve(targetPath)
  for (;;) {
    try {
      return resolve(physicalRealpathNative(current), ...tail)
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error?.code) || dirname(current) === current) {
        throw error
      }
      tail.unshift(basename(current))
      current = dirname(current)
    }
  }
}

/**
 * 将本地磁盘路径或 `.asar` 内部路径转换为长路径规范形式。
 * libuv 的 `realpathSync.native` 不识别 `.asar` 虚拟目录，需先对真实归档文件取规范路径再拼接内部子路径。
 * @param {string} targetPath 输入路径。
 * @returns {string} 规范化后的绝对路径。
 */
export function canonicalRuntimePath(targetPath) {
  const resolved = resolve(targetPath)
  const asarMatch = ASAR_SEGMENT_PATTERN.exec(resolved)
  if (asarMatch) {
    const archivePath = resolveExistingPrefix(asarMatch[1])
    return asarMatch[2] ? join(archivePath, asarMatch[2]) : archivePath
  }
  return resolveExistingPrefix(resolved)
}
