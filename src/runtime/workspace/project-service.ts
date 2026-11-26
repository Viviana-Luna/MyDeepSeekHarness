import { renameWithRetry as rename } from '../filesystem/file-operations.ts'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { realpath as fsRealpath } from 'node:fs'
import {
  chmod,
  copyFile,
  lstat,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { languageFromPath } from '../../shared/file-language.ts'
import type { WorkspaceIndexService } from './workspace-index-service.ts'
import type { ProjectCallResult } from './contracts.ts'
import {
  DESKTOP_FILE_REFERENCE_MAX_CANDIDATES,
  formatDesktopFileMention,
  type DesktopFileReferenceCandidate,
} from '../../shared/file-references.ts'
import {
  desktopImageMediaTypeFromFileName,
  detectDesktopImageMediaType,
  type DesktopImageAttachmentMediaType,
} from '../../shared/image-attachments.ts'
import { isRecord } from '../../shared/validation.ts'
import { GIT_AI_OPERATIONS } from '../../shared/git-ai.ts'

const execFileAsync = promisify(execFile)
// Windows 上普通 fs.realpath 不归一盘符和目录大小写，使用 native 变体保持真实磁盘大小写一致。
const realpath = promisify(fsRealpath.native)
const MAX_PROJECTS = 256
const MAX_DIRECTORY_ENTRIES = 1_000
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_GIT_OUTPUT_BYTES = 8 * 1024 * 1024
const MAX_DIFF_LINES = 6_000
const MAX_GIT_PATHS = 200
const MAX_COMMIT_MESSAGE_BYTES = 16 * 1024

export const PROJECT_OPERATIONS = [
  ...GIT_AI_OPERATIONS,
  'listDirectory',
  'readFile',
  'writeFile',
  'buildFileIndex',
  'queryFiles',
  'searchContent',
  'cancelContentSearch',
  'gitSummary',
  'gitDiff',
  'gitGraph',
  'gitCommit',
  'gitCommitFileDiff',
  'gitBranches',
  'gitReview',
  'gitStage',
  'gitUnstage',
  'gitCreateCommit',
  'revealInFinder',
] as const

export type ProjectOperation = (typeof PROJECT_OPERATIONS)[number]

export interface DesktopProject {
  id: string
  name: string
  cwd: string
  displayPath: string
  sessionCount: number
  lastActivity: number
}

export interface ProjectDirectoryEntry {
  name: string
  relativePath: string
  kind: 'directory' | 'file' | 'symlink'
  size?: number
}

interface ProjectFileBase {
  relativePath: string
  byteLength: number
}

export interface ProjectTextFile extends ProjectFileBase {
  kind: 'text'
  content: string
  revision: string
  lineCount: number
  language: string
}

export interface ProjectImageFile extends ProjectFileBase {
  kind: 'image'
  mediaType: DesktopImageAttachmentMediaType
  base64: string
}

export type ProjectFile = ProjectTextFile | ProjectImageFile

export type ProjectFileWriteResult =
  | {
      status: 'saved'
      file: ProjectTextFile
    }
  | {
      status: 'conflict'
      relativePath: string
      currentRevision: string
      currentByteLength: number
    }

export interface GitChangedFile {
  relativePath: string
  originalPath?: string
  indexStatus: string
  workingTreeStatus: string
  staged: boolean
  conflict: boolean
  additions: number
  deletions: number
  binary: boolean
  workingAdditions: number
  workingDeletions: number
  workingBinary: boolean
  stagedAdditions: number
  stagedDeletions: number
  stagedBinary: boolean
}

export interface GitProjectSummary {
  available: boolean
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  files: GitChangedFile[]
  additions: number
  deletions: number
  statusRevision?: string
  message?: string
}

export interface GitGraphCommit {
  hash: string
  shortHash: string
  parents: string[]
  decorations: string[]
  author: string
  time: number
  subject: string
}

export interface GitCommitDetail extends GitGraphCommit {
  files: Array<{
    relativePath: string
    originalPath?: string
    status: string
    additions: number
    deletions: number
    binary: boolean
  }>
}

export interface GitCommitFileDiff {
  relativePath: string
  commitHash: string
  mode: 'commit'
  patch: string
  truncated: boolean
  presentation: 'text' | 'binary' | 'unavailable'
  message?: string
}

interface ProjectRecord extends DesktopProject {
  realCwd: string
}

interface SessionLike {
  cwd?: unknown
  updatedAt?: unknown
}

interface SessionListLike {
  items?: unknown
}

class ProjectFileContentError extends Error {
  constructor(
    message: string,
    readonly reason: 'too-large' | 'binary' | 'encoding',
  ) {
    super(message)
  }
}

function comparePathKey(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value
}

function compactHomePath(path: string): string {
  const home = homedir()
  const pathKey = comparePathKey(path)
  const homeKey = comparePathKey(home)
  return pathKey === homeKey
    ? '~'
    : pathKey.startsWith(`${homeKey}${sep}`)
      ? `~${path.slice(home.length)}`
      : path
}

function projectId(path: string): string {
  return createHash('sha256').update(comparePathKey(path)).digest('hex').slice(0, 24)
}

function isInside(root: string, candidate: string): boolean {
  const value = relative(comparePathKey(root), comparePathKey(candidate))
  return value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value))
}

function parseRelativePath(value: unknown, allowEmpty = false): string {
  if (typeof value !== 'string' || value.includes('\0') || value.length > 4_096) {
    throw new Error('项目相对路径无效')
  }
  const normalized = value.replaceAll('\\', '/')
  if (normalized === '' && allowEmpty) return ''
  // 盘符（含驱动器相对路径 C:foo）与 UNC/POSIX 根路径均不是项目相对路径，在解析阶段一并拒绝。
  if (
    normalized === '' ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:/u.test(normalized) ||
    normalized.split('/').includes('..')
  ) {
    throw new Error('项目相对路径必须位于项目目录内')
  }
  return normalized.replace(/^\.\//u, '')
}

function parseGitPaths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_GIT_PATHS) {
    throw new Error(`Git 文件列表必须包含 1 到 ${String(MAX_GIT_PATHS)} 个项目内路径`)
  }
  return [...new Set(value.map(path => parseRelativePath(path)))]
}

function parseGitPathMutation(payload: Record<string, unknown>): { all: boolean; paths: string[] } {
  if (payload.all === true) return { all: true, paths: [] }
  if (payload.all !== undefined && payload.all !== false) throw new Error('Git 全部文件标记无效')
  return { all: false, paths: parseGitPaths(payload.relativePaths) }
}

function parseCommitMessage(value: unknown): string {
  if (typeof value !== 'string' || value.includes('\0')) throw new Error('Git 提交消息无效')
  if (value.trim() === '') throw new Error('请输入 Git 提交消息')
  if (Buffer.byteLength(value, 'utf8') > MAX_COMMIT_MESSAGE_BYTES) {
    throw new Error('Git 提交消息超过 16 KiB 上限')
  }
  return value
}

function parseProjectOperation(value: unknown): ProjectOperation {
  if (typeof value !== 'string' || !PROJECT_OPERATIONS.includes(value as ProjectOperation)) {
    throw new Error('不支持的项目操作')
  }
  return value as ProjectOperation
}

function fileRevision(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function parseFileRevision(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${label}无效`)
  }
  return value
}

function parseTextContent(value: unknown): { content: string; bytes: Buffer } {
  if (typeof value !== 'string' || value.includes('\0')) {
    throw new Error('文件内容必须是有效的 UTF-8 文本')
  }
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.byteLength > MAX_FILE_BYTES) {
    throw new Error('文件内容超过内置编辑器的 2 MiB 上限')
  }
  return { content: value, bytes }
}

async function canonicalDirectory(path: string): Promise<string | undefined> {
  if (!isAbsolute(path) || path.includes('\0')) return undefined
  try {
    const canonical = await realpath(path)
    const metadata = await stat(canonical)
    if (!metadata.isDirectory() || canonical === dirname(canonical)) return undefined
    return canonical
  } catch {
    return undefined
  }
}

async function resolveProjectPath(
  project: ProjectRecord,
  relativePathInput: unknown,
  allowRoot = false,
): Promise<{ absolutePath: string; relativePath: string }> {
  const relativePath = parseRelativePath(relativePathInput, allowRoot)
  const candidate = resolve(project.realCwd, relativePath)
  if (!isInside(project.realCwd, candidate)) throw new Error('项目路径越过了项目边界')
  const canonical = await realpath(candidate).catch(() => candidate)
  if (!isInside(project.realCwd, canonical)) throw new Error('项目路径的符号链接越过了项目边界')
  return { absolutePath: canonical, relativePath }
}

function parseSessionList(value: unknown): SessionLike[] {
  if (!isRecord(value)) return []
  const items = (value as SessionListLike).items
  return Array.isArray(items) ? items.filter(isRecord) : []
}

/**
 * 保存运行时会话与桌面已授权目录形成的项目边界。
 * renderer 只能引用这里已经登记的 project id，不能自行提交任意文件系统根目录。
 */
export class ProjectAccessRegistry {
  private readonly projects = new Map<string, ProjectRecord>()

  clear(): void {
    this.projects.clear()
  }

  async replaceFromSessionList(
    value: unknown,
    roots: readonly string[] = [],
  ): Promise<readonly DesktopProject[]> {
    const aggregate = new Map<string, { count: number; lastActivity: number }>()
    const sessions = parseSessionList(value)
    const paths = [
      ...new Set([
        ...roots,
        ...sessions.flatMap(session => (typeof session.cwd === 'string' ? [session.cwd] : [])),
      ]),
    ]
    const canonical = new Map(
      await Promise.all(paths.map(async path => [path, await canonicalDirectory(path)] as const)),
    )
    for (const path of roots) {
      const cwd = canonical.get(path)
      if (cwd !== undefined) aggregate.set(cwd, { count: 0, lastActivity: 0 })
    }
    for (const session of sessions) {
      const cwd = typeof session.cwd === 'string' ? canonical.get(session.cwd) : undefined
      if (cwd === undefined) continue
      const current = aggregate.get(cwd) ?? { count: 0, lastActivity: 0 }
      current.count += 1
      const updatedAt = Number(session.updatedAt)
      if (Number.isFinite(updatedAt))
        current.lastActivity = Math.max(current.lastActivity, updatedAt)
      aggregate.set(cwd, current)
    }

    this.projects.clear()
    for (const [cwd, summary] of [...aggregate].slice(0, MAX_PROJECTS)) {
      const id = projectId(cwd)
      this.projects.set(id, {
        id,
        name: basename(cwd),
        cwd,
        realCwd: cwd,
        displayPath: compactHomePath(cwd),
        sessionCount: summary.count,
        lastActivity: summary.lastActivity,
      })
    }
    return this.list()
  }

  /** 完整基线扫描成功后原子替换注册表，调用期间不会暴露半份目录集合。 */
  replace(candidate: ProjectAccessRegistry): void {
    this.projects.clear()
    for (const [id, project] of candidate.projects) this.projects.set(id, project)
  }

  list(): readonly DesktopProject[] {
    return [...this.projects.values()]
      .toSorted(
        (left, right) =>
          right.lastActivity - left.lastActivity || left.name.localeCompare(right.name),
      )
      .map(({ realCwd: _realCwd, ...project }) => project)
  }

  require(projectIdInput: unknown): ProjectRecord {
    if (typeof projectIdInput !== 'string' || projectIdInput === '') throw new Error('项目标识无效')
    const project = this.projects.get(projectIdInput)
    if (project === undefined) throw new Error('项目不在当前 MyDSH 工作区范围内')
    return project
  }

  resolveProjectDirectory(projectIdInput: unknown): string {
    return this.require(projectIdInput).realCwd
  }

  async resolveDroppedFiles(
    projectIdInput: unknown,
    absolutePathsInput: unknown,
  ): Promise<readonly DesktopFileReferenceCandidate[]> {
    const project = this.require(projectIdInput)
    if (
      !Array.isArray(absolutePathsInput) ||
      absolutePathsInput.length === 0 ||
      absolutePathsInput.length > DESKTOP_FILE_REFERENCE_MAX_CANDIDATES
    ) {
      throw new Error(
        `一次最多只能引用 ${String(DESKTOP_FILE_REFERENCE_MAX_CANDIDATES)} 个项目文件`,
      )
    }
    return Promise.all(
      absolutePathsInput.map(async absolutePathInput => {
        if (
          typeof absolutePathInput !== 'string' ||
          absolutePathInput === '' ||
          absolutePathInput.length > 32_768 ||
          absolutePathInput.includes('\0') ||
          !isAbsolute(absolutePathInput)
        ) {
          throw new Error('拖入的文件缺少可验证的本机路径')
        }
        const sourceMetadata = await lstat(absolutePathInput).catch(() => null)
        if (
          sourceMetadata === null ||
          !sourceMetadata.isFile() ||
          sourceMetadata.isSymbolicLink()
        ) {
          throw new Error('只能引用当前项目内的普通文件，暂不支持目录或符号链接')
        }
        const canonical = await realpath(absolutePathInput).catch(() => {
          throw new Error('拖入的文件已不可读取，请重新选择')
        })
        if (!isInside(project.realCwd, canonical)) {
          throw new Error('DSH 文件引用只支持当前项目内的文件；请先把文件放入项目目录')
        }
        const relativePath = relative(project.realCwd, canonical).split(sep).join('/')
        const value: DesktopFileReferenceCandidate = { path: relativePath, kind: 'file' }
        if (relativePath === '' || formatDesktopFileMention(value) === null) {
          throw new Error('拖入文件的名称无法用 DSH @file 语法表示')
        }
        return value
      }),
    )
  }
}

async function listDirectory(
  project: ProjectRecord,
  relativePathInput: unknown,
): Promise<{
  relativePath: string
  entries: ProjectDirectoryEntry[]
  truncated: boolean
}> {
  const target = await resolveProjectPath(project, relativePathInput, true)
  const metadata = await stat(target.absolutePath)
  if (!metadata.isDirectory()) throw new Error('请求的项目路径不是目录')
  const children = await readdir(target.absolutePath, { withFileTypes: true })
  const visible = children.filter(child => child.name !== '.git')
  const entries = await Promise.all(
    visible.slice(0, MAX_DIRECTORY_ENTRIES).map(async child => {
      const relativePath =
        target.relativePath === '' ? child.name : `${target.relativePath}/${child.name}`
      if (child.isSymbolicLink()) {
        return { name: child.name, relativePath, kind: 'symlink' as const }
      }
      if (child.isDirectory()) {
        return { name: child.name, relativePath, kind: 'directory' as const }
      }
      const childMetadata = await lstat(resolve(target.absolutePath, child.name))
      return { name: child.name, relativePath, kind: 'file' as const, size: childMetadata.size }
    }),
  )
  entries.sort((left, right) => {
    const leftRank = left.kind === 'directory' ? 0 : left.kind === 'file' ? 1 : 2
    const rightRank = right.kind === 'directory' ? 0 : right.kind === 'file' ? 1 : 2
    return leftRank - rightRank || left.name.localeCompare(right.name)
  })
  return {
    relativePath: target.relativePath,
    entries,
    truncated: visible.length > MAX_DIRECTORY_ENTRIES,
  }
}

async function readProjectFile(
  project: ProjectRecord,
  relativePathInput: unknown,
): Promise<ProjectFile> {
  const target = await resolveProjectPath(project, relativePathInput)
  const metadata = await stat(target.absolutePath)
  if (!metadata.isFile()) throw new Error('请求的项目路径不是文件')
  const expectedImageMediaType = desktopImageMediaTypeFromFileName(target.relativePath)
  if (expectedImageMediaType !== null) {
    const buffer = await readFile(target.absolutePath)
    const detectedImageMediaType = detectDesktopImageMediaType(buffer)
    if (detectedImageMediaType !== expectedImageMediaType) {
      throw new ProjectFileContentError('图片内容与文件扩展名不匹配', 'binary')
    }
    return {
      kind: 'image',
      relativePath: target.relativePath,
      mediaType: detectedImageMediaType,
      base64: buffer.toString('base64'),
      byteLength: buffer.byteLength,
    }
  }
  if (metadata.size > MAX_FILE_BYTES) {
    throw new ProjectFileContentError('文件超过内置查看器的 2 MiB 上限', 'too-large')
  }
  const buffer = await readFile(target.absolutePath)
  if (buffer.subarray(0, 8_192).includes(0)) {
    throw new ProjectFileContentError('内置查看器暂不显示二进制文件', 'binary')
  }
  let content: string
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    throw new ProjectFileContentError('文件不是有效的 UTF-8 文本', 'encoding')
  }
  return {
    kind: 'text',
    relativePath: target.relativePath,
    content,
    revision: fileRevision(buffer),
    byteLength: buffer.byteLength,
    lineCount: content === '' ? 0 : content.split('\n').length,
    language: languageFromPath(target.relativePath),
  }
}

async function writeProjectFile(
  project: ProjectRecord,
  payload: Record<string, unknown>,
): Promise<ProjectFileWriteResult> {
  const target = await resolveProjectPath(project, payload.relativePath)
  const requestedPath = resolve(project.realCwd, target.relativePath)
  const requestedMetadata = await lstat(requestedPath)
  if (!requestedMetadata.isFile() || requestedMetadata.isSymbolicLink()) {
    throw new Error('只能保存项目内已经存在的普通文本文件')
  }
  if (desktopImageMediaTypeFromFileName(target.relativePath) !== null) {
    throw new Error('图片查看器不支持写入文件')
  }
  const expectedRevision = parseFileRevision(payload.expectedRevision, '文件读取 revision')
  const overwriteRevision =
    payload.overwriteRevision === undefined
      ? null
      : parseFileRevision(payload.overwriteRevision, '冲突确认 revision')
  const next = parseTextContent(payload.content)
  const currentBytes = await readFile(target.absolutePath)
  if (currentBytes.byteLength > MAX_FILE_BYTES) {
    throw new ProjectFileContentError('文件超过内置编辑器的 2 MiB 上限', 'too-large')
  }
  if (currentBytes.subarray(0, 8_192).includes(0)) {
    throw new ProjectFileContentError('内置编辑器不能写入二进制文件', 'binary')
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(currentBytes)
  } catch {
    throw new ProjectFileContentError('文件不是有效的 UTF-8 文本', 'encoding')
  }
  const currentRevision = fileRevision(currentBytes)
  if (currentRevision !== expectedRevision && overwriteRevision !== currentRevision) {
    return {
      status: 'conflict',
      relativePath: target.relativePath,
      currentRevision,
      currentByteLength: currentBytes.byteLength,
    }
  }

  const temporaryPath = resolve(
    dirname(target.absolutePath),
    `.${basename(target.absolutePath)}.mydsh-${randomUUID()}.tmp`,
  )
  try {
    // Windows 没有 POSIX 权限位，chmod 只会切换只读属性并可能丢目标属性，因此只在 POSIX 上保留模式。
    const fileMode = process.platform === 'win32' ? undefined : requestedMetadata.mode & 0o7777
    await writeFile(temporaryPath, next.bytes, {
      flag: 'wx',
      ...(fileMode === undefined ? {} : { mode: fileMode }),
    })
    if (fileMode !== undefined) await chmod(temporaryPath, fileMode)
    const latestMetadata = await lstat(requestedPath)
    if (!latestMetadata.isFile() || latestMetadata.isSymbolicLink()) {
      throw new Error('保存前文件类型已经变化，已停止写入')
    }
    const latestBytes = await readFile(target.absolutePath)
    const latestRevision = fileRevision(latestBytes)
    if (latestRevision !== currentRevision) {
      return {
        status: 'conflict',
        relativePath: target.relativePath,
        currentRevision: latestRevision,
        currentByteLength: latestBytes.byteLength,
      }
    }
    await rename(temporaryPath, target.absolutePath)
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
  }
  const saved = await readProjectFile(project, target.relativePath)
  if (saved.kind !== 'text') throw new Error('保存后的文件类型无效')
  return { status: 'saved', file: saved }
}

async function git(
  cwd: string,
  args: readonly string[],
  acceptedExitCodes: readonly number[] = [0],
  indexFile?: string,
): Promise<string> {
  try {
    const result = await execFileAsync(process.env.MYDSH_GIT_EXECUTABLE ?? 'git', [...args], {
      cwd,
      encoding: 'utf8',
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      timeout: 15_000,
      windowsHide: true,
      env: {
        ...process.env,
        ...(indexFile === undefined ? {} : { GIT_INDEX_FILE: indexFile }),
        GIT_EDITOR: 'true',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_TERMINAL_PROMPT: '0',
        LC_ALL: 'C',
      },
    })
    return result.stdout
  } catch (error) {
    if (
      isRecord(error) &&
      typeof error.code === 'number' &&
      acceptedExitCodes.includes(error.code)
    ) {
      return typeof error.stdout === 'string' ? error.stdout : ''
    }
    throw error
  }
}

interface ParsedStatus {
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  files: GitChangedFile[]
}

function parseGitStatus(output: string): ParsedStatus {
  let branch: string | null = null
  let upstream: string | null = null
  let ahead = 0
  let behind = 0
  const files: GitChangedFile[] = []
  const records = output.split('\0')
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (record === undefined || record === '') continue
    if (record.startsWith('# branch.head ')) {
      const value = record.slice('# branch.head '.length)
      branch = value === '(detached)' ? null : value
      continue
    }
    if (record.startsWith('# branch.upstream ')) {
      upstream = record.slice('# branch.upstream '.length)
      continue
    }
    if (record.startsWith('# branch.ab ')) {
      const match = /^# branch\.ab \+(\d+) -(\d+)$/u.exec(record)
      if (match !== null) {
        ahead = Number(match[1])
        behind = Number(match[2])
      }
      continue
    }
    if (record.startsWith('? ')) {
      files.push({
        relativePath: record.slice(2),
        indexStatus: '?',
        workingTreeStatus: '?',
        staged: false,
        conflict: false,
        additions: 0,
        deletions: 0,
        binary: false,
        workingAdditions: 0,
        workingDeletions: 0,
        workingBinary: false,
        stagedAdditions: 0,
        stagedDeletions: 0,
        stagedBinary: false,
      })
      continue
    }
    const ordinary = /^1 ([^ ]{2}) \S+ \S+ \S+ \S+ \S+ \S+ (.+)$/su.exec(record)
    if (ordinary !== null) {
      const status = ordinary[1] ?? '..'
      files.push({
        relativePath: ordinary[2] ?? '',
        indexStatus: status[0] ?? '.',
        workingTreeStatus: status[1] ?? '.',
        staged: status[0] !== '.',
        conflict: false,
        additions: 0,
        deletions: 0,
        binary: false,
        workingAdditions: 0,
        workingDeletions: 0,
        workingBinary: false,
        stagedAdditions: 0,
        stagedDeletions: 0,
        stagedBinary: false,
      })
      continue
    }
    const renamed = /^2 ([^ ]{2}) \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.+)$/su.exec(record)
    if (renamed !== null) {
      const status = renamed[1] ?? '..'
      const originalPath = records[index + 1]
      if (originalPath !== undefined) index += 1
      files.push({
        relativePath: renamed[2] ?? '',
        ...(originalPath === undefined || originalPath === '' ? {} : { originalPath }),
        indexStatus: status[0] ?? '.',
        workingTreeStatus: status[1] ?? '.',
        staged: status[0] !== '.',
        conflict: false,
        additions: 0,
        deletions: 0,
        binary: false,
        workingAdditions: 0,
        workingDeletions: 0,
        workingBinary: false,
        stagedAdditions: 0,
        stagedDeletions: 0,
        stagedBinary: false,
      })
      continue
    }
    const unmerged = /^u ([^ ]{2}) \S+ \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.+)$/su.exec(record)
    if (unmerged !== null) {
      const status = unmerged[1] ?? 'UU'
      files.push({
        relativePath: unmerged[2] ?? '',
        indexStatus: status[0] ?? 'U',
        workingTreeStatus: status[1] ?? 'U',
        staged: true,
        conflict: true,
        additions: 0,
        deletions: 0,
        binary: false,
        workingAdditions: 0,
        workingDeletions: 0,
        workingBinary: false,
        stagedAdditions: 0,
        stagedDeletions: 0,
        stagedBinary: false,
      })
    }
  }
  return { branch, upstream, ahead, behind, files }
}

function parseNumstat(
  output: string,
): Map<string, { additions: number; deletions: number; binary: boolean }> {
  const result = new Map<string, { additions: number; deletions: number; binary: boolean }>()
  const records = output.split('\0')
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (record === undefined) continue
    if (record === '') continue
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/u.exec(record)
    if (match === null) continue
    let path = match[3]
    if (path === '') {
      const renamedPath = records[index + 2]
      if (renamedPath === undefined || renamedPath === '') continue
      path = renamedPath
      index += 2
    }
    if (path === undefined || path === '') continue
    const additions = match[1] === '-' ? 0 : Number(match[1])
    const deletions = match[2] === '-' ? 0 : Number(match[2])
    const binary = match[1] === '-' || match[2] === '-'
    const current = result.get(path) ?? { additions: 0, deletions: 0, binary: false }
    current.additions += additions
    current.deletions += deletions
    current.binary ||= binary
    result.set(path, current)
  }
  return result
}

function boundedPatch(patch: string): { patch: string; truncated: boolean } {
  const lines = patch.split('\n')
  const truncated = lines.length > MAX_DIFF_LINES
  return {
    patch: truncated ? `${lines.slice(0, MAX_DIFF_LINES).join('\n')}\n… Diff 已截断 …` : patch,
    truncated,
  }
}

function gitMutationFailure(action: string, error: unknown): Error {
  const stderr =
    isRecord(error) && typeof error.stderr === 'string'
      ? error.stderr.trim().replace(/\s+/gu, ' ').slice(0, 1_200)
      : ''
  if (/Please tell me who you are|unable to auto-detect email address/iu.test(stderr)) {
    return new Error(`${action}失败：Git 尚未配置提交者姓名或邮箱`)
  }
  if (/index\.lock/iu.test(stderr)) return new Error(`${action}失败：Git 索引正被其他进程占用`)
  return new Error(stderr === '' ? `${action}失败` : `${action}失败：${stderr}`)
}

function parseCommitFiles(
  statusOutput: string,
  counts: ReadonlyMap<string, { additions: number; deletions: number; binary: boolean }>,
): GitCommitDetail['files'] {
  const records = statusOutput.split('\0')
  const files: GitCommitDetail['files'] = []
  for (let index = 0; index < records.length;) {
    const status = records[index++]
    if (status === undefined || status === '') continue
    const kind = status[0] ?? 'M'
    const renamed = kind === 'R' || kind === 'C'
    const originalPath = renamed ? records[index++] : undefined
    const relativePath = records[index++]
    if (relativePath === undefined || relativePath === '') continue
    const count = counts.get(relativePath)
    files.push({
      relativePath,
      ...(originalPath === undefined || originalPath === '' ? {} : { originalPath }),
      status: kind,
      additions: count?.additions ?? 0,
      deletions: count?.deletions ?? 0,
      binary: count?.binary ?? false,
    })
  }
  return files
}

function readGitStatus(cwd: string, indexFile?: string): Promise<string> {
  return git(
    cwd,
    ['status', '--porcelain=v2', '--branch', '--untracked-files=all', '-z', '--', '.'],
    undefined,
    indexFile,
  )
}

function projectGitStatus(output: string, prefixOutput: string): ParsedStatus {
  const status = parseGitStatus(output)
  const prefix = prefixOutput.replace(/\n$/u, '')
  status.files = status.files.filter(file => file.relativePath.startsWith(prefix))
  for (const file of status.files) {
    file.relativePath = file.relativePath.slice(prefix.length)
    if (file.originalPath?.startsWith(prefix))
      file.originalPath = file.originalPath.slice(prefix.length)
    else delete file.originalPath
  }
  return status
}

function gitStatusRevision(project: ProjectRecord, output: string): string {
  return `sha256:${createHash('sha256').update(project.id).update(output).digest('hex')}`
}

async function gitSummary(project: ProjectRecord): Promise<GitProjectSummary> {
  try {
    const [statusOutput, workingOutput, stagedOutput, prefixOutput] = await Promise.all([
      readGitStatus(project.realCwd),
      git(project.realCwd, ['diff', '--relative', '--no-ext-diff', '--numstat', '-z', '--', '.']),
      git(project.realCwd, [
        'diff',
        '--relative',
        '--cached',
        '--no-ext-diff',
        '--numstat',
        '-z',
        '--',
        '.',
      ]),
      git(project.realCwd, ['rev-parse', '--show-prefix']),
    ])
    const status = projectGitStatus(statusOutput, prefixOutput)
    const workingCounts = parseNumstat(workingOutput)
    const stagedCounts = parseNumstat(stagedOutput)
    for (const file of status.files) {
      const working = workingCounts.get(file.relativePath)
      const staged = stagedCounts.get(file.relativePath)
      file.workingAdditions = working?.additions ?? 0
      file.workingDeletions = working?.deletions ?? 0
      file.workingBinary = working?.binary ?? false
      file.stagedAdditions = staged?.additions ?? 0
      file.stagedDeletions = staged?.deletions ?? 0
      file.stagedBinary = staged?.binary ?? false
      file.additions = file.workingAdditions + file.stagedAdditions
      file.deletions = file.workingDeletions + file.stagedDeletions
      file.binary = file.workingBinary || file.stagedBinary
    }
    return {
      available: true,
      branch: status.branch,
      upstream: status.upstream,
      ahead: status.ahead,
      behind: status.behind,
      files: status.files,
      statusRevision: gitStatusRevision(project, statusOutput),
      additions: status.files.reduce((sum, file) => sum + file.additions, 0),
      deletions: status.files.reduce((sum, file) => sum + file.deletions, 0),
    }
  } catch {
    return {
      available: false,
      branch: null,
      upstream: null,
      ahead: 0,
      behind: 0,
      files: [],
      additions: 0,
      deletions: 0,
      message: '当前项目不是可读取的 Git 工作区',
    }
  }
}

function parseDiffMode(value: unknown): 'working' | 'staged' {
  if (value === undefined || value === 'working') return 'working'
  if (value === 'staged') return 'staged'
  throw new Error('不支持的 Git Diff 模式')
}

async function gitDiff(
  project: ProjectRecord,
  payload: Record<string, unknown>,
): Promise<{
  relativePath: string
  mode: 'working' | 'staged'
  patch: string
  truncated: boolean
  presentation: 'text' | 'binary' | 'unavailable'
  message?: string
}> {
  const target = await resolveProjectPath(project, payload.relativePath)
  const mode = parseDiffMode(payload.mode)
  const args = [
    '--literal-pathspecs',
    'diff',
    '--relative',
    '--no-ext-diff',
    '--no-color',
    '--unified=8',
  ]
  if (mode === 'staged') args.push('--cached')
  args.push('--', target.relativePath)
  let patch = await git(project.realCwd, args)
  if (/^(?:Binary files .+ differ|GIT binary patch)$/mu.test(patch)) {
    return {
      relativePath: target.relativePath,
      mode,
      patch: '',
      truncated: false,
      presentation: 'binary',
      message: '这是二进制文件，桌面端不生成文本 Diff。',
    }
  }
  if (patch === '' && mode === 'working') {
    const summary = await gitSummary(project)
    const file = summary.files.find(item => item.relativePath === target.relativePath)
    if (file?.workingTreeStatus === '?') {
      let source: ProjectFile
      try {
        source = await readProjectFile(project, target.relativePath)
      } catch (error) {
        if (!(error instanceof ProjectFileContentError)) throw error
        return {
          relativePath: target.relativePath,
          mode,
          patch: '',
          truncated: false,
          presentation: error.reason === 'too-large' ? 'unavailable' : 'binary',
          message:
            error.reason === 'too-large'
              ? '未跟踪文件超过 2 MiB，桌面端不生成内存中的文本 Diff。'
              : '这是二进制或非 UTF-8 文件，桌面端不生成文本 Diff。',
        }
      }
      if (source.kind === 'image') {
        return {
          relativePath: target.relativePath,
          mode,
          patch: '',
          truncated: false,
          presentation: 'binary',
          message: '这是图片文件，桌面端不生成文本 Diff。',
        }
      }
      const lines = source.content.split('\n')
      patch = [
        `diff --git a/${target.relativePath} b/${target.relativePath}`,
        'new file mode 100644',
        '--- /dev/null',
        `+++ b/${target.relativePath}`,
        `@@ -0,0 +1,${String(lines.length)} @@`,
        ...lines.map(line => `+${line}`),
      ].join('\n')
    }
  }
  const bounded = boundedPatch(patch)
  return {
    relativePath: target.relativePath,
    mode,
    patch: bounded.patch,
    truncated: bounded.truncated,
    presentation: 'text',
  }
}

function parseGitCommits(output: string): GitGraphCommit[] {
  return output.split('\x1e').flatMap(record => {
    const trimmed = record.trim()
    if (trimmed === '') return []
    const [hash, shortHash, parents = '', decorations = '', author = '', time = '', subject = ''] =
      trimmed.split('\x1f')
    if (hash === undefined || shortHash === undefined) return []
    return [
      {
        hash,
        shortHash,
        parents: parents === '' ? [] : parents.split(' '),
        decorations: decorations === '' ? [] : decorations.split(', ').filter(Boolean),
        author,
        time: Number(time) * 1_000,
        subject,
      },
    ]
  })
}

const GIT_COMMIT_FORMAT = '%H%x1f%h%x1f%P%x1f%D%x1f%an%x1f%at%x1f%s%x1e'

async function gitGraph(project: ProjectRecord): Promise<readonly GitGraphCommit[]> {
  try {
    return parseGitCommits(
      await git(project.realCwd, [
        'log',
        '--all',
        '--max-count=80',
        '--topo-order',
        '--decorate=full',
        `--pretty=format:${GIT_COMMIT_FORMAT}`,
      ]),
    )
  } catch {
    return []
  }
}

function commitHash(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{40,64}$/u.test(value)) {
    throw new Error('Git 提交标识无效')
  }
  return value
}

async function gitCommit(
  project: ProjectRecord,
  payload: Record<string, unknown>,
): Promise<GitCommitDetail> {
  const hash = commitHash(payload.commitHash)
  const [metadataOutput, statusOutput, numstatOutput] = await Promise.all([
    git(project.realCwd, ['show', '-s', `--format=${GIT_COMMIT_FORMAT}`, hash]),
    git(project.realCwd, [
      'diff-tree',
      '--relative',
      '--root',
      '--no-commit-id',
      '--name-status',
      '-r',
      '-z',
      '-M',
      hash,
      '--',
      '.',
    ]),
    git(project.realCwd, [
      'show',
      '--relative',
      '--format=',
      '--numstat',
      '-z',
      '-M',
      hash,
      '--',
      '.',
    ]),
  ])
  const commit = parseGitCommits(metadataOutput)[0]
  if (commit === undefined || commit.hash !== hash) throw new Error('找不到指定的 Git 提交')
  const counts = parseNumstat(numstatOutput)
  return {
    ...commit,
    files: parseCommitFiles(statusOutput, counts),
  }
}

async function gitCommitFileDiff(
  project: ProjectRecord,
  payload: Record<string, unknown>,
): Promise<GitCommitFileDiff> {
  const hash = commitHash(payload.commitHash)
  const relativePath = parseRelativePath(payload.relativePath)
  const patch = await git(project.realCwd, [
    '--literal-pathspecs',
    'show',
    '--relative',
    '--format=',
    '--no-ext-diff',
    '--no-color',
    '--find-renames',
    '--unified=8',
    hash,
    '--',
    relativePath,
  ])
  if (/^(?:Binary files .+ differ|GIT binary patch)$/mu.test(patch)) {
    return {
      relativePath,
      commitHash: hash,
      mode: 'commit',
      patch: '',
      truncated: false,
      presentation: 'binary',
      message: '这是二进制文件，桌面端不生成文本 Diff。',
    }
  }
  const bounded = boundedPatch(patch)
  return {
    relativePath,
    commitHash: hash,
    mode: 'commit',
    patch: bounded.patch,
    truncated: bounded.truncated,
    presentation: 'text',
  }
}

function gitMutationPathspecs(mutation: { all: boolean; paths: readonly string[] }): string[] {
  return mutation.all ? ['.'] : [...mutation.paths]
}

async function gitStage(
  project: ProjectRecord,
  payload: Record<string, unknown>,
): Promise<GitProjectSummary> {
  const mutation = parseGitPathMutation(payload)
  try {
    await git(project.realCwd, [
      '--literal-pathspecs',
      'add',
      '--all',
      '--',
      ...gitMutationPathspecs(mutation),
    ])
  } catch (error) {
    throw gitMutationFailure('暂存 Git 变更', error)
  }
  return gitSummary(project)
}

async function updateLockedGitIndex(
  cwd: string,
  update: (indexFile: string) => Promise<boolean>,
): Promise<void> {
  const configuredIndexPath = (
    await git(cwd, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])
  ).replace(/\r?\n$/u, '')
  const indexPath = await realpath(configuredIndexPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return configuredIndexPath
    throw error
  })
  const lockPath = `${indexPath}.lock`
  const lock = await open(lockPath, 'wx').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'EEXIST') throw new Error('取消暂存 Git 变更失败：Git 索引正被其他进程占用')
    throw error
  })
  let temporary: string | undefined
  let published = false
  try {
    // 从读索引到发布始终占用真实锁，避免在检查后覆盖其他 Git 进程新写入的冲突。
    temporary = await mkdtemp(join(dirname(indexPath), 'mydsh-unstage-'))
    const candidate = join(temporary, 'index')
    await copyFile(indexPath, candidate).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
    if (!(await update(candidate))) return
    await lock.writeFile(await readFile(candidate))
    if (process.platform !== 'win32') {
      const metadata = await stat(indexPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return stat(candidate)
        throw error
      })
      await lock.chmod(metadata.mode & 0o777)
    }
    await lock.sync()
    await lock.close()
    await rename(lockPath, indexPath)
    published = true
  } finally {
    await lock.close().catch(() => undefined)
    if (!published) await rm(lockPath, { force: true })
    if (temporary !== undefined) await rm(temporary, { recursive: true, force: true })
  }
}

async function bulkUnstagePaths(
  project: ProjectRecord,
  indexFile: string,
  expectedStatusRevision: string | undefined,
): Promise<string[]> {
  const [output, prefix] = await Promise.all([
    readGitStatus(project.realCwd, indexFile),
    git(project.realCwd, ['rev-parse', '--show-prefix']),
  ])
  if (
    expectedStatusRevision !== undefined &&
    gitStatusRevision(project, output) !== expectedStatusRevision
  )
    throw new Error('Git 状态已变化，请刷新后重新确认取消暂存')
  const files = projectGitStatus(output, prefix).files.filter(file => file.staged && !file.conflict)
  return files.flatMap(file =>
    file.indexStatus === 'R' && file.originalPath !== undefined
      ? [file.originalPath, file.relativePath]
      : [file.relativePath],
  )
}

async function restoreStagedPaths(cwd: string, indexFile: string, paths: string[]): Promise<void> {
  const conflicts = () => git(cwd, ['ls-files', '--unmerged', '-z'], undefined, indexFile)
  const before = await conflicts()
  const pathFile = join(dirname(indexFile), 'paths')
  // NUL 分隔保留字面路径，并避免 Windows 命令行长度限制。
  await writeFile(pathFile, `${paths.join('\0')}\0`, { mode: 0o600 })
  try {
    const head = (await git(cwd, ['rev-parse', '--verify', 'HEAD'], [0, 128])).trim()
    const command =
      head !== ''
        ? ['restore', '--staged', `--source=${head}`]
        : ['rm', '--cached', '--force', '--ignore-unmatch', '-r']
    await git(
      cwd,
      [
        '--literal-pathspecs',
        ...command,
        `--pathspec-from-file=${pathFile}`,
        '--pathspec-file-nul',
      ],
      undefined,
      indexFile,
    )
  } catch (error) {
    throw gitMutationFailure('取消暂存 Git 变更', error)
  }
  // 文件与目录同名时，字面路径也可能匹配子项。复核实际结果再发布索引。
  if ((await conflicts()) !== before)
    throw new Error('取消暂存会影响未解决的 Git 冲突，请先处理冲突')
}

async function gitUnstage(
  project: ProjectRecord,
  payload: Record<string, unknown>,
): Promise<GitProjectSummary> {
  const mutation = parseGitPathMutation(payload)
  const expectedStatusRevision =
    payload.expectedStatusRevision === undefined
      ? undefined
      : parseFileRevision(payload.expectedStatusRevision, 'Git 状态版本')
  await updateLockedGitIndex(project.realCwd, async indexFile => {
    const paths = mutation.all
      ? await bulkUnstagePaths(project, indexFile, expectedStatusRevision)
      : mutation.paths
    if (paths.length === 0) return false
    await restoreStagedPaths(project.realCwd, indexFile, paths)
    return true
  })
  return gitSummary(project)
}

async function gitCreateCommit(
  project: ProjectRecord,
  payload: Record<string, unknown>,
): Promise<{
  commitHash: string
  summary: GitProjectSummary
  graph: readonly GitGraphCommit[]
}> {
  const message = parseCommitMessage(payload.message)
  const before = await gitSummary(project)
  if (!before.available) throw new Error('当前项目不是可提交的 Git 工作区')
  if (before.files.some(file => file.conflict))
    throw new Error('存在未解决的 Git 冲突，暂时不能提交')
  if (!before.files.some(file => file.indexStatus !== '.' && file.indexStatus !== '?')) {
    throw new Error('暂存区没有可提交的变更')
  }
  try {
    await git(project.realCwd, ['commit', '--message', message])
  } catch (error) {
    throw gitMutationFailure('创建 Git 提交', error)
  }
  const hash = commitHash((await git(project.realCwd, ['rev-parse', 'HEAD'])).trim())
  const [summary, graph] = await Promise.all([gitSummary(project), gitGraph(project)])
  return { commitHash: hash, summary, graph }
}

export async function callProjectService(
  registry: ProjectAccessRegistry,
  operationInput: unknown,
  payloadInput: unknown,
  actions: {
    readonly revealInFileManager?: (absolutePath: string) => void | Promise<void>
    readonly workspaceIndex?: WorkspaceIndexService
  } = {},
): Promise<ProjectCallResult> {
  const operation = parseProjectOperation(operationInput)
  if (!isRecord(payloadInput)) throw new Error('项目操作参数必须是对象')
  if (operation === 'writeFile') {
    const allowed = new Set([
      'projectId',
      'relativePath',
      'content',
      'expectedRevision',
      'overwriteRevision',
    ])
    if (Object.keys(payloadInput).some(key => !allowed.has(key))) {
      throw new Error('文件保存请求包含不支持的字段')
    }
  }
  const serialized = JSON.stringify(
    operation === 'writeFile' ? { ...payloadInput, content: undefined } : payloadInput,
  )
  if (serialized.length > 64 * 1024) throw new Error('项目操作参数超过大小上限')
  const project = registry.require(payloadInput.projectId)
  switch (operation) {
    case 'gitAiAnalyze':
    case 'gitAiCancel':
    case 'gitAiRelease':
    case 'gitAiDiff':
    case 'gitAiValidate':
    case 'gitAiExecute':
      throw new Error('AI 提交必须经由运行时工作区服务调用')
    case 'gitBranches':
    case 'gitReview':
      throw new Error('Git 审阅必须经由运行时工作区服务调用')
    case 'listDirectory':
      return listDirectory(project, payloadInput.relativePath ?? '')
    case 'readFile': {
      if (payloadInput.trackRecent !== undefined && typeof payloadInput.trackRecent !== 'boolean') {
        throw new Error('最近文件记录标记无效')
      }
      const file = await readProjectFile(project, payloadInput.relativePath)
      if (payloadInput.trackRecent === true)
        actions.workspaceIndex?.recordAccess(project.id, file.relativePath)
      return file
    }
    case 'writeFile':
      return writeProjectFile(project, payloadInput)
    case 'buildFileIndex': {
      if (actions.workspaceIndex === undefined) throw new Error('当前运行环境不支持项目文件索引')
      if (payloadInput.force !== undefined && typeof payloadInput.force !== 'boolean') {
        throw new Error('文件索引刷新标记无效')
      }
      return actions.workspaceIndex.build(project.id, project.realCwd, payloadInput.force === true)
    }
    case 'queryFiles':
      if (actions.workspaceIndex === undefined) throw new Error('当前运行环境不支持项目文件索引')
      return actions.workspaceIndex.query(project.id, project.realCwd, payloadInput.query)
    case 'searchContent':
      if (actions.workspaceIndex === undefined) throw new Error('当前运行环境不支持项目内容搜索')
      return actions.workspaceIndex.searchContent(
        project.id,
        project.realCwd,
        payloadInput.query,
        payloadInput.caseSensitive,
      )
    case 'cancelContentSearch':
      if (actions.workspaceIndex === undefined) throw new Error('当前运行环境不支持项目内容搜索')
      actions.workspaceIndex.cancelContentSearch()
      return null
    case 'gitSummary':
      return gitSummary(project)
    case 'gitDiff':
      return gitDiff(project, payloadInput)
    case 'gitGraph':
      return gitGraph(project)
    case 'gitCommit':
      return gitCommit(project, payloadInput)
    case 'gitCommitFileDiff':
      return gitCommitFileDiff(project, payloadInput)
    case 'gitStage':
      return gitStage(project, payloadInput)
    case 'gitUnstage':
      return gitUnstage(project, payloadInput)
    case 'gitCreateCommit':
      return gitCreateCommit(project, payloadInput)
    case 'revealInFinder':
      if (actions.revealInFileManager === undefined) {
        throw new Error('当前运行环境不支持在 Finder 中显示项目')
      }
      await actions.revealInFileManager(project.realCwd)
      return { revealed: true }
  }
}
