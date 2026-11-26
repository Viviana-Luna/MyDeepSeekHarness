import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
  },
}))

import { FileWorkspaceStateStore } from '../src/main/files/file-workspace-state-controller.ts'

const temporaryRoots: string[] = []

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'mydsh-file-workspace-'))
  temporaryRoots.push(root)
  return root
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0))
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

describe('文件工作区状态', () => {
  it('按项目原子保存并恢复固定标签、预览、展开目录与滚动位置', async () => {
    const root = temporaryRoot()
    const storagePath = join(root, 'user-data', 'file-workspace-state.json')
    const projectId = '0123456789abcdef01234567'
    const store = new FileWorkspaceStateStore(storagePath)
    const state = await store.save({
      projectId,
      pinnedFiles: ['README.md', 'src/main.ts'],
      previewFile: 'docs/usage.md',
      activeFile: 'src/main.ts',
      activeLine: 42,
      expandedDirectories: ['', 'src', 'docs'],
      recentFiles: ['src/main.ts', 'docs/usage.md', 'README.md'],
      treeScrollLeft: 128.4,
      treeScrollTop: 512.6,
    })

    expect(state).toEqual({
      projectId,
      pinnedFiles: ['README.md', 'src/main.ts'],
      previewFile: 'docs/usage.md',
      activeFile: 'src/main.ts',
      activeLine: 42,
      expandedDirectories: ['', 'src', 'docs'],
      recentFiles: ['src/main.ts', 'docs/usage.md', 'README.md'],
      treeScrollLeft: 128,
      treeScrollTop: 513,
    })
    expect(JSON.parse(readFileSync(storagePath, 'utf8'))).toMatchObject({
      version: 1,
      projects: { [projectId]: state },
    })
    expect(await new FileWorkspaceStateStore(storagePath).read(projectId)).toEqual(state)

    await Promise.all([
      store.save({ ...state, activeLine: 43 }),
      store.save({ ...state, activeLine: 44 }),
    ])
    expect(await new FileWorkspaceStateStore(storagePath).read(projectId)).toMatchObject({
      activeFile: 'src/main.ts',
      activeLine: 44,
    })
  })

  it('拒绝绝对路径、越界路径和不属于标签集合的当前文件', async () => {
    const store = new FileWorkspaceStateStore(join(temporaryRoot(), 'file-workspace-state.json'))
    const base = {
      projectId: 'fedcba9876543210fedcba98',
      pinnedFiles: ['README.md'],
      expandedDirectories: [''],
      recentFiles: ['README.md'],
      treeScrollLeft: 0,
      treeScrollTop: 0,
    }

    await expect(store.save({ ...base, previewFile: '/Users/luna/secret.txt' })).rejects.toThrow(
      '文件工作区路径必须位于项目内',
    )
    await expect(store.save({ ...base, expandedDirectories: ['', '../outside'] })).rejects.toThrow(
      '文件工作区路径必须位于项目内',
    )
    await expect(store.save({ ...base, activeFile: 'src/missing.ts' })).rejects.toThrow(
      '当前文件必须属于已保存标签',
    )
  })
})
