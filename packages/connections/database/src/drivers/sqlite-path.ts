/** SQLite 本地文件路径安全校验：禁止 URI、相对路径、临时日志文件和 MyDSH 内部私有目录。 */
import { constants } from 'node:fs'
import { access, lstat, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const MAX_SQLITE_PATH_LENGTH = 4096

function normalizeCaseForPlatform(path: string): string {
  return process.platform === 'win32' || process.platform === 'darwin' ? path.toLowerCase() : path
}

function isWithinDirectory(root: string, candidate: string): boolean {
  const normalizedRoot = normalizeCaseForPlatform(root)
  const normalizedCandidate = normalizeCaseForPlatform(candidate)
  const part = relative(normalizedRoot, normalizedCandidate)
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`))
}

async function resolveProtectedRoots(): Promise<string[]> {
  const rawRoots = [process.env.MYDSH_HOME, join(homedir(), '.mydsh')].filter(
    (item): item is string => typeof item === 'string' && item.trim().length > 0,
  )
  const roots = new Set<string>()
  for (const item of rawRoots) {
    roots.add(resolve(item))
    try {
      roots.add(await realpath(item))
    } catch {
      // 目录尚未创建时保留解析后的绝对路径，阻止软链或未来目录越界访问。
    }
  }
  return [...roots]
}

/**
 * 校验本地 SQLite 数据库文件路径是否安全可读或可写。
 * 拒绝非绝对路径、URI/内存库、WAL/SHM 临时文件、特殊设备及 MyDSH 私有配置/会话目录。
 * @throws 路径无效、指向 MyDSH 内部数据或权限不足时抛出。
 */
export async function validateSqliteFilePath(
  rawPath: unknown,
  options: { writable?: boolean } = {},
): Promise<string> {
  if (typeof rawPath !== 'string' || !rawPath.trim())
    throw new Error('请选择有效的 SQLite 数据库文件')
  if (rawPath.length > MAX_SQLITE_PATH_LENGTH || /[\u0000-\u001f]/u.test(rawPath))
    throw new Error('SQLite 文件路径包含无效控制字符或超过长度限制')
  if (/^file:/iu.test(rawPath) || rawPath.trim() === ':memory:')
    throw new Error('SQLite 仅支持本地磁盘文件路径，不支持 URI 或内存数据库')
  if (process.platform === 'win32' && /^(?:\\\\|\/\/)/u.test(rawPath))
    throw new Error('SQLite 仅支持本地磁盘文件路径，不支持网络 UNC 路径')
  if (!isAbsolute(rawPath)) throw new Error('SQLite 数据库路径必须是绝对路径')
  if (/(?:-wal|-shm|-journal)$/iu.test(rawPath))
    throw new Error('请选择 SQLite 主数据库文件，不能选择 -wal、-shm 或 -journal 临时文件')

  const normalized = resolve(rawPath)
  const protectedRoots = await resolveProtectedRoots()
  if (protectedRoots.some(root => isWithinDirectory(root, normalized)))
    throw new Error('禁止访问 MyDSH 内部数据或配置目录中的数据库文件')

  let linkStat
  try {
    linkStat = await lstat(normalized)
  } catch {
    throw new Error('指定的 SQLite 数据库文件不存在或无法访问')
  }
  const canonical = await realpath(normalized)
  if (protectedRoots.some(root => isWithinDirectory(root, canonical)))
    throw new Error('禁止通过符号链接访问 MyDSH 内部数据或配置目录')
  if (/(?:-wal|-shm|-journal)$/iu.test(canonical))
    throw new Error('请选择 SQLite 主数据库文件，不能指向临时日志文件')

  const fileStat = linkStat.isSymbolicLink() ? await stat(canonical) : linkStat
  if (!fileStat.isFile()) throw new Error('SQLite 路径必须指向普通文件，不能是目录或设备文件')

  try {
    const mode = options.writable ? constants.R_OK | constants.W_OK : constants.R_OK
    await access(canonical, mode)
    if (options.writable) await access(dirname(canonical), constants.W_OK)
  } catch {
    throw new Error(
      options.writable
        ? '没有该 SQLite 文件或其所在目录的读写权限'
        : '没有读取该 SQLite 文件的权限',
    )
  }
  return canonical
}
