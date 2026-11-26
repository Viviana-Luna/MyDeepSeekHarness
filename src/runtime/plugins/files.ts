import { renameWithRetry as rename } from '../filesystem/file-operations.ts'
import { createHash, randomUUID } from 'node:crypto'
import { realpath as fsRealpath } from 'node:fs'
import { cp, lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { MYDSH_PLUGIN_VERSION, requirePluginId, type MydshPluginManifest } from './contracts.ts'

const realpath = promisify(fsRealpath.native)
const pathKey = (value: string): string =>
  process.platform === 'win32' ? value.toLowerCase() : value

export async function atomicJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, file)
  } finally {
    await rm(temporary, { force: true })
  }
}

/** 清单入口必须留在安装包内，拒绝绝对路径、父目录和符号链接逃逸。 */
export async function pluginFile(directory: string, entry: string): Promise<string> {
  if (!entry || path.isAbsolute(entry) || entry.split(/[\\/]/).includes('..'))
    throw new Error('插件入口必须是安装包内的相对路径。')
  const base = await realpath(directory)
  const target = await realpath(path.join(base, entry))
  if (!pathKey(target).startsWith(`${pathKey(base)}${path.sep}`) || !(await lstat(target)).isFile())
    throw new Error('插件入口不在安装目录内，或不是普通文件。')
  return target
}

export async function readManifest(directory: string): Promise<MydshPluginManifest> {
  const raw: unknown = JSON.parse(
    await readFile(await pluginFile(directory, 'mydsh.plugin.json'), 'utf8'),
  )
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('插件清单必须是 JSON 对象。')
  const value = raw as Record<string, unknown>
  if (typeof value.id !== 'string') throw new Error('插件清单缺少标识。')
  requirePluginId(value.id)
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 200)
    throw new Error('插件清单缺少有效名称。')
  if (typeof value.version !== 'string' || !MYDSH_PLUGIN_VERSION.test(value.version))
    throw new Error('插件版本必须使用明确的三段版本号。')
  if (value.apiVersion !== 1) throw new Error('此插件使用了不受支持的 MyDSH API 版本。')
  for (const entry of ['backend', 'frontend'] as const) {
    if (value[entry] !== undefined) {
      if (typeof value[entry] !== 'string') throw new Error('插件入口必须是字符串。')
      await pluginFile(directory, value[entry])
    }
  }
  if (!value.backend && !value.frontend) throw new Error('插件至少需要一个后台或前端入口。')
  if (value.styles !== undefined) {
    if (!Array.isArray(value.styles) || !value.styles.every(item => typeof item === 'string'))
      throw new Error('插件样式入口必须是相对路径列表。')
    for (const style of value.styles) await pluginFile(directory, style as string)
  }
  if (value.dependencies !== undefined) {
    if (
      !value.dependencies ||
      typeof value.dependencies !== 'object' ||
      Array.isArray(value.dependencies)
    )
      throw new Error('插件依赖必须是标识到版本的对象。')
    for (const [id, version] of Object.entries(value.dependencies)) {
      requirePluginId(id, true)
      if (
        id === value.id ||
        typeof version !== 'string' ||
        (version !== '*' && !MYDSH_PLUGIN_VERSION.test(version))
      )
        throw new Error('插件依赖需使用其他插件的精确版本或 *。')
    }
  }
  if (
    value.capabilities !== undefined &&
    (!Array.isArray(value.capabilities) ||
      !value.capabilities.every(item => typeof item === 'string'))
  )
    throw new Error('访问能力声明必须是字符串列表。')
  if (
    value.config !== undefined &&
    (!value.config ||
      typeof value.config !== 'object' ||
      Array.isArray(value.config) ||
      Buffer.byteLength(JSON.stringify(value.config)) > 64 * 1024)
  )
    throw new Error('插件初始配置必须是不超过 64 KiB 的 JSON 对象。')
  return {
    id: value.id,
    name: value.name,
    version: value.version,
    apiVersion: 1,
    ...(value.backend ? { backend: value.backend as string } : {}),
    ...(value.frontend ? { frontend: value.frontend as string } : {}),
    ...(value.styles ? { styles: value.styles as string[] } : {}),
    ...(value.dependencies ? { dependencies: value.dependencies as Record<string, string> } : {}),
    ...(value.config ? { config: value.config as Record<string, unknown> } : {}),
    ...(value.capabilities ? { capabilities: value.capabilities as string[] } : {}),
  }
}

/** 只复制普通文件；安装包不得把用户目录或运行核心挂进自己的版本目录。 */
export async function copyPlugin(source: string, destination: string): Promise<void> {
  await cp(source, destination, {
    recursive: true,
    errorOnExist: true,
    force: false,
    filter: async item => {
      const stat = await lstat(item)
      if (stat.isSymbolicLink())
        throw new Error(`插件安装包不能包含符号链接：${path.relative(source, item)}`)
      if (!stat.isFile() && !stat.isDirectory()) throw new Error('插件安装包包含不支持的文件类型。')
      return true
    },
  })
}

/** 校验覆盖源码和产物；验证之后修改任何文件都必须重新验证。 */
export async function directoryDigest(directory: string): Promise<string> {
  const hash = createHash('sha256')
  async function visit(current: string): Promise<void> {
    const names = (await readdir(current)).toSorted()
    for (const name of names) {
      if (name === '.git' || name === 'node_modules') continue
      const file = path.join(current, name)
      const stat = await lstat(file)
      const relative = path.relative(directory, file)
      hash.update(relative).update('\0')
      if (stat.isDirectory()) await visit(file)
      else if (stat.isFile()) hash.update(await readFile(file))
      else throw new Error('转换源码不能包含符号链接或特殊文件。')
    }
  }
  await visit(directory)
  return hash.digest('hex')
}
