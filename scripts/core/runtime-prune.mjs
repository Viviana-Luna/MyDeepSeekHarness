/**
 * 离线核心构建收尾裁剪与 ASAR 封装：剔除原生调试符号、源码映射与跨架构预编译产物，
 * 并将纯 JS 模块流式封入单个 `runtime.asar`，仅把原生二进制与插件转换类型包解包落盘。
 * 运行在构建脚本进程；仅操作传入的临时构建目录与目标制品目录。
 */
/* oxlint-disable no-await-in-loop -- 目录裁剪需先递归子项再判断是否移除空目录。 */
import { createPackageFromStreams } from '@electron/asar'
import { createReadStream } from 'node:fs'
import { lstat, readdir, rm } from 'node:fs/promises'
import { basename, join, relative } from 'node:path'

const DEAD_ARTIFACT_EXTENSION =
  /\.(?:pdb|ipdb|iobj|obj|ilk|exp|lib|map|cc|cpp|cxx|c|h|hpp|gyp|gypi)$/iu

const NATIVE_UNPACK_EXTENSION = /\.(?:node|dll|exe|dylib|so)$/iu

const STRIPPABLE_PACKAGE_SUBDIRS = new Set([
  'test',
  'tests',
  '__tests__',
  'docs',
  'example',
  'examples',
  'benchmark',
])

/** 插件转换器与 `tsc` 类型分析所需保留 `.d.ts` 的依赖集合。 */
const TYPECHECK_CLOSURE_PACKAGES = new Set([
  'typescript',
  '@types/node',
  '@types/react',
  '@types/react-dom',
  'csstype',
  'undici-types',
  '@mydsh/sdk',
  '@mydsh/ui',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-typert-protocol',
  '@deepseek-ai/dsh-typert-registry',
  '@deepseek-ai/dsh-typert-generator',
  'react',
  'react-dom',
])

/** 需在 `runtime.asar.unpacked` 保持真实文件系统目录以供外部进程、NTFS 联接或 `tsc` 直接读取的前缀。 */
const UNPACKED_DIRECTORY_PREFIXES = [
  'node_modules/typescript',
  'node_modules/esbuild',
  'node_modules/@esbuild/',
  'node_modules/@vscode/',
  'node_modules/node-pty',
  'node_modules/@mydsh/desktop-services/node_modules/node-pty',
  'node_modules/react',
  'node_modules/react-dom',
  'node_modules/csstype',
  'node_modules/undici-types',
  'node_modules/@types/',
  'node_modules/@mydsh/sdk',
  'node_modules/@mydsh/ui',
  'node_modules/@mydsh/cli-bridge/skills',
  'node_modules/@deepseek-ai/cordis',
  'node_modules/@deepseek-ai/dsh-typert-protocol',
  'node_modules/@deepseek-ai/dsh-typert-registry',
  'node_modules/@deepseek-ai/dsh-agent-presets/presets',
]

function toPosixPath(value) {
  return value.replaceAll('\\', '/')
}

function resolveNodeModulePackage(posixRelativePath) {
  const marker = 'node_modules/'
  const lastIndex = posixRelativePath.lastIndexOf(marker)
  if (lastIndex < 0) return { packageName: null, innerPath: posixRelativePath }
  const rest = posixRelativePath.slice(lastIndex + marker.length).split('/')
  if (rest[0]?.startsWith('@') && rest.length >= 2) {
    return { packageName: `${rest[0]}/${rest[1]}`, innerPath: rest.slice(2).join('/') }
  }
  return { packageName: rest[0] ?? null, innerPath: rest.slice(1).join('/') }
}

function isForeignPrebuildDirectory(posixRelativePath) {
  const targetPlatformArch = `${process.platform}-${process.arch}`
  const prebuildMatch = /(?:^|\/)prebuilds\/([^/]+)$/u.exec(posixRelativePath)
  if (prebuildMatch && prebuildMatch[1] !== targetPlatformArch) return true
  const conptyMatch = /(?:^|\/)third_party\/conpty\/[^/]+\/(win10-[^/]+)$/u.exec(posixRelativePath)
  if (conptyMatch && conptyMatch[1] !== `win10-${process.arch}`) return true
  return false
}

function shouldDropThirdPartyDirectory(packageName, innerPath) {
  if (!packageName || packageName === 'koffi') return false
  if (packageName.startsWith('@mydsh/') || packageName.startsWith('@deepseek-ai/')) return false
  return STRIPPABLE_PACKAGE_SUBDIRS.has(innerPath)
}

function shouldDropNodeModuleFile(posixRelativePath, fileName) {
  if (/^(?:LICENSE|NOTICE|COPYING)(?:\..+)?$/iu.test(fileName) || fileName === 'package.json') {
    return false
  }
  if (fileName === 'binding.gyp' || DEAD_ARTIFACT_EXTENSION.test(fileName)) return true
  const { packageName } = resolveNodeModulePackage(posixRelativePath)
  if (
    packageName &&
    !TYPECHECK_CLOSURE_PACKAGES.has(packageName) &&
    /\.[cm]?ts$/iu.test(fileName)
  ) {
    return true
  }
  return false
}

async function pruneDirectory(stagingRoot, currentDir) {
  const entries = await readdir(currentDir, { withFileTypes: true })
  let remaining = 0
  for (const entry of entries) {
    const fullPath = join(currentDir, entry.name)
    const posixPath = toPosixPath(relative(stagingRoot, fullPath))
    if (entry.isDirectory()) {
      const { packageName, innerPath } = resolveNodeModulePackage(posixPath)
      if (
        isForeignPrebuildDirectory(posixPath) ||
        shouldDropThirdPartyDirectory(packageName, innerPath)
      ) {
        await rm(fullPath, { recursive: true, force: true })
        continue
      }
      const childRemaining = await pruneDirectory(stagingRoot, fullPath)
      if (childRemaining === 0) await rm(fullPath, { recursive: true, force: true })
      else remaining += 1
      continue
    }
    if (posixPath.startsWith('node_modules/') && shouldDropNodeModuleFile(posixPath, entry.name)) {
      await rm(fullPath, { force: true })
      continue
    }
    remaining += 1
  }
  return remaining
}

function shouldUnpackPath(posixRelativePath) {
  if (
    posixRelativePath === 'package.json' ||
    posixRelativePath === 'plugin-typert.js' ||
    posixRelativePath === 'canonical-path.mjs'
  ) {
    return true
  }
  const name = basename(posixRelativePath)
  if (NATIVE_UNPACK_EXTENSION.test(name) || name === 'spawn-helper') return true
  return UNPACKED_DIRECTORY_PREFIXES.some(prefix =>
    prefix.endsWith('/')
      ? posixRelativePath.startsWith(prefix)
      : posixRelativePath === prefix || posixRelativePath.startsWith(`${prefix}/`),
  )
}

async function collectAsarEntries(stagingRoot, currentDir, streams) {
  const entries = (await readdir(currentDir, { withFileTypes: true })).toSorted((a, b) =>
    a.name.localeCompare(b.name),
  )
  for (const entry of entries) {
    const fullPath = join(currentDir, entry.name)
    const posixPath = toPosixPath(relative(stagingRoot, fullPath))
    const info = await lstat(fullPath)
    const unpacked = shouldUnpackPath(posixPath)
    if (info.isDirectory()) {
      streams.push({ path: posixPath, type: 'directory', unpacked })
      await collectAsarEntries(stagingRoot, fullPath, streams)
      continue
    }
    if (!info.isFile()) throw new Error(`离线核心构建目录包含非常规文件或符号链接：${posixPath}`)
    streams.push({
      path: posixPath,
      type: 'file',
      unpacked,
      stat: info,
      streamGenerator: () => createReadStream(fullPath),
    })
  }
}

/**
 * 裁剪暂存运行时的调试符号、源码映射、跨平台预编译文件与冗余类型文件，保留所有许可证与 `package.json`。
 * @param {string} stagingRoot 暂存构建根目录。
 */
export async function pruneRuntimeStaging(stagingRoot) {
  await pruneDirectory(stagingRoot, join(stagingRoot, 'node_modules'))
}

/**
 * 将裁剪后的暂存目录封装为 `runtime.asar` 与配套 `runtime.asar.unpacked`。
 * 使用流式接口显式控制解包标记，避免 Windows 反斜杠在 glob/minimatch 中产生转义漏匹配。
 * @param {string} stagingRoot 暂存构建根目录。
 * @param {string} asarDestination 目标 `.asar` 文件绝对路径。
 */
export async function packRuntimeAsar(stagingRoot, asarDestination) {
  const streams = []
  await collectAsarEntries(stagingRoot, stagingRoot, streams)
  await createPackageFromStreams(asarDestination, streams)
}
