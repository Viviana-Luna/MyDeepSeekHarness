import { execFile } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { rgPath } from '@vscode/ripgrep'

import {
  callProjectService,
  ProjectAccessRegistry,
  type DesktopProject,
  type GitCommitDetail,
  type GitGraphCommit,
  type GitProjectSummary,
  type ProjectDirectoryEntry,
  type ProjectFile,
  type ProjectFileWriteResult,
} from '../src/runtime/workspace/project-service.ts'
import { MydshWorkspace } from '../src/runtime/workspace/index.ts'
import { WorkspaceIndexService } from '../src/runtime/workspace/workspace-index-service.ts'

const execFileAsync = promisify(execFile)
const temporaryRoots: string[] = []

function temporaryDirectory(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `mydsh-${label}-`))
  temporaryRoots.push(root)
  return root
}

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync('git', [...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' },
  })
  return result.stdout
}

async function registerProject(
  registry: ProjectAccessRegistry,
  cwd: string,
): Promise<DesktopProject> {
  const projects = await registry.replaceFromSessionList({
    items: [{ sessionId: '测试会话', cwd, updatedAt: 100 }],
  })
  const project = projects[0]
  if (project === undefined) throw new Error('测试项目没有被登记')
  return project
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(root =>
      // 异步 rm 在重试间隙让出事件循环，使 Windows 下已关闭的 FSWatcher 与中止中的子进程句柄及时释放。
      rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }),
    ),
  )
})

describe('项目访问注册表', () => {
  it('只登记真实 Session 中存在的目录，并按规范路径聚合', async () => {
    const root = temporaryDirectory('registry')
    const projectDirectory = join(root, '真实项目')
    const projectAlias = join(root, '项目别名')
    const ordinaryFile = join(root, '不是目录.txt')
    mkdirSync(projectDirectory)
    // Windows 普通账户没有符号链接特权，目录别名用 junction；lstat 仍会报告为符号链接。
    symlinkSync(projectDirectory, projectAlias, process.platform === 'win32' ? 'junction' : 'dir')
    writeFileSync(ordinaryFile, '普通文件')

    const registry = new ProjectAccessRegistry()
    const projects = await registry.replaceFromSessionList({
      items: [
        { sessionId: '一', cwd: projectDirectory, updatedAt: 20 },
        { sessionId: '二', cwd: projectAlias, updatedAt: 80 },
        { sessionId: '相对路径', cwd: 'relative/project', updatedAt: 100 },
        { sessionId: '不存在', cwd: join(root, 'missing'), updatedAt: 100 },
        { sessionId: '普通文件', cwd: ordinaryFile, updatedAt: 100 },
        { sessionId: '无目录字段', updatedAt: 100 },
        null,
      ],
    })

    expect(projects).toHaveLength(1)
    expect(projects[0]).toMatchObject({
      cwd: realpathSync.native(projectDirectory),
      name: '真实项目',
      sessionCount: 2,
      lastActivity: 80,
    })
    expect(projects[0]?.id).toMatch(/^[a-f0-9]{24}$/u)
    expect(registry.list()).toEqual(projects)
    expect(() => registry.require('renderer-自报项目')).toThrow('项目不在当前 MyDSH 工作区范围内')
    const secondDirectory = join(root, '第二个项目')
    mkdirSync(secondDirectory)
    const manySessions = await registry.replaceFromSessionList({
      items: [
        ...Array.from({ length: 256 }, (_, index) => ({
          sessionId: String(index),
          cwd: projectDirectory,
        })),
        { sessionId: '第二个项目会话', cwd: secondDirectory },
      ],
    })
    expect(manySessions).toHaveLength(2)
    expect(manySessions.find(project => project.name === '真实项目')?.sessionCount).toBe(256)
  })
})

describe('运行时项目基线与资源释放', () => {
  it('合并已授权目录与会话，文件操作始终使用后台登记的项目边界', async () => {
    const root = temporaryDirectory('runtime-workspace')
    writeFileSync(join(root, 'README.md'), '运行时项目\n')
    const workspace = new MydshWorkspace(rgPath)
    try {
      const projects = await workspace.sync({ items: [] }, [root])
      const project = projects[0]!
      expect(project.sessionCount).toBe(0)
      await expect(
        workspace.call(project.id, 'readFile', { relativePath: 'README.md' }),
      ).resolves.toMatchObject({ kind: 'text', content: '运行时项目\n' })
      const baseline = await workspace.sync({ items: [{ cwd: root, updatedAt: 10 }] }, [root])
      expect(baseline).toMatchObject([{ id: project.id, sessionCount: 1, lastActivity: 10 }])
      await expect(
        workspace.resolveDroppedFiles(project.id, [join(root, 'README.md')]),
      ).resolves.toEqual([{ path: 'README.md', kind: 'file' }])
      workspace.clear()
      await expect(
        workspace.call(project.id, 'readFile', { relativePath: 'README.md' }),
      ).rejects.toThrow('项目不在当前 MyDSH 工作区范围内')
    } finally {
      workspace.clear()
    }
  })

  it('停止后拒绝未完成的旧目录扫描，不能重新授予已撤销的项目范围', async () => {
    const root = temporaryDirectory('runtime-workspace-cancel')
    const workspace = new MydshWorkspace(rgPath)
    const pending = workspace.sync({ items: [{ cwd: root }] })
    workspace.clear()
    await expect(pending).rejects.toThrow('项目基线已失效')
    expect(workspace.registry.list()).toEqual([])
  })
})

describe('项目目录与文件读取', () => {
  it('列出目录并读取 UTF-8 文本及语言信息', async () => {
    const root = temporaryDirectory('files')
    const projectDirectory = join(root, 'workspace')
    const sourceDirectory = join(projectDirectory, 'src')
    const outsideDirectory = join(root, 'outside')
    const outsideFile = join(outsideDirectory, 'outside.txt')
    mkdirSync(sourceDirectory, { recursive: true })
    mkdirSync(join(projectDirectory, '.git'))
    mkdirSync(outsideDirectory)
    writeFileSync(join(projectDirectory, 'README.md'), '第一行\n第二行\n')
    writeFileSync(join(sourceDirectory, 'main.ts'), 'export const answer = 42\n')
    writeFileSync(join(sourceDirectory, 'AuditService.kt'), 'class AuditService\n')
    writeFileSync(outsideFile, '项目外文件')
    // Windows 普通账户不能建立文件符号链接：改用指向项目外目录的 junction，仍然验证“链接指向项目外”。
    if (process.platform === 'win32')
      symlinkSync(outsideDirectory, join(projectDirectory, '外部链接.txt'), 'junction')
    else symlinkSync(outsideFile, join(projectDirectory, '外部链接.txt'))

    const registry = new ProjectAccessRegistry()
    const project = await registerProject(registry, projectDirectory)
    const listing = (await callProjectService(registry, 'listDirectory', {
      projectId: project.id,
      relativePath: '',
    })) as { relativePath: string; entries: ProjectDirectoryEntry[]; truncated: boolean }

    expect(listing).toEqual({
      relativePath: '',
      truncated: false,
      entries: [
        { name: 'src', relativePath: 'src', kind: 'directory' },
        expect.objectContaining({ name: 'README.md', relativePath: 'README.md', kind: 'file' }),
        { name: '外部链接.txt', relativePath: '外部链接.txt', kind: 'symlink' },
      ],
    })
    expect(listing.entries.map(entry => entry.name)).not.toContain('.git')

    const file = (await callProjectService(registry, 'readFile', {
      projectId: project.id,
      relativePath: 'src/main.ts',
    })) as ProjectFile
    expect(file).toEqual({
      kind: 'text',
      relativePath: 'src/main.ts',
      content: 'export const answer = 42\n',
      revision: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      byteLength: Buffer.byteLength('export const answer = 42\n'),
      lineCount: 2,
      language: 'typescript',
    })
    const kotlinFile = (await callProjectService(registry, 'readFile', {
      projectId: project.id,
      relativePath: 'src/AuditService.kt',
    })) as ProjectFile
    expect(kotlinFile.kind).toBe('text')
    if (kotlinFile.kind !== 'text') throw new Error('Kotlin 文件被错误识别为图片')
    expect(kotlinFile.language).toBe('kotlin')

    await expect(
      registry.resolveDroppedFiles(project.id, [
        join(sourceDirectory, 'main.ts'),
        join(projectDirectory, 'README.md'),
      ]),
    ).resolves.toEqual([
      { path: 'src/main.ts', kind: 'file' },
      { path: 'README.md', kind: 'file' },
    ])

    const reveal = vi.fn()
    await expect(
      callProjectService(
        registry,
        'revealInFinder',
        {
          projectId: project.id,
        },
        { revealInFileManager: reveal },
      ),
    ).resolves.toEqual({ revealed: true })
    expect(reveal).toHaveBeenCalledWith(realpathSync.native(projectDirectory))
  })

  it('允许查看超过 2 MiB 的有效图片，同时保留文本查看上限', async () => {
    const root = temporaryDirectory('large-image')
    const projectDirectory = join(root, 'workspace')
    mkdirSync(projectDirectory)
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5+kL8AAAAASUVORK5CYII=',
      'base64',
    )
    const largePng = Buffer.concat([png, Buffer.alloc(2 * 1024 * 1024)])
    writeFileSync(join(projectDirectory, '大图.png'), largePng)
    writeFileSync(join(projectDirectory, '大文本.txt'), Buffer.alloc(2 * 1024 * 1024 + 1, 0x61))

    const registry = new ProjectAccessRegistry()
    const project = await registerProject(registry, projectDirectory)
    await expect(
      callProjectService(registry, 'readFile', {
        projectId: project.id,
        relativePath: '大图.png',
      }),
    ).resolves.toEqual({
      kind: 'image',
      relativePath: '大图.png',
      mediaType: 'image/png',
      base64: largePng.toString('base64'),
      byteLength: largePng.byteLength,
    })
    await expect(
      callProjectService(registry, 'readFile', {
        projectId: project.id,
        relativePath: '大文本.txt',
      }),
    ).rejects.toThrow('文件超过内置查看器的 2 MiB 上限')
  })

  it('按 revision 原子保存文本并在外部修改后阻止静默覆盖', async () => {
    const root = temporaryDirectory('file-write')
    const projectDirectory = join(root, 'workspace')
    mkdirSync(projectDirectory)
    const filePath = join(projectDirectory, 'notes.txt')
    writeFileSync(filePath, '初始内容\n', { mode: 0o640 })

    const registry = new ProjectAccessRegistry()
    const project = await registerProject(registry, projectDirectory)
    const initial = (await callProjectService(registry, 'readFile', {
      projectId: project.id,
      relativePath: 'notes.txt',
    })) as ProjectFile
    if (initial.kind !== 'text') throw new Error('文本文件被错误识别为图片')

    const saved = (await callProjectService(registry, 'writeFile', {
      projectId: project.id,
      relativePath: 'notes.txt',
      content: '桌面保存\n',
      expectedRevision: initial.revision,
    })) as ProjectFileWriteResult
    expect(saved.status).toBe('saved')
    if (saved.status !== 'saved') throw new Error('正常保存被错误识别为冲突')
    expect(saved.file.content).toBe('桌面保存\n')
    expect(saved.file.revision).not.toBe(initial.revision)
    expect(readFileSync(filePath, 'utf8')).toBe('桌面保存\n')
    // Windows 没有 POSIX 权限位，保存只保证内容与原子替换，不承诺模式位。
    if (process.platform !== 'win32') expect(statSync(filePath).mode & 0o777).toBe(0o640)
    expect(readdirSync(projectDirectory).some(name => name.includes('.mydsh-'))).toBe(false)

    writeFileSync(filePath, '外部修改\n', { mode: 0o640 })
    const conflict = (await callProjectService(registry, 'writeFile', {
      projectId: project.id,
      relativePath: 'notes.txt',
      content: '本地草稿\n',
      expectedRevision: saved.file.revision,
    })) as ProjectFileWriteResult
    expect(conflict).toMatchObject({ status: 'conflict', relativePath: 'notes.txt' })
    expect(readFileSync(filePath, 'utf8')).toBe('外部修改\n')
    if (conflict.status !== 'conflict') throw new Error('外部修改没有形成冲突')

    const overwritten = (await callProjectService(registry, 'writeFile', {
      projectId: project.id,
      relativePath: 'notes.txt',
      content: '本地草稿\n',
      expectedRevision: saved.file.revision,
      overwriteRevision: conflict.currentRevision,
    })) as ProjectFileWriteResult
    expect(overwritten.status).toBe('saved')
    expect(readFileSync(filePath, 'utf8')).toBe('本地草稿\n')
  })

  it('拒绝父目录、绝对路径和越界符号链接', async () => {
    const root = temporaryDirectory('boundary')
    const projectDirectory = join(root, 'workspace')
    const outsideDirectory = join(root, 'outside')
    const outsideFile = join(outsideDirectory, 'secret.txt')
    mkdirSync(projectDirectory)
    mkdirSync(outsideDirectory)
    writeFileSync(outsideFile, '不得读取')
    // Windows 普通账户不能建立文件符号链接：用指向项目外目录的 junction 做等价的越界链接。
    const escapeLink = join(projectDirectory, 'escape.txt')
    if (process.platform === 'win32') symlinkSync(outsideDirectory, escapeLink, 'junction')
    else symlinkSync(outsideFile, escapeLink)

    const registry = new ProjectAccessRegistry()
    const project = await registerProject(registry, projectDirectory)

    await expect(
      callProjectService(registry, 'readFile', {
        projectId: project.id,
        relativePath: '../secret.txt',
      }),
    ).rejects.toThrow('项目相对路径必须位于项目目录内')
    await expect(
      callProjectService(registry, 'readFile', {
        projectId: project.id,
        relativePath: outsideFile,
      }),
    ).rejects.toThrow('项目相对路径必须位于项目目录内')
    await expect(
      callProjectService(registry, 'readFile', {
        projectId: project.id,
        relativePath: process.platform === 'win32' ? 'escape.txt/secret.txt' : 'escape.txt',
      }),
    ).rejects.toThrow('项目路径的符号链接越过了项目边界')
    await expect(registry.resolveDroppedFiles(project.id, [outsideFile])).rejects.toThrow(
      '只支持当前项目内的文件',
    )
  })

  it('使用固定 Ripgrep 建立文件名索引，并按匹配与最近打开排序', async () => {
    const root = temporaryDirectory('file-index')
    const projectDirectory = join(root, 'workspace')
    mkdirSync(join(projectDirectory, 'src', 'feature'), { recursive: true })
    mkdirSync(join(projectDirectory, 'node_modules', 'ignored-package'), { recursive: true })
    writeFileSync(join(projectDirectory, '.gitignore'), 'ignored.txt\n')
    writeFileSync(join(projectDirectory, 'ignored.txt'), '不进入索引')
    writeFileSync(join(projectDirectory, 'src', 'main.ts'), 'export const main = true\n')
    writeFileSync(
      join(projectDirectory, 'src', 'feature', 'MainPanel.tsx'),
      'export function MainPanel() {}\n',
    )
    writeFileSync(join(projectDirectory, 'README.md'), '# 项目\n')
    writeFileSync(join(projectDirectory, 'node_modules', 'ignored-package', 'index.js'), 'ignored')

    const registry = new ProjectAccessRegistry()
    const project = await registerProject(registry, projectDirectory)
    const workspaceIndex = new WorkspaceIndexService(rgPath)
    const status = await callProjectService(
      registry,
      'buildFileIndex',
      {
        projectId: project.id,
        force: true,
      },
      { workspaceIndex },
    )
    expect(status).toMatchObject({ phase: 'ready', fileCount: 4 })

    const result = (await callProjectService(
      registry,
      'queryFiles',
      {
        projectId: project.id,
        query: 'main',
      },
      { workspaceIndex },
    )) as { items: Array<{ relativePath: string }> }
    expect(result.items.map(item => item.relativePath)).toEqual([
      'src/main.ts',
      'src/feature/MainPanel.tsx',
    ])

    await callProjectService(
      registry,
      'readFile',
      {
        projectId: project.id,
        relativePath: 'README.md',
        trackRecent: true,
      },
      { workspaceIndex },
    )
    const recent = (await callProjectService(
      registry,
      'queryFiles',
      {
        projectId: project.id,
        query: '',
      },
      { workspaceIndex },
    )) as { items: Array<{ relativePath: string }> }
    expect(recent.items[0]?.relativePath).toBe('README.md')
    expect(recent.items.some(item => item.relativePath.includes('node_modules'))).toBe(false)
    expect(recent.items.some(item => item.relativePath === 'ignored.txt')).toBe(false)

    const content = (await callProjectService(
      registry,
      'searchContent',
      {
        projectId: project.id,
        query: 'MAINPANEL',
        caseSensitive: false,
      },
      { workspaceIndex },
    )) as { items: Array<{ relativePath: string; line: number; preview: string }> }
    expect(content.items).toEqual([
      expect.objectContaining({
        relativePath: 'src/feature/MainPanel.tsx',
        line: 1,
        preview: 'export function MainPanel() {}',
      }),
    ])
    const caseSensitive = (await callProjectService(
      registry,
      'searchContent',
      {
        projectId: project.id,
        query: 'MAINPANEL',
        caseSensitive: true,
      },
      { workspaceIndex },
    )) as { items: unknown[] }
    expect(caseSensitive.items).toEqual([])
    workspaceIndex.clear()
  })

  it('达到文件数量上限时明确返回部分索引', async () => {
    const root = temporaryDirectory('partial-index')
    const projectDirectory = join(root, 'workspace')
    mkdirSync(projectDirectory)
    writeFileSync(join(projectDirectory, 'a.txt'), 'a')
    writeFileSync(join(projectDirectory, 'b.txt'), 'b')
    writeFileSync(join(projectDirectory, 'c.txt'), 'c')
    const registry = new ProjectAccessRegistry()
    const project = await registerProject(registry, projectDirectory)
    const workspaceIndex = new WorkspaceIndexService(rgPath, { maxFiles: 2 })
    await expect(
      callProjectService(
        registry,
        'buildFileIndex',
        {
          projectId: project.id,
        },
        { workspaceIndex },
      ),
    ).resolves.toMatchObject({
      phase: 'partial',
      fileCount: 2,
      message: expect.stringContaining('2 条上限'),
    })
    workspaceIndex.clear()
  })

  it('空目录或仅含空子目录与排除目录时正常返回就绪且无文件', async () => {
    const root = temporaryDirectory('empty-index')
    const emptyDirectory = join(root, 'empty')
    const ignoredDirectory = join(root, 'only-ignored')
    mkdirSync(emptyDirectory)
    mkdirSync(join(ignoredDirectory, 'sub'), { recursive: true })
    mkdirSync(join(ignoredDirectory, '.git'), { recursive: true })
    mkdirSync(join(ignoredDirectory, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(ignoredDirectory, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    writeFileSync(join(ignoredDirectory, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1\n')

    const registry = new ProjectAccessRegistry()
    const projects = await registry.replaceFromSessionList({
      items: [
        { sessionId: '空项目', cwd: emptyDirectory, updatedAt: 100 },
        { sessionId: '忽略目录项目', cwd: ignoredDirectory, updatedAt: 200 },
      ],
    })
    const emptyProject = projects.find(item => item.name === 'empty')!
    const ignoredProject = projects.find(item => item.name === 'only-ignored')!
    const workspaceIndex = new WorkspaceIndexService(rgPath)
    try {
      await expect(
        callProjectService(
          registry,
          'buildFileIndex',
          { projectId: emptyProject.id },
          { workspaceIndex },
        ),
      ).resolves.toEqual({ phase: 'ready', fileCount: 0 })
      await expect(
        callProjectService(
          registry,
          'queryFiles',
          { projectId: emptyProject.id, query: '' },
          { workspaceIndex },
        ),
      ).resolves.toEqual({ items: [], hasMore: false })
      await expect(
        callProjectService(
          registry,
          'buildFileIndex',
          { projectId: ignoredProject.id },
          { workspaceIndex },
        ),
      ).resolves.toEqual({ phase: 'ready', fileCount: 0 })
    } finally {
      workspaceIndex.clear()
    }
  })

  it('不可用索引程序或无权限目录仍返回索引错误提示', async () => {
    const root = temporaryDirectory('error-index')
    const projectDirectory = join(root, 'workspace')
    mkdirSync(projectDirectory)
    const registry = new ProjectAccessRegistry()
    const project = await registerProject(registry, projectDirectory)
    const missingBinaryIndex = new WorkspaceIndexService(join(root, 'missing-rg'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await expect(
        callProjectService(
          registry,
          'buildFileIndex',
          { projectId: project.id },
          { workspaceIndex: missingBinaryIndex },
        ),
      ).resolves.toEqual({
        phase: 'error',
        fileCount: 0,
        message: '无法建立项目文件索引，请检查项目目录权限后重试。',
      })

      if (
        process.platform !== 'win32' &&
        typeof process.getuid === 'function' &&
        process.getuid() !== 0
      ) {
        const restricted = join(projectDirectory, 'secret')
        mkdirSync(restricted)
        const { chmodSync } = await import('node:fs')
        chmodSync(restricted, 0o000)
        const workspaceIndex = new WorkspaceIndexService(rgPath)
        try {
          await expect(
            callProjectService(
              registry,
              'buildFileIndex',
              { projectId: project.id },
              { workspaceIndex },
            ),
          ).resolves.toEqual({
            phase: 'error',
            fileCount: 0,
            message: '无法建立项目文件索引，请检查项目目录权限后重试。',
          })
        } finally {
          chmodSync(restricted, 0o700)
          workspaceIndex.clear()
        }
      }
    } finally {
      warn.mockRestore()
      missingBinaryIndex.clear()
    }
  })
})

describe('项目 Git 读取', () => {
  it('返回真实工作区摘要、文件 Diff 与提交图', async () => {
    const root = temporaryDirectory('git')
    const projectDirectory = join(root, 'workspace')
    const sourceDirectory = join(projectDirectory, 'src')
    mkdirSync(sourceDirectory, { recursive: true })
    await runGit(projectDirectory, ['init', '--initial-branch=main'])
    await runGit(projectDirectory, ['config', 'user.name', '测试用户'])
    await runGit(projectDirectory, ['config', 'user.email', 'test@example.invalid'])
    writeFileSync(join(sourceDirectory, 'main.ts'), 'const value = 1\nconst obsolete = true\n')
    await runGit(projectDirectory, ['add', 'src/main.ts'])
    await runGit(projectDirectory, ['commit', '-m', '初始提交'])

    writeFileSync(join(sourceDirectory, 'main.ts'), 'const value = 2\nconst added = true\n')
    writeFileSync(join(projectDirectory, 'notes.txt'), '未跟踪说明\n')
    mkdirSync(join(projectDirectory, 'performance'))
    writeFileSync(join(projectDirectory, 'performance', 'report.txt'), '性能说明\n')

    const registry = new ProjectAccessRegistry()
    const project = await registerProject(registry, projectDirectory)
    const summary = (await callProjectService(registry, 'gitSummary', {
      projectId: project.id,
    })) as GitProjectSummary

    expect(summary).toMatchObject({
      available: true,
      branch: 'main',
      upstream: null,
      ahead: 0,
      behind: 0,
      additions: 2,
      deletions: 2,
    })
    expect(summary.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relativePath: 'src/main.ts',
          workingTreeStatus: 'M',
          additions: 2,
          deletions: 2,
        }),
        expect.objectContaining({
          relativePath: 'notes.txt',
          workingTreeStatus: '?',
          staged: false,
        }),
        expect.objectContaining({
          relativePath: 'performance/report.txt',
          workingTreeStatus: '?',
        }),
      ]),
    )
    expect(summary.files.some(file => file.relativePath === 'performance/')).toBe(false)

    const diff = (await callProjectService(registry, 'gitDiff', {
      projectId: project.id,
      relativePath: 'src/main.ts',
      mode: 'working',
    })) as { relativePath: string; mode: string; patch: string; truncated: boolean }
    expect(diff).toMatchObject({ relativePath: 'src/main.ts', mode: 'working', truncated: false })
    expect(diff.patch).toContain('diff --git a/src/main.ts b/src/main.ts')
    expect(diff.patch).toContain('-const value = 1')
    expect(diff.patch).toContain('+const value = 2')

    await callProjectService(registry, 'gitStage', {
      projectId: project.id,
      relativePaths: ['src/main.ts'],
    })
    writeFileSync(
      join(sourceDirectory, 'main.ts'),
      'const value = 2\nconst added = true\nconst later = true\n',
    )
    const stagedSummary = (await callProjectService(registry, 'gitSummary', {
      projectId: project.id,
    })) as GitProjectSummary
    expect(stagedSummary.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relativePath: 'src/main.ts',
          indexStatus: 'M',
          workingTreeStatus: 'M',
          stagedAdditions: 2,
          stagedDeletions: 2,
          workingAdditions: 1,
          workingDeletions: 0,
        }),
        expect.objectContaining({ relativePath: 'notes.txt', workingTreeStatus: '?' }),
      ]),
    )

    await expect(
      callProjectService(registry, 'gitDiff', {
        projectId: project.id,
        relativePath: 'src/main.ts',
        mode: 'staged',
      }),
    ).resolves.toMatchObject({
      relativePath: 'src/main.ts',
      mode: 'staged',
      patch: expect.stringContaining('+const value = 2'),
    })

    const unstagedSummary = (await callProjectService(registry, 'gitUnstage', {
      projectId: project.id,
      relativePaths: ['src/main.ts'],
    })) as GitProjectSummary
    expect(unstagedSummary.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relativePath: 'src/main.ts',
          indexStatus: '.',
          workingTreeStatus: 'M',
        }),
      ]),
    )
    expect(readFileSync(join(sourceDirectory, 'main.ts'), 'utf8')).toContain('const value = 2')

    const allStaged = (await callProjectService(registry, 'gitStage', {
      projectId: project.id,
      all: true,
    })) as GitProjectSummary
    expect(
      allStaged.files.every(file => file.indexStatus !== '.' && file.indexStatus !== '?'),
    ).toBe(true)
    const allUnstaged = (await callProjectService(registry, 'gitUnstage', {
      projectId: project.id,
      all: true,
    })) as GitProjectSummary
    expect(allUnstaged.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relativePath: 'src/main.ts',
          indexStatus: '.',
          workingTreeStatus: 'M',
        }),
        expect.objectContaining({
          relativePath: 'notes.txt',
          indexStatus: '?',
          workingTreeStatus: '?',
        }),
      ]),
    )

    const graph = (await callProjectService(registry, 'gitGraph', {
      projectId: project.id,
    })) as GitGraphCommit[]
    expect(graph).toHaveLength(1)
    expect(graph[0]).toMatchObject({
      subject: '初始提交',
      author: '测试用户',
      parents: [],
    })
    expect(graph[0]?.hash).toMatch(/^[a-f0-9]{40}$/u)
    expect(graph[0]?.shortHash).toMatch(/^[a-f0-9]+$/u)
    expect(graph[0]?.time).toEqual(expect.any(Number))

    const commit = (await callProjectService(registry, 'gitCommit', {
      projectId: project.id,
      commitHash: graph[0]?.hash,
    })) as GitCommitDetail
    expect(commit).toMatchObject({
      hash: graph[0]?.hash,
      subject: '初始提交',
    })
    expect(commit.files).toEqual([
      expect.objectContaining({
        relativePath: 'src/main.ts',
        status: 'A',
        additions: 2,
        deletions: 0,
      }),
    ])

    await expect(
      callProjectService(registry, 'gitCommitFileDiff', {
        projectId: project.id,
        commitHash: graph[0]?.hash,
        relativePath: 'src/main.ts',
      }),
    ).resolves.toMatchObject({
      commitHash: graph[0]?.hash,
      relativePath: 'src/main.ts',
      mode: 'commit',
      patch: expect.stringContaining('diff --git a/src/main.ts b/src/main.ts'),
    })

    await callProjectService(registry, 'gitStage', {
      projectId: project.id,
      relativePaths: ['src/main.ts'],
    })
    const created = (await callProjectService(registry, 'gitCreateCommit', {
      projectId: project.id,
      message: '更新主逻辑',
    })) as { commitHash: string; summary: GitProjectSummary; graph: GitGraphCommit[] }
    expect(created.commitHash).toMatch(/^[a-f0-9]{40}$/u)
    expect(created.graph[0]).toMatchObject({ hash: created.commitHash, subject: '更新主逻辑' })
    expect(created.summary.files.map(file => file.relativePath)).toEqual([
      'notes.txt',
      'performance/report.txt',
    ])
    expect(await runGit(projectDirectory, ['show', '-s', '--format=%s', 'HEAD'])).toBe(
      '更新主逻辑\n',
    )
  })

  it('批量取消暂存复核确认时的状态并保留未解决的合并冲突', async () => {
    const root = temporaryDirectory('git-unstage-conflict')
    const conflict = join(root, 'conflict.txt')
    await runGit(root, ['init', '--initial-branch=main'])
    await runGit(root, ['config', 'user.name', '测试用户'])
    await runGit(root, ['config', 'user.email', 'test@example.invalid'])
    writeFileSync(conflict, '共同内容\n')
    writeFileSync(join(root, 'old.txt'), '用于测试重命名的内容\n')
    await runGit(root, ['add', '.'])
    await runGit(root, ['commit', '-m', '初始提交'])
    await runGit(root, ['switch', '-c', 'side'])
    writeFileSync(conflict, '另一侧内容\n')
    await runGit(root, ['commit', '-am', '另一侧修改'])
    await runGit(root, ['switch', 'main'])
    writeFileSync(conflict, '当前内容\n')
    await runGit(root, ['commit', '-am', '当前侧修改'])
    await expect(runGit(root, ['merge', 'side'])).rejects.toMatchObject({ code: 1 })
    const unmerged = await runGit(root, ['ls-files', '-u', '-z'])
    const conflictContent = readFileSync(conflict, 'utf8')
    expect(unmerged).not.toBe('')
    await runGit(root, ['mv', 'old.txt', 'new.txt'])

    const registry = new ProjectAccessRegistry()
    const project = await registerProject(registry, root)
    const payload = { projectId: project.id }
    const summarize = async () =>
      (await callProjectService(registry, 'gitSummary', payload)) as GitProjectSummary
    const original = await summarize()
    writeFileSync(join(root, 'later.txt'), '确认后才暂存\n')
    await runGit(root, ['add', 'later.txt'])
    const index = join(root, '.git', 'index')
    const staged = readFileSync(index)
    await expect(
      callProjectService(registry, 'gitUnstage', {
        ...payload,
        all: true,
        expectedStatusRevision: original.statusRevision,
      }),
    ).rejects.toThrow('Git 状态已变化')
    await expect(
      callProjectService(registry, 'gitUnstage', { ...payload, relativePaths: ['conflict.txt'] }),
    ).rejects.toThrow('未解决的 Git 冲突')
    expect(readFileSync(index)).toEqual(staged)

    const current = await summarize()
    const lock = `${index}.lock`
    writeFileSync(lock, '其他进程持有的索引锁')
    await expect(
      callProjectService(registry, 'gitUnstage', {
        ...payload,
        all: true,
        expectedStatusRevision: current.statusRevision,
      }),
    ).rejects.toThrow('Git 索引正被其他进程占用')
    expect(readFileSync(lock, 'utf8')).toBe('其他进程持有的索引锁')
    rmSync(lock)

    const result = (await callProjectService(registry, 'gitUnstage', {
      ...payload,
      all: true,
      expectedStatusRevision: current.statusRevision,
    })) as GitProjectSummary
    expect(result.files.filter(file => file.staged && !file.conflict)).toEqual([])
    expect(result.files.find(file => file.relativePath === 'conflict.txt')?.conflict).toBe(true)
    expect(await runGit(root, ['ls-files', '-u', '-z'])).toBe(unmerged)
    expect(readFileSync(conflict, 'utf8')).toBe(conflictContent)
    expect(readFileSync(join(root, 'new.txt'), 'utf8')).toBe('用于测试重命名的内容\n')
    expect(readFileSync(join(root, 'later.txt'), 'utf8')).toBe('确认后才暂存\n')
    expect(
      readdirSync(join(root, '.git')).filter(name => /^mydsh-unstage-|^index\.lock$/u.test(name)),
    ).toEqual([])
  })

  it('子目录项目按项目相对路径读取与暂存，拒绝 pathspec 访问项目外差异', async () => {
    const root = temporaryDirectory('git-subdirectory')
    const directory = join(root, 'sub')
    mkdirSync(directory)
    await runGit(root, ['init', '--initial-branch=main'])
    await runGit(root, ['config', 'user.name', '测试用户'])
    await runGit(root, ['config', 'user.email', 'test@example.invalid'])
    writeFileSync(join(root, 'outside.txt'), '原内容\n')
    writeFileSync(join(directory, 'inside.txt'), '原内容\n')
    await runGit(root, ['add', '.'])
    await runGit(root, ['commit', '-m', '初始提交'])
    writeFileSync(join(root, 'outside.txt'), '项目外内容\n')
    writeFileSync(join(directory, 'inside.txt'), '项目内内容\n')
    const registry = new ProjectAccessRegistry()
    const project = await registerProject(registry, directory)
    const payload = { projectId: project.id }
    const summary = (await callProjectService(registry, 'gitSummary', payload)) as GitProjectSummary
    expect(summary.files.map(file => file.relativePath)).toEqual(['inside.txt'])
    expect(summary).toMatchObject({ additions: 1, deletions: 1 })
    await expect(
      callProjectService(registry, 'gitDiff', {
        ...payload,
        relativePath: 'inside.txt',
        mode: 'working',
      }),
    ).resolves.toMatchObject({ patch: expect.stringContaining('+项目内内容') })
    await expect(
      callProjectService(registry, 'gitDiff', {
        ...payload,
        relativePath: ':(top)outside.txt',
        mode: 'working',
      }),
    ).resolves.toMatchObject({ patch: expect.not.stringContaining('项目外内容') })
    await callProjectService(registry, 'gitStage', { ...payload, relativePaths: ['inside.txt'] })
    expect(await runGit(root, ['diff', '--cached', '--name-only'])).toBe('sub/inside.txt\n')
    const commitHash = (await runGit(root, ['rev-parse', 'HEAD'])).trim()
    const detail = (await callProjectService(registry, 'gitCommit', {
      ...payload,
      commitHash,
    })) as GitCommitDetail
    expect(detail.files.map(file => file.relativePath)).toEqual(['inside.txt'])
    await expect(
      callProjectService(registry, 'gitCommitFileDiff', {
        ...payload,
        commitHash,
        relativePath: 'inside.txt',
      }),
    ).resolves.toMatchObject({
      patch: expect.stringContaining('diff --git a/inside.txt b/inside.txt'),
    })
  })

  it('拒绝越界暂存路径、空提交消息和空暂存区提交', async () => {
    const root = temporaryDirectory('git-write-boundary')
    const projectDirectory = join(root, 'workspace')
    mkdirSync(projectDirectory)
    await runGit(projectDirectory, ['init', '--initial-branch=main'])
    await runGit(projectDirectory, ['config', 'user.name', '测试用户'])
    await runGit(projectDirectory, ['config', 'user.email', 'test@example.invalid'])
    writeFileSync(join(projectDirectory, 'README.md'), '初始内容\n')
    await runGit(projectDirectory, ['add', 'README.md'])
    await runGit(projectDirectory, ['commit', '-m', '初始提交'])

    const registry = new ProjectAccessRegistry()
    const project = await registerProject(registry, projectDirectory)
    await expect(
      callProjectService(registry, 'gitStage', {
        projectId: project.id,
        relativePaths: ['../outside.txt'],
      }),
    ).rejects.toThrow('项目相对路径必须位于项目目录内')
    await expect(
      callProjectService(registry, 'gitCreateCommit', {
        projectId: project.id,
        message: '   ',
      }),
    ).rejects.toThrow('请输入 Git 提交消息')
    await expect(
      callProjectService(registry, 'gitCreateCommit', {
        projectId: project.id,
        message: '不应创建',
      }),
    ).rejects.toThrow('暂存区没有可提交的变更')
    expect(await runGit(projectDirectory, ['rev-list', '--count', 'HEAD'])).toBe('1\n')
  })

  it('识别重命名统计，并为删除与二进制文件提供明确 Diff 降级', async () => {
    const root = temporaryDirectory('git-edge-files')
    const projectDirectory = join(root, 'workspace')
    mkdirSync(projectDirectory)
    await runGit(projectDirectory, ['init', '--initial-branch=main'])
    await runGit(projectDirectory, ['config', 'user.name', '测试用户'])
    await runGit(projectDirectory, ['config', 'user.email', 'test@example.invalid'])
    writeFileSync(join(projectDirectory, '旧名称.txt'), '重命名内容\n')
    writeFileSync(join(projectDirectory, '待删除.txt'), '删除内容\n')
    writeFileSync(join(projectDirectory, '图像.bin'), Buffer.from([0, 1, 2, 3]))
    await runGit(projectDirectory, ['add', '.'])
    await runGit(projectDirectory, ['commit', '-m', '准备边界文件'])

    await runGit(projectDirectory, ['mv', '旧名称.txt', '新名称.txt'])
    rmSync(join(projectDirectory, '待删除.txt'))
    writeFileSync(join(projectDirectory, '图像.bin'), Buffer.from([0, 1, 2, 4]))
    writeFileSync(join(projectDirectory, '未跟踪.bin'), Buffer.from([0, 8, 9]))

    const registry = new ProjectAccessRegistry()
    const project = await registerProject(registry, projectDirectory)
    const summary = (await callProjectService(registry, 'gitSummary', {
      projectId: project.id,
    })) as GitProjectSummary

    expect(summary.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relativePath: '新名称.txt',
          originalPath: '旧名称.txt',
          indexStatus: 'R',
          binary: false,
        }),
        expect.objectContaining({
          relativePath: '待删除.txt',
          workingTreeStatus: 'D',
          binary: false,
        }),
        expect.objectContaining({
          relativePath: '图像.bin',
          workingTreeStatus: 'M',
          binary: true,
        }),
      ]),
    )

    await expect(
      callProjectService(registry, 'gitDiff', {
        projectId: project.id,
        relativePath: '待删除.txt',
        mode: 'working',
      }),
    ).resolves.toMatchObject({
      presentation: 'text',
      patch: expect.stringContaining('deleted file mode'),
    })
    await expect(
      callProjectService(registry, 'gitDiff', {
        projectId: project.id,
        relativePath: '图像.bin',
        mode: 'working',
      }),
    ).resolves.toMatchObject({
      presentation: 'binary',
      patch: '',
      message: '这是二进制文件，桌面端不生成文本 Diff。',
    })
    await expect(
      callProjectService(registry, 'gitDiff', {
        projectId: project.id,
        relativePath: '未跟踪.bin',
        mode: 'working',
      }),
    ).resolves.toMatchObject({
      presentation: 'binary',
      patch: '',
      message: '这是二进制或非 UTF-8 文件，桌面端不生成文本 Diff。',
    })
  })

  it('对非 Git 项目返回明确的降级结果', async () => {
    const root = temporaryDirectory('not-git')
    const projectDirectory = join(root, 'workspace')
    mkdirSync(projectDirectory)
    const registry = new ProjectAccessRegistry()
    const project = await registerProject(registry, projectDirectory)

    await expect(
      callProjectService(registry, 'gitSummary', {
        projectId: project.id,
      }),
    ).resolves.toEqual({
      available: false,
      branch: null,
      upstream: null,
      ahead: 0,
      behind: 0,
      files: [],
      additions: 0,
      deletions: 0,
      message: '当前项目不是可读取的 Git 工作区',
    })
    await expect(
      callProjectService(registry, 'gitGraph', {
        projectId: project.id,
      }),
    ).resolves.toEqual([])
  })
})
