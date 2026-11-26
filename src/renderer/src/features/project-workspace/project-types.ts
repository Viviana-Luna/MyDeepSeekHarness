import {
  DESKTOP_IMAGE_ATTACHMENT_MEDIA_TYPES,
  type DesktopImageAttachmentMediaType,
} from '../../../../shared/image-attachments.ts'
import type { DesktopFileWorkspaceState } from '../../../../shared/file-workspace-state.ts'
import { isRecord } from '../../../../shared/validation.ts'

export interface DirectoryEntry {
  name: string
  relativePath: string
  kind: 'directory' | 'file' | 'symlink'
  size?: number
}

export interface DirectoryListing {
  relativePath: string
  entries: DirectoryEntry[]
  truncated: boolean
}

export interface FileWorkspaceTab {
  relativePath: string
  pinned: boolean
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

export type FileIndexPhase = 'idle' | 'building' | 'ready' | 'partial' | 'error'

export interface FileIndexStatus {
  phase: FileIndexPhase
  fileCount: number
  message?: string
}

export interface FileIndexMatch {
  relativePath: string
  name: string
  directory: string
}

export interface FileIndexQueryResult {
  items: FileIndexMatch[]
  hasMore: boolean
}

export interface ContentSearchMatch {
  relativePath: string
  line: number
  column: number
  preview: string
}

export interface ContentSearchResult {
  items: readonly ContentSearchMatch[]
  hasMore: boolean
}

export type OutlineItemKind = 'class' | 'interface' | 'function' | 'method' | 'type' | 'heading'

export interface OutlineItem {
  id: string
  label: string
  kind: OutlineItemKind
  line: number
  depth: number
}

export interface RunConfiguration {
  id: string
  name: string
  script: string
  command: string
}

export interface RunConfigurationProjection {
  available: boolean
  source: 'package.json'
  packageName: string | null
  configurations: RunConfiguration[]
  message?: string
}

export function parseFileWorkspaceState(value: unknown): DesktopFileWorkspaceState | null {
  if (value === null) return null
  if (
    !isRecord(value) ||
    typeof value.projectId !== 'string' ||
    !Array.isArray(value.pinnedFiles) ||
    value.pinnedFiles.some(item => typeof item !== 'string') ||
    (value.previewFile !== undefined && typeof value.previewFile !== 'string') ||
    (value.activeFile !== undefined && typeof value.activeFile !== 'string') ||
    (value.activeLine !== undefined && !Number.isSafeInteger(value.activeLine)) ||
    !Array.isArray(value.expandedDirectories) ||
    value.expandedDirectories.some(item => typeof item !== 'string') ||
    !Array.isArray(value.recentFiles) ||
    value.recentFiles.some(item => typeof item !== 'string') ||
    !Number.isFinite(value.treeScrollLeft) ||
    !Number.isFinite(value.treeScrollTop)
  )
    throw new Error('文件工作区返回了无效状态')
  return value as unknown as DesktopFileWorkspaceState
}

export function parseDirectoryListing(value: unknown): DirectoryListing {
  if (!isRecord(value) || !Array.isArray(value.entries))
    throw new Error('项目服务返回了无效的目录列表')
  const entries = value.entries.flatMap(entry => {
    if (
      !isRecord(entry) ||
      typeof entry.name !== 'string' ||
      typeof entry.relativePath !== 'string' ||
      !['directory', 'file', 'symlink'].includes(String(entry.kind))
    )
      return []
    return [
      {
        name: entry.name,
        relativePath: entry.relativePath,
        kind: entry.kind as DirectoryEntry['kind'],
        ...(Number.isFinite(Number(entry.size)) ? { size: Number(entry.size) } : {}),
      },
    ]
  })
  return {
    relativePath: typeof value.relativePath === 'string' ? value.relativePath : '',
    entries,
    truncated: value.truncated === true,
  }
}

export function parseProjectFile(value: unknown): ProjectFile {
  if (!isRecord(value) || typeof value.relativePath !== 'string') {
    throw new Error('项目服务返回了无效的文件内容')
  }
  if (value.kind === 'image') {
    if (
      typeof value.base64 !== 'string' ||
      typeof value.mediaType !== 'string' ||
      !DESKTOP_IMAGE_ATTACHMENT_MEDIA_TYPES.includes(
        value.mediaType as DesktopImageAttachmentMediaType,
      )
    ) {
      throw new Error('项目服务返回了无效的图片内容')
    }
    return {
      kind: 'image',
      relativePath: value.relativePath,
      mediaType: value.mediaType as DesktopImageAttachmentMediaType,
      base64: value.base64,
      byteLength: Number(value.byteLength) || 0,
    }
  }
  if (
    value.kind !== 'text' ||
    typeof value.content !== 'string' ||
    typeof value.revision !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/u.test(value.revision)
  ) {
    throw new Error('项目服务返回了无效的文本内容')
  }
  return {
    kind: 'text',
    relativePath: value.relativePath,
    content: value.content,
    revision: value.revision,
    byteLength: Number(value.byteLength) || 0,
    lineCount: Number(value.lineCount) || 0,
    language: typeof value.language === 'string' ? value.language : 'text',
  }
}

export function parseProjectFileWriteResult(value: unknown): ProjectFileWriteResult {
  if (!isRecord(value)) throw new Error('项目服务返回了无效的文件保存结果')
  if (value.status === 'saved') {
    const file = parseProjectFile(value.file)
    if (file.kind !== 'text') throw new Error('项目服务返回了无效的文本保存结果')
    return { status: 'saved', file }
  }
  if (
    value.status === 'conflict' &&
    typeof value.relativePath === 'string' &&
    typeof value.currentRevision === 'string' &&
    /^sha256:[a-f0-9]{64}$/u.test(value.currentRevision) &&
    Number.isSafeInteger(value.currentByteLength) &&
    Number(value.currentByteLength) >= 0
  ) {
    return {
      status: 'conflict',
      relativePath: value.relativePath,
      currentRevision: value.currentRevision,
      currentByteLength: Number(value.currentByteLength),
    }
  }
  throw new Error('项目服务返回了无效的文件保存结果')
}

const FILE_INDEX_PHASES = new Set<FileIndexPhase>(['idle', 'building', 'ready', 'partial', 'error'])

export function parseFileIndexStatus(value: unknown): FileIndexStatus {
  if (!isRecord(value) || !FILE_INDEX_PHASES.has(value.phase as FileIndexPhase)) {
    throw new Error('项目服务返回了无效的文件索引状态')
  }
  return {
    phase: value.phase as FileIndexPhase,
    fileCount:
      Number.isSafeInteger(value.fileCount) && Number(value.fileCount) >= 0
        ? Number(value.fileCount)
        : 0,
    ...(typeof value.message === 'string' ? { message: value.message } : {}),
  }
}

export function parseFileIndexQueryResult(value: unknown): FileIndexQueryResult {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    throw new Error('项目服务返回了无效的文件搜索结果')
  }
  return {
    items: value.items.slice(0, 100).flatMap(item => {
      if (
        !isRecord(item) ||
        typeof item.relativePath !== 'string' ||
        typeof item.name !== 'string' ||
        typeof item.directory !== 'string'
      )
        return []
      return [
        {
          relativePath: item.relativePath,
          name: item.name,
          directory: item.directory,
        },
      ]
    }),
    hasMore: value.hasMore === true,
  }
}

export function parseContentSearchResult(value: unknown): ContentSearchResult {
  if (!isRecord(value) || !Array.isArray(value.items) || typeof value.hasMore !== 'boolean') {
    throw new Error('项目服务返回了无效的内容搜索结果')
  }
  const items = value.items.map((item): ContentSearchMatch => {
    if (
      !isRecord(item) ||
      typeof item.relativePath !== 'string' ||
      !Number.isSafeInteger(item.line) ||
      Number(item.line) <= 0 ||
      !Number.isSafeInteger(item.column) ||
      Number(item.column) <= 0 ||
      typeof item.preview !== 'string'
    ) {
      throw new Error('项目服务返回了无效的内容搜索匹配')
    }
    return {
      relativePath: item.relativePath,
      line: Number(item.line),
      column: Number(item.column),
      preview: item.preview,
    }
  })
  return { items, hasMore: value.hasMore }
}

export function parsePackageRunConfigurations(file: ProjectFile): RunConfigurationProjection {
  if (file.kind !== 'text') {
    return {
      available: false,
      source: 'package.json',
      packageName: null,
      configurations: [],
      message: 'package.json 不是可读取的文本文件。',
    }
  }
  let manifest: unknown
  try {
    manifest = JSON.parse(file.content)
  } catch {
    return {
      available: false,
      source: 'package.json',
      packageName: null,
      configurations: [],
      message: 'package.json 不是有效的 JSON，无法读取运行配置。',
    }
  }
  if (!isRecord(manifest)) {
    return {
      available: false,
      source: 'package.json',
      packageName: null,
      configurations: [],
      message: 'package.json 的顶层结构无效，无法读取运行配置。',
    }
  }
  const scripts = isRecord(manifest.scripts) ? manifest.scripts : {}
  const configurations = Object.entries(scripts).flatMap(([name, script]) => {
    if (typeof script !== 'string') return []
    return [
      {
        id: `npm:${name}`,
        name,
        script,
        command: `npm run ${name}`,
      },
    ]
  })
  return {
    available: configurations.length > 0,
    source: 'package.json',
    packageName: typeof manifest.name === 'string' ? manifest.name : null,
    configurations,
    ...(configurations.length === 0 ? { message: 'package.json 没有定义 scripts。' } : {}),
  }
}
