// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ConfigProvider } from 'antd'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditorState } from '@codemirror/state'
import { java } from '@codemirror/lang-java'
import { markdown } from '@codemirror/lang-markdown'

import { RunConfigurationsPanel } from '../src/renderer/src/features/files/RunConfigurationsPanel.tsx'
import { FileLeftPanel } from '../src/renderer/src/pages/workspace/components/leftpanel/file-leftpanel/index.tsx'
import { FileViewer } from '../src/renderer/src/features/files/FileViewer.tsx'
import { describeFileIcon } from '../src/renderer/src/features/files/file-icon-registry.ts'
import { outlineFromEditorState } from '../src/renderer/src/features/files/code-outline.ts'
import {
  parsePackageRunConfigurations,
  type ProjectFile,
} from '../src/renderer/src/features/project-workspace/project-types.ts'
import type { GitSummary } from '../src/renderer/src/features/source-control/source-control-types.ts'
import { GitGraphPanel } from '../src/renderer/src/features/source-control/GitGraphPanel.tsx'
import { ChangesLeftPanel } from '../src/renderer/src/features/source-control/ChangesLeftPanel.tsx'
import { SourceControlView } from '../src/renderer/src/features/source-control/SourceControlView.tsx'

const useProjectWorkspaceMock = vi.hoisted(() => vi.fn())
const useSourceControlMock = vi.hoisted(() => vi.fn())
const useWorkspaceTabsMock = vi.hoisted(() => vi.fn<() => unknown>(() => null))
const workspaceStoreMock = vi.hoisted(() => ({
  selectedProject: vi.fn(() => undefined as { id: string; projectAccessId?: string } | undefined),
  setView: vi.fn(),
}))

vi.mock('../src/renderer/src/features/project-workspace/ProjectWorkspaceProvider.tsx', () => ({
  useProjectWorkspace: useProjectWorkspaceMock,
}))
vi.mock('../src/renderer/src/features/source-control/SourceControlProvider.tsx', () => ({
  useSourceControl: useSourceControlMock,
}))
vi.mock('../src/renderer/src/features/workspace-tabs/WorkspaceTabsProvider.tsx', () => ({
  useWorkspaceTabs: useWorkspaceTabsMock,
}))
vi.mock('../src/renderer/src/hooks/useWorkspace.ts', () => ({
  useWorkspaceStore: () => workspaceStoreMock,
}))

vi.mock('../src/renderer/src/features/files/CodeEditor.tsx', () => ({
  default: ({
    content,
    onChange,
    onSave,
  }: {
    content: string
    onChange(content: string): void
    onSave(): void
  }) => (
    <textarea
      aria-label="测试代码编辑器"
      value={content}
      onChange={event => {
        onChange(event.currentTarget.value)
      }}
      onKeyDown={event => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
          event.preventDefault()
          onSave()
        }
      }}
    />
  ),
}))

const projectFile = (content: string): ProjectFile => ({
  kind: 'text',
  relativePath: 'package.json',
  content,
  revision: `sha256:${'0'.repeat(64)}`,
  byteLength: content.length,
  lineCount: 1,
  language: 'json',
})

afterEach(() => {
  cleanup()
  delete window.dshDesktop
  useProjectWorkspaceMock.mockReset()
  useSourceControlMock.mockReset()
  useWorkspaceTabsMock.mockReset()
  useWorkspaceTabsMock.mockReturnValue(null)
  workspaceStoreMock.selectedProject.mockReset()
  workspaceStoreMock.selectedProject.mockReturnValue(undefined)
  workspaceStoreMock.setView.mockReset()
})

describe('项目运行配置投影', () => {
  it('只从真实 package.json scripts 生成只读 npm 配置', () => {
    const projection = parsePackageRunConfigurations(
      projectFile(
        JSON.stringify({
          name: '桌面项目',
          scripts: { dev: 'vite', build: 'tsc && vite build', invalid: 3 },
        }),
      ),
    )

    expect(projection).toEqual({
      available: true,
      source: 'package.json',
      packageName: '桌面项目',
      configurations: [
        { id: 'npm:dev', name: 'dev', script: 'vite', command: 'npm run dev' },
        { id: 'npm:build', name: 'build', script: 'tsc && vite build', command: 'npm run build' },
      ],
    })

    render(
      <RunConfigurationsPanel
        projection={projection}
        loading={false}
        error={null}
        onRefresh={() => {}}
      />,
    )
    expect(screen.getByRole('heading', { name: '运行配置' })).toBeTruthy()
    expect(screen.getByText('npm run dev')).toBeTruthy()
    expect(screen.getByText('vite')).toBeTruthy()
    const runButtons = screen.getAllByTitle('执行能力尚未接入') as HTMLButtonElement[]
    expect(runButtons).toHaveLength(2)
    expect(runButtons.every(button => button.disabled)).toBe(true)
    expect(screen.getByText('当前仅展示真实配置；运行、停止与调试尚未接入。')).toBeTruthy()
  })

  it('解析失败时安全降级，不虚构配置', () => {
    expect(parsePackageRunConfigurations(projectFile('{broken'))).toMatchObject({
      available: false,
      configurations: [],
      message: 'package.json 不是有效的 JSON，无法读取运行配置。',
    })
  })
})

describe('项目内容搜索生命周期', () => {
  it('文件面板刷新后保留已输入的查询，并继续呈现真实搜索结果', async () => {
    const searchContent = vi.fn().mockResolvedValue({
      items: [
        {
          relativePath: 'src/main.ts',
          line: 2,
          column: 4,
          preview: '中文注释',
        },
      ],
      hasMore: false,
    })
    const workspace = {
      directories: { '': { relativePath: '', entries: [] } },
      expandedDirectories: new Set(['']),
      selectedFile: null,
      loading: false,
      error: null,
      fileIndexStatus: { phase: 'ready', fileCount: 0 },
      openFiles: [],
      recentFiles: [],
      treeScrollLeft: 0,
      treeScrollTop: 0,
      openFile: vi.fn(),
      openPinnedFile: vi.fn(),
      toggleDirectory: vi.fn(),
      updateTreeScroll: vi.fn(),
      refresh: vi.fn(),
      cancelContentSearch: vi.fn(),
      searchContent,
    }
    useProjectWorkspaceMock.mockReturnValue(workspace)
    const view = render(<FileLeftPanel />)
    fireEvent.click(screen.getByRole('button', { name: /搜索项目内容/u }))
    const input = (await screen.findByRole('searchbox')) as HTMLInputElement
    fireEvent.change(input, { target: { value: '中文注释' } })
    useProjectWorkspaceMock.mockReturnValue({ ...workspace, loading: true })
    view.rerender(<FileLeftPanel />)
    expect(input.value).toBe('中文注释')
    await waitFor(() => {
      expect(searchContent).toHaveBeenCalledWith('中文注释', false)
    })
    expect(await screen.findByText('中文注释', { selector: 'code' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '关闭项目内容搜索' }))
    expect(screen.queryByRole('searchbox')).toBeNull()
  })
})

describe('项目图片查看器', () => {
  it('按无路径图片投影显示原始图片字节，不进入代码编辑器', () => {
    useProjectWorkspaceMock.mockReturnValue({
      selectedFile: {
        kind: 'image',
        relativePath: 'assets/大图.png',
        mediaType: 'image/png',
        base64: 'iVBORw0KGgo=',
        byteLength: 2_500_000,
      },
      selectedLine: null,
      openFiles: [{ relativePath: 'assets/大图.png', pinned: false }],
      fileDirty: false,
      canNavigateBack: false,
      canNavigateForward: false,
      navigateFileHistory: vi.fn(),
      selectFileTab: vi.fn(),
      pinFile: vi.fn(),
      closeFileTab: vi.fn(),
      revealDirectory: vi.fn(),
    })

    render(<FileViewer />)
    const image = screen.getByRole('img', { name: 'assets/大图.png' }) as HTMLImageElement
    expect(image.src).toBe('data:image/png;base64,iVBORw0KGgo=')
    expect(screen.getByLabelText('文件查看器').getAttribute('data-file-path')).toBe(
      'assets/大图.png',
    )
    expect(screen.getByLabelText('文件状态与操作').textContent).toContain('image/png')
    expect(document.querySelector('.code-editor')).toBeNull()
  })
})

describe('项目代码编辑器', () => {
  it('文件空态指向左侧文件树，不再创建右侧文件列表', () => {
    useProjectWorkspaceMock.mockReturnValue({ selectedFile: null, fileDirty: false })
    render(<FileViewer />)
    expect(screen.getByText('从左侧文件树选择文件')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '打开文件列表' })).toBeNull()
  })

  it('从当前语法树提取类、方法与 Markdown 标题大纲', () => {
    const javaState = EditorState.create({
      doc: 'public class MealService {\n  public void start() {}\n}\n',
      extensions: [java()],
    })
    expect(outlineFromEditorState(javaState)).toEqual([
      expect.objectContaining({ label: 'MealService', kind: 'class', line: 1, depth: 0 }),
      expect.objectContaining({ label: 'start', kind: 'method', line: 2, depth: 1 }),
    ])
    const markdownState = EditorState.create({
      doc: '# 项目\n## 使用方法\n',
      extensions: [markdown()],
    })
    expect(outlineFromEditorState(markdownState)).toEqual([
      expect.objectContaining({ label: '项目', kind: 'heading', line: 1, depth: 0 }),
      expect.objectContaining({ label: '使用方法', kind: 'heading', line: 2, depth: 1 }),
    ])
  })

  it('显示脏状态、显式保存并要求用户处理外部修改冲突', async () => {
    const saveFile = vi.fn().mockResolvedValue(false)
    const dismissFileConflict = vi.fn()
    const reloadSelectedFile = vi.fn()
    const discardFileChanges = vi.fn()
    const updateFileDraft = vi.fn()
    useProjectWorkspaceMock.mockReturnValue({
      selectedFile: projectFile('磁盘内容\n'),
      selectedLine: null,
      fileDraft: '本地草稿\n',
      fileDirty: true,
      fileSaving: false,
      fileConflict: {
        status: 'conflict',
        relativePath: 'package.json',
        currentRevision: `sha256:${'1'.repeat(64)}`,
        currentByteLength: 20,
      },
      updateFileDraft,
      saveFile,
      reloadSelectedFile,
      discardFileChanges,
      dismissFileConflict,
      openFiles: [{ relativePath: 'package.json', pinned: true }],
      canNavigateBack: false,
      canNavigateForward: false,
      navigateFileHistory: vi.fn(),
      selectFileTab: vi.fn(),
      pinFile: vi.fn(),
      closeFileTab: vi.fn(),
      revealDirectory: vi.fn(),
    })

    render(<FileViewer />)
    expect(await screen.findByText('未保存')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(saveFile).toHaveBeenCalledWith()
    fireEvent.click(screen.getByRole('button', { name: '仍然覆盖' }))
    expect(saveFile).toHaveBeenLastCalledWith(`sha256:${'1'.repeat(64)}`)
    fireEvent.click(screen.getByRole('button', { name: '重新载入' }))
    expect(reloadSelectedFile).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(dismissFileConflict).toHaveBeenCalledTimes(1)
  })

  it('把文件历史与编辑状态放在底栏，文件标签由工作区顶部承载', () => {
    const navigateFileHistory = vi.fn()
    const selectFileTab = vi.fn()
    const pinFile = vi.fn()
    const closeFileTab = vi.fn()
    const revealDirectory = vi.fn()
    useProjectWorkspaceMock.mockReturnValue({
      selectedFile: {
        ...projectFile('export const answer = 42\n'),
        relativePath: 'src/main.ts',
        language: 'typescript',
      },
      selectedLine: null,
      fileDraft: 'export const answer = 42\n',
      fileDirty: false,
      fileSaving: false,
      fileConflict: null,
      openFiles: [
        { relativePath: 'README.md', pinned: true },
        { relativePath: 'src/main.ts', pinned: false },
      ],
      canNavigateBack: true,
      canNavigateForward: true,
      navigateFileHistory,
      selectFileTab,
      pinFile,
      closeFileTab,
      revealDirectory,
      updateFileDraft: vi.fn(),
      saveFile: vi.fn(),
      reloadSelectedFile: vi.fn(),
      discardFileChanges: vi.fn(),
      dismissFileConflict: vi.fn(),
    })

    render(<FileViewer />)
    fireEvent.click(screen.getByRole('button', { name: '返回上一个文件' }))
    fireEvent.click(screen.getByRole('button', { name: '前进到下一个文件' }))
    expect(navigateFileHistory.mock.calls).toEqual([[-1], [1]])
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.queryByText('代码编辑器')).toBeNull()
    expect(screen.getByLabelText('文件查看器').getAttribute('data-file-path')).toBe('src/main.ts')
    expect(screen.getByRole('navigation', { name: '文件路径：src/main.ts' })).toBeTruthy()
    expect(screen.getByLabelText('文件状态与操作').textContent).toContain('行 1，列 1')
    expect(screen.getByLabelText('文件状态与操作').textContent).toContain('typescript')
  })
})

describe('项目文件 Quick Open', () => {
  it('通过快捷键搜索索引并用键盘打开文件', async () => {
    const user = userEvent.setup()
    const queryFiles = vi.fn().mockResolvedValue({
      items: [
        {
          relativePath: 'src/main.ts',
          name: 'main.ts',
          directory: 'src',
        },
      ],
      hasMore: false,
    })
    const openFile = vi.fn().mockResolvedValue(undefined)
    useProjectWorkspaceMock.mockReturnValue({
      directories: { '': { relativePath: '', entries: [], truncated: false } },
      expandedDirectories: new Set(['']),
      fileIndexStatus: { phase: 'ready', fileCount: 1 },
      loading: false,
      error: null,
      refresh: vi.fn(),
      toggleDirectory: vi.fn(),
      buildFileIndex: vi.fn().mockResolvedValue(undefined),
      queryFiles,
      openFile,
      pinFile: vi.fn(),
      treeScrollLeft: 0,
      treeScrollTop: 0,
      updateTreeScroll: vi.fn(),
    })

    render(<FileLeftPanel />)
    fireEvent.keyDown(document, { key: 'p', metaKey: true })
    const input = await screen.findByRole('combobox', { name: '文件名或相对路径' })
    await user.type(input, 'main')
    await waitFor(() => {
      expect(queryFiles).toHaveBeenLastCalledWith('main')
    })
    expect(await screen.findByRole('option', { name: /main\.ts/u })).toBeTruthy()
    await user.keyboard('{Enter}')
    expect(openFile).toHaveBeenCalledWith('src/main.ts')
    expect(screen.queryByRole('dialog', { name: '快速打开文件' })).toBeNull()
  })
})

describe('项目文件树类型与深层滚动', () => {
  it('通过单一注册表区分常见目录、语言和敏感文件，并为未知类型稳定回退', () => {
    expect(describeFileIcon({ name: 'src', relativePath: 'src', kind: 'directory' })).toMatchObject(
      { icon: 'folder-source', tone: 'source', label: '源代码文件夹' },
    )
    expect(
      describeFileIcon({ name: 'tests', relativePath: 'tests', kind: 'directory' }),
    ).toMatchObject({ icon: 'folder-test', tone: 'test' })
    expect(
      describeFileIcon({ name: 'secrets', relativePath: 'secrets', kind: 'directory' }),
    ).toMatchObject({ icon: 'folder-sensitive', tone: 'sensitive' })
    expect(
      describeFileIcon({
        name: 'ConversationView.tsx',
        relativePath: 'src/ConversationView.tsx',
        kind: 'file',
      }),
    ).toMatchObject({ icon: 'react', label: 'React TypeScript 文件' })
    expect(
      describeFileIcon({ name: '.env.local', relativePath: '.env.local', kind: 'file' }),
    ).toMatchObject({ icon: 'lock', tone: 'sensitive', glyph: 'ENV' })
    expect(
      describeFileIcon({
        name: 'artifact.unknown',
        relativePath: 'artifact.unknown',
        kind: 'file',
      }),
    ).toEqual({ icon: 'file', tone: 'muted', label: '文件' })
  })

  it('为文件树条目保留完整路径、类型标记和当前选择', () => {
    const openPinnedFile = vi.fn()
    useProjectWorkspaceMock.mockReturnValue({
      directories: {
        '': {
          relativePath: '',
          truncated: false,
          entries: [{ name: 'src', relativePath: 'src', kind: 'directory' }],
        },
        src: {
          relativePath: 'src',
          truncated: false,
          entries: [
            {
              name: 'ConversationView.tsx',
              relativePath: 'src/ConversationView.tsx',
              kind: 'file',
            },
          ],
        },
      },
      expandedDirectories: new Set(['', 'src']),
      selectedFile: { relativePath: 'src/ConversationView.tsx' },
      fileIndexStatus: { phase: 'ready', fileCount: 1 },
      loading: false,
      error: null,
      refresh: vi.fn(),
      toggleDirectory: vi.fn(),
      buildFileIndex: vi.fn(),
      queryFiles: vi.fn(),
      openFile: vi.fn(),
      pinFile: vi.fn(),
      openPinnedFile,
      treeScrollLeft: 0,
      treeScrollTop: 0,
      updateTreeScroll: vi.fn(),
    })

    const { container } = render(<FileLeftPanel />)
    const source = container.querySelector('[data-icon="folder-source"]')
    const selected = container.querySelector('.tree-row.is-selected')
    expect(source?.getAttribute('data-tone')).toBe('source')
    expect(selected?.getAttribute('title')).toBe('src/ConversationView.tsx')
    expect(selected?.getAttribute('aria-current')).toBe('page')
    expect(selected?.querySelector('[data-icon="react"] svg')).toBeTruthy()
    if (selected === null) throw new Error('测试文件树缺少选中文件')
    fireEvent.doubleClick(selected)
    expect(openPinnedFile).toHaveBeenCalledWith('src/ConversationView.tsx')
  })

  it('空项目显示友好空态，可预览文件支持悬浮图标与右键打开内置浏览器，PDF 单击直开浏览器', async () => {
    const openFile = vi.fn().mockResolvedValue(undefined)
    const openPinnedFile = vi.fn().mockResolvedValue(undefined)
    const openBrowserFile = vi.fn().mockResolvedValue(true)
    window.dshDesktop = { browser: { request: vi.fn(), onChanged: vi.fn(() => () => {}) } } as never
    workspaceStoreMock.selectedProject.mockReturnValue({
      id: 'project:demo',
      projectAccessId: '0123456789abcdef01234567',
    })
    useWorkspaceTabsMock.mockReturnValue({ openBrowserFile })
    useProjectWorkspaceMock.mockReturnValue({
      directories: {
        '': { relativePath: '', truncated: false, entries: [] },
      },
      expandedDirectories: new Set(['']),
      selectedFile: null,
      fileIndexStatus: { phase: 'ready', fileCount: 0 },
      loading: false,
      error: null,
      refresh: vi.fn(),
      toggleDirectory: vi.fn(),
      buildFileIndex: vi.fn(),
      queryFiles: vi.fn(),
      openFile,
      pinFile: vi.fn(),
      openPinnedFile,
      treeScrollLeft: 0,
      treeScrollTop: 0,
      updateTreeScroll: vi.fn(),
    })

    const view = render(<FileLeftPanel />)
    expect(screen.getByText('当前项目目录为空。')).toBeTruthy()

    useProjectWorkspaceMock.mockReturnValue({
      directories: {
        '': {
          relativePath: '',
          truncated: false,
          entries: [
            { name: 'index.html', relativePath: 'index.html', kind: 'file' },
            { name: 'manual.pdf', relativePath: 'manual.pdf', kind: 'file' },
          ],
        },
      },
      expandedDirectories: new Set(['']),
      selectedFile: null,
      fileIndexStatus: { phase: 'ready', fileCount: 2 },
      loading: false,
      error: null,
      refresh: vi.fn(),
      toggleDirectory: vi.fn(),
      buildFileIndex: vi.fn(),
      queryFiles: vi.fn(),
      openFile,
      pinFile: vi.fn(),
      openPinnedFile,
      treeScrollLeft: 0,
      treeScrollTop: 0,
      updateTreeScroll: vi.fn(),
    })
    view.rerender(<FileLeftPanel />)

    fireEvent.click(screen.getByRole('button', { name: '在内置浏览器中打开 index.html' }))
    await waitFor(() => {
      expect(openBrowserFile).toHaveBeenCalledWith({
        projectId: 'project:demo',
        projectAccessId: '0123456789abcdef01234567',
        relativePath: 'index.html',
      })
      expect(workspaceStoreMock.setView).toHaveBeenCalledWith('browser')
    })

    fireEvent.click(screen.getByRole('button', { name: 'manual.pdf，文件' }))
    await waitFor(() => {
      expect(openBrowserFile).toHaveBeenLastCalledWith({
        projectId: 'project:demo',
        projectAccessId: '0123456789abcdef01234567',
        relativePath: 'manual.pdf',
      })
    })
    expect(openFile).not.toHaveBeenCalled()

    const htmlRow = screen.getByRole('button', { name: 'index.html，HTML 文件' })
    fireEvent.contextMenu(htmlRow)
    fireEvent.click(await screen.findByRole('menuitem', { name: '在内置浏览器中打开' }))
    await waitFor(() => {
      expect(openBrowserFile).toHaveBeenCalledTimes(3)
    })
  })

  it('FileViewer 底栏为 HTML 等可预览文件提供在内置浏览器中打开按钮', async () => {
    const openBrowserFile = vi.fn().mockResolvedValue(true)
    window.dshDesktop = { browser: { request: vi.fn(), onChanged: vi.fn(() => () => {}) } } as never
    workspaceStoreMock.selectedProject.mockReturnValue({
      id: 'project:demo',
      projectAccessId: '0123456789abcdef01234567',
    })
    useWorkspaceTabsMock.mockReturnValue({ openBrowserFile })
    useProjectWorkspaceMock.mockReturnValue({
      selectedFile: {
        ...projectFile('<h1>Hello</h1>'),
        relativePath: 'preview/index.html',
        language: 'html',
      },
      selectedLine: null,
      fileDraft: '<h1>Hello</h1>',
      fileDirty: false,
      fileSaving: false,
      fileConflict: null,
      openFiles: [{ relativePath: 'preview/index.html', pinned: false }],
      canNavigateBack: false,
      canNavigateForward: false,
      navigateFileHistory: vi.fn(),
      selectFileTab: vi.fn(),
      pinFile: vi.fn(),
      closeFileTab: vi.fn(),
      revealDirectory: vi.fn(),
      updateFileDraft: vi.fn(),
      saveFile: vi.fn(),
      reloadSelectedFile: vi.fn(),
      discardFileChanges: vi.fn(),
      dismissFileConflict: vi.fn(),
    })

    render(<FileViewer />)
    fireEvent.click(screen.getByRole('button', { name: '在内置浏览器中打开' }))
    await waitFor(() => {
      expect(openBrowserFile).toHaveBeenCalledWith({
        projectId: 'project:demo',
        projectAccessId: '0123456789abcdef01234567',
        relativePath: 'preview/index.html',
      })
      expect(workspaceStoreMock.setView).toHaveBeenCalledWith('browser')
    })
  })
})

describe('Git 上下文面板', () => {
  it('在右栏展示真实分支、同步状态、装饰与提交信息', async () => {
    const user = userEvent.setup()
    const onSelectCommit = vi.fn()
    const summary: GitSummary = {
      available: true,
      branch: 'dev',
      upstream: 'origin/dev',
      ahead: 2,
      behind: 1,
      files: [],
      additions: 0,
      deletions: 0,
    }
    const onCloseCommit = vi.fn()
    const onOpenCommitFile = vi.fn()
    const { container, rerender } = render(
      <GitGraphPanel
        summary={summary}
        commits={[
          {
            hash: '8f31c2a000',
            shortHash: '8f31c2a',
            parents: ['parent-a', 'parent-b'],
            decorations: ['HEAD -> dev'],
            author: 'Luna',
            time: 1,
            subject: '完善 Host 身份校验',
          },
        ]}
        loading={false}
        error={null}
        selectedCommit={null}
        selectedCommitFile={null}
        onRefresh={() => {}}
        onSelectCommit={onSelectCommit}
        onCloseCommit={onCloseCommit}
        onOpenCommitFile={onOpenCommitFile}
      />,
    )

    expect(screen.getByRole('heading', { name: 'Git 图' })).toBeTruthy()
    expect(screen.getByText('origin/dev')).toBeTruthy()
    expect(screen.getByText('↑ 2 · ↓ 1')).toBeTruthy()
    expect(screen.getByText('完善 Host 身份校验')).toBeTruthy()
    expect(container.querySelector('.git-reference--head')?.textContent).toBe('HEAD')
    expect(container.querySelector('.git-reference--local')?.textContent).toBe('dev')
    expect(container.querySelector('.git-graph-rail')?.getAttribute('data-parent-count')).toBe('2')
    expect(container.querySelectorAll('[data-edge-kind="parent"]')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: /完善 Host 身份校验/u }))
    expect(onSelectCommit).toHaveBeenCalledWith('8f31c2a000')

    rerender(
      <GitGraphPanel
        summary={summary}
        commits={[
          {
            hash: '8f31c2a000',
            shortHash: '8f31c2a',
            parents: ['parent-a', 'parent-b'],
            decorations: ['HEAD -> dev'],
            author: 'Luna',
            time: 1,
            subject: '完善 Host 身份校验',
          },
        ]}
        loading={false}
        error={null}
        selectedCommit={{
          hash: '8f31c2a000',
          shortHash: '8f31c2a',
          parents: ['parent-a', 'parent-b'],
          decorations: ['HEAD -> dev'],
          author: 'Luna',
          time: 1,
          subject: '完善 Host 身份校验',
          files: [
            { relativePath: 'README.md', status: 'M', additions: 4, deletions: 2, binary: false },
            {
              relativePath: 'src/main/index.ts',
              status: 'A',
              additions: 12,
              deletions: 0,
              binary: false,
            },
            {
              relativePath:
                'Ry-console/ruoyi-modules/src/main/java/com/ruoyi/security/ThreatDetectionController.java',
              status: 'M',
              additions: 3,
              deletions: 1,
              binary: false,
            },
          ],
        }}
        selectedCommitFile={null}
        onRefresh={() => {}}
        onSelectCommit={onSelectCommit}
        onCloseCommit={onCloseCommit}
        onOpenCommitFile={onOpenCommitFile}
      />,
    )
    const fileList = screen.getByRole('list', { name: '提交文件' })
    expect(fileList.children).toHaveLength(3)
    expect(fileList.querySelector('ul, [aria-expanded]')).toBeNull()
    const commitFile = screen.getByRole('button', { name: '查看提交中的 src/main/index.ts' })
    expect(commitFile.querySelector('.git-commit-file-name')?.textContent).toBe('index.ts')
    expect(commitFile.querySelector('.git-commit-file-directory')?.textContent).toBe('src/main')
    expect(commitFile.getAttribute('title')).toBe('src/main/index.ts')
    commitFile.focus()
    await user.keyboard('{Enter}')
    expect(onOpenCommitFile).toHaveBeenCalledWith('8f31c2a000', 'src/main/index.ts')
    expect(document.activeElement).toBe(commitFile)
    const deepPath = 'Ry-console/ruoyi-modules/src/main/java/com/ruoyi/security'
    const deepFile = screen.getByRole('button', {
      name: `查看提交中的 ${deepPath}/ThreatDetectionController.java`,
    })
    expect(deepFile.querySelector('.git-commit-file-name')?.textContent).toBe(
      'ThreatDetectionController.java',
    )
    expect(deepFile.querySelector('.git-commit-file-directory')?.textContent).toBe(deepPath)
    expect(deepFile.querySelector('.git-file-status')?.textContent).toBe('M')
    expect(deepFile.querySelector('.git-file-status')?.getAttribute('title')).toBe(
      '新增 3 行，删除 1 行',
    )
    deepFile.focus()
    await user.keyboard('{Enter}')
    expect(onOpenCommitFile).toHaveBeenLastCalledWith(
      '8f31c2a000',
      `${deepPath}/ThreatDetectionController.java`,
    )
    fireEvent.click(screen.getByRole('button', { name: /完善 Host 身份校验/u }))
    expect(onCloseCommit).toHaveBeenCalledTimes(1)
  })
})

describe('Source Control 暂存与提交', () => {
  it('把部分暂存文件投影到两组，并串通单文件动作与提交输入', async () => {
    const openDiff = vi.fn()
    const stageChanges = vi.fn().mockResolvedValue(true)
    const unstageChanges = vi.fn().mockResolvedValue(true)
    const commitStaged = vi.fn().mockResolvedValue(true)
    useSourceControlMock.mockReturnValue({
      ai: { phase: 'normal', enter: vi.fn() },
      gitGraph: [],
      selectedCommit: null,
      gitSummary: {
        available: true,
        branch: 'dev',
        upstream: 'origin/dev',
        ahead: 2,
        behind: 0,
        additions: 5,
        deletions: 3,
        statusRevision: `sha256:${'0'.repeat(64)}`,
        files: [
          {
            relativePath: 'src/main.ts',
            indexStatus: 'M',
            workingTreeStatus: 'M',
            staged: true,
            conflict: false,
            additions: 5,
            deletions: 3,
            binary: false,
            stagedAdditions: 2,
            stagedDeletions: 1,
            stagedBinary: false,
            workingAdditions: 3,
            workingDeletions: 2,
            workingBinary: false,
          },
        ],
      },
      loading: false,
      gitMutation: null,
      error: null,
      selectedDiff: { mode: 'staged', relativePath: 'src/main.ts' },
      openDiff,
      stageChanges,
      unstageChanges,
      commitStaged,
    })

    const view = render(<ChangesLeftPanel />, {
      wrapper: ({ children }) => (
        <ConfigProvider theme={{ token: { motion: false } }}>{children}</ConfigProvider>
      ),
    })
    expect(screen.getByText('暂存的更改').parentElement?.textContent).toContain('1')
    expect(screen.getByRole('button', { name: /^更改$/u }).textContent).toContain('1')
    expect(screen.getAllByText('main.ts')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: '暂存的更改' }))
    expect(screen.queryByRole('button', { name: '查看 src/main.ts 的暂存区 Git Diff' })).toBeNull()
    expect(screen.getByRole('button', { name: '查看 src/main.ts 的工作区 Git Diff' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '更改' }))
    expect(screen.queryByRole('button', { name: '查看 src/main.ts 的工作区 Git Diff' })).toBeNull()
    expect(stageChanges).not.toHaveBeenCalled()
    expect(unstageChanges).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '暂存的更改' }))
    fireEvent.click(screen.getByRole('button', { name: '更改' }))
    expect(
      screen
        .getByRole('button', { name: '查看 src/main.ts 的暂存区 Git Diff' })
        .getAttribute('aria-current'),
    ).toBe('true')
    expect(
      screen
        .getByRole('button', { name: '查看 src/main.ts 的工作区 Git Diff' })
        .hasAttribute('aria-current'),
    ).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '查看 src/main.ts 的暂存区 Git Diff' }))
    expect(openDiff).toHaveBeenCalledWith('src/main.ts', 'staged')
    fireEvent.click(screen.getByRole('button', { name: '暂存 src/main.ts' }))
    expect(stageChanges).toHaveBeenCalledWith(['src/main.ts'])
    fireEvent.click(screen.getByRole('button', { name: '取消暂存 src/main.ts' }))
    expect(unstageChanges).toHaveBeenCalledWith(['src/main.ts'])
    unstageChanges.mockClear()

    fireEvent.click(screen.getByRole('button', { name: '取消暂存全部更改' }))
    expect(await screen.findByRole('dialog', { name: '取消全部暂存？' })).toBeTruthy()
    expect(unstageChanges).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '返回' }))
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '取消全部暂存？' })).toBeNull()
    })
    expect(unstageChanges).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '取消暂存全部更改' }))
    fireEvent.click(await screen.findByRole('button', { name: '确认取消暂存' }))
    await waitFor(() => {
      expect(unstageChanges).toHaveBeenCalledExactlyOnceWith(undefined, `sha256:${'0'.repeat(64)}`)
      expect(screen.getByText('已取消全部暂存。工作区文件未改动。')).toBeTruthy()
    })

    const input = screen.getByLabelText('提交消息') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: '完成 Source Control' } })
    fireEvent.click(screen.getByRole('button', { name: '提交暂存的更改 (1)' }))
    await waitFor(() => {
      expect(commitStaged).toHaveBeenCalledWith('完成 Source Control')
    })
    await waitFor(() => {
      expect(input.value).toBe('')
    })
    expect(screen.getByText('已创建本地 Git 提交。')).toBeTruthy()
    view.rerender(<ChangesLeftPanel showCommitForm={false} />)
    expect(screen.queryByLabelText('提交消息')).toBeNull()
    expect(screen.queryByText('未提交的变更')).toBeNull()
    expect(screen.queryByRole('button', { name: '刷新 Git 状态' })).toBeNull()
    expect(screen.getAllByText('main.ts')).toHaveLength(2)
  })
})

describe('Diff 自适应契约', () => {
  it('并排配对代码并强调修改字符，切换行内后仍有增删与比较来源', async () => {
    useSourceControlMock.mockReturnValue({
      gitSummary: { available: true },
      selectedCommit: null,
      selectedDiff: {
        relativePath: 'src/main.ts',
        mode: 'staged',
        presentation: 'text',
        truncated: false,
        patch:
          'diff --git a/src/main.ts b/src/main.ts\nindex 111..222 100644\n--- a/src/main.ts\n+++ b/src/main.ts\n@@ -1,2 +1,2 @@\n---count;\n+++count;\n const timeout = 5000;\n',
      },
    })
    const { container } = render(<SourceControlView />)
    expect(container.textContent).not.toContain('diff --git')
    expect(screen.getByText('旧版 · HEAD')).toBeTruthy()
    expect(screen.getByText('新版 · 暂存区')).toBeTruthy()
    const replacement = container.querySelector('.diff-pair')!
    expect([...replacement.querySelectorAll('code')].map(code => code.textContent)).toEqual([
      '--count;',
      '++count;',
    ])
    expect(
      [...replacement.querySelectorAll('.diff-text-change')].map(mark => mark.textContent),
    ).toEqual(['--', '++'])
    await waitFor(() => {
      expect(container.querySelector('.tok-keyword')).toBeTruthy()
    })
    fireEvent.click(screen.getByRole('button', { name: '行内' }))
    expect(screen.getByRole('button', { name: '行内' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: '并排' }).getAttribute('aria-pressed')).toBe('false')
    expect(
      container.querySelector('.diff-inline .diff-row--addition .diff-sign')?.textContent,
    ).toBe('+')
    expect(
      container.querySelector('.diff-inline .diff-row--deletion .diff-sign')?.textContent,
    ).toBe('−')
  })

  it('取消固定宽度并让并排与行内代码在各自栏内软换行', () => {
    const css = readFileSync(
      join(process.cwd(), 'src/renderer/src/features/source-control/source-control.css'),
      'utf8',
    )
    expect(css).not.toMatch(/minmax\((?:500|560|700|1120)px/)
    expect(css).not.toContain('min-width: max-content')
    expect(css).toContain('grid-template-columns: minmax(0, 1fr) minmax(0, 1fr)')
    expect(css).toContain('white-space: pre-wrap')
    expect(css).toContain('overflow-wrap: anywhere')
  })
})
