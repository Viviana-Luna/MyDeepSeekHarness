import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import {
  commitDshImport,
  importDshCredentials,
  previewDshImport,
  recoverDshImport,
  type SessionImportCatalog,
} from '../src/runtime/import/dsh-import.ts'

// 使用随产品移植的实际格式校验器，夹具不会替代 Session 协议本身。
const coreRequire = createRequire(
  new URL('../packages/session/session-format-catalog/package.json', import.meta.url),
)
const { sessionFormatCatalog } = coreRequire('@deepseek-ai/dsh-session-format-catalog') as {
  sessionFormatCatalog: SessionImportCatalog
}
const temporaryDirectories: string[] = []
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })),
  )
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mydsh-dsh-import-'))
  temporaryDirectories.push(root)
  const sourceHome = join(root, 'dsh')
  const mydshHome = join(root, 'mydsh')
  await Promise.all(
    ['parent', 'child'].map(id =>
      mkdir(join(sourceHome, 'sessions/--tmp-project--', id), { recursive: true }),
    ),
  )
  await mkdir(join(sourceHome, 'storages'))
  await mkdir(join(mydshHome, 'data'), { recursive: true })
  await mkdir(join(mydshHome, 'config'))
  const parent = `${JSON.stringify({ type: 'session', version: 3, id: 'parent', createdAt: 1, cwd: '/tmp/project', isSeeded: false, delegationDepth: 0 })}\n`
  const child = `${JSON.stringify({ type: 'session', version: 3, id: 'child', parentSession: 'parent', createdAt: 2, cwd: '/tmp/project', isSeeded: false, delegationDepth: 1, origin: 'subagent' })}\n`
  await writeFile(join(sourceHome, 'sessions/--tmp-project--/parent/session.v3.jsonl'), parent)
  await writeFile(
    join(sourceHome, 'sessions/--tmp-project--/child/session.v3.jsonl.zstd'),
    zstdCompressSync(child),
  )
  await writeFile(
    join(sourceHome, 'storages/workspace.json'),
    JSON.stringify({
      unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: ['project'], archivedSessionIds: ['child'] },
      tables: {
        workspaces: {
          project: {
            title: '原项目',
            path: '/tmp/project',
            sessionIds: ['parent', 'child'],
            createdAt: '2026-09-18T00:00:00.000Z',
            updatedAt: '2026-09-18T00:00:00.000Z',
          },
        },
      },
    }),
  )
  await writeFile(
    join(sourceHome, 'settings.yaml'),
    'llm-deepseek:\n  model: imported-model\n  apiKey: forbidden-inline-secret\nunknown-plugin:\n  enabled: true\n',
  )
  await writeFile(
    join(sourceHome, '.credentials.yaml'),
    'version: 1\nrefs:\n  API_KEY: test-import-secret\n',
  )
  await writeFile(join(mydshHome, 'data/format.json'), '{"schemaVersion":1}\n')
  await writeFile(join(mydshHome, 'config/settings.yaml'), 'goal:\n  enabled: false\n')
  await writeFile(join(mydshHome, 'config/credentials.enc'), '测试密文占位')
  return { sourceHome, mydshHome, sessionFormat: sessionFormatCatalog }
}

describe('DSH 数据一次性导入', () => {
  it('读取真实 JSONL/Zstandard 格式并保留关系、归档、来源与独立凭据边界，重复导入不重复创建', async () => {
    const options = await fixture()
    const preview = await previewDshImport(options)
    expect(preview.issues.filter(issue => issue.severity === 'error')).toEqual([])
    expect(preview.sessions).toHaveLength(2)
    expect(preview.sessions.find(session => session.id === 'child')?.parentSession).toBe('parent')
    expect(preview.credentialNames).toEqual(['ref:API_KEY'])
    expect(JSON.stringify(preview)).not.toContain('test-import-secret')
    expect(JSON.stringify(preview)).not.toContain('forbidden-inline-secret')
    const sourceBefore = await readFile(
      join(options.sourceHome, 'sessions/--tmp-project--/parent/session.v3.jsonl'),
    )
    const result = await commitDshImport({ ...options, expectedFingerprint: preview.fingerprint })
    expect(result.importedSessions).toBe(2)
    const imported = await readFile(
      join(options.mydshHome, 'data/sessions/--tmp-project--/parent/session.v3.jsonl.zstd'),
    )
    expect(zstdDecompressSync(imported)).toEqual(sourceBefore)
    const projects = JSON.parse(
      await readFile(join(options.mydshHome, 'data/storages/workspace.json'), 'utf8'),
    )
    expect(projects.tables.workspaces.project.sessionIds).toEqual(['parent', 'child'])
    expect(projects.global.archivedSessionIds).toEqual(['child'])
    const settings = await readFile(join(options.mydshHome, 'config/settings.yaml'), 'utf8')
    expect(settings).toContain('model: imported-model')
    expect(settings).toContain('enabled: false')
    expect(settings).not.toContain('forbidden-inline-secret')
    const dataFiles = await readdir(join(options.mydshHome, 'data'))
    expect(dataFiles).not.toContain('.credentials.yaml')
    expect(dataFiles).not.toContain('settings.yaml')
    expect(await readFile(join(options.mydshHome, 'config/credentials.enc'), 'utf8')).toBe(
      '测试密文占位',
    )
    const stored: string[] = []
    expect(
      await importDshCredentials({
        sourceHome: options.sourceHome,
        names: ['ref:API_KEY'],
        async writeCredential(entry) {
          stored.push(String(entry.value))
        },
      }),
    ).toEqual(['ref:API_KEY'])
    expect(stored).toEqual(['test-import-secret'])
    expect(
      await commitDshImport({ ...options, expectedFingerprint: preview.fingerprint }),
    ).toMatchObject({ importedSessions: 0, skippedSessions: 2 })
    expect(
      await readFile(join(options.sourceHome, 'sessions/--tmp-project--/parent/session.v3.jsonl')),
    ).toEqual(sourceBefore)
    expect((await readdir(options.mydshHome)).filter(name => name.startsWith('.import-'))).toEqual(
      [],
    )
  })

  it('来源变化、未知版本和取消不替换活动数据，联合提交中断同时恢复数据与配置', async () => {
    const options = await fixture()
    const original = await readFile(join(options.mydshHome, 'data/format.json'))
    const originalSettings = await readFile(join(options.mydshHome, 'config/settings.yaml'))
    const preview = await previewDshImport(options)
    await writeFile(
      join(options.sourceHome, 'settings.yaml'),
      'llm-deepseek:\n  model: changed-model\n',
    )
    await expect(
      commitDshImport({ ...options, expectedFingerprint: preview.fingerprint }),
    ).rejects.toThrow('预览后发生变化')
    await writeFile(
      join(options.sourceHome, 'sessions/--tmp-project--/parent/session.v4.jsonl'),
      '{"type":"session","version":4}\n',
    )
    const unsupported = await previewDshImport(options)
    expect(unsupported.issues.some(issue => issue.code === 'session-version')).toBe(true)
    await expect(
      commitDshImport({ ...options, expectedFingerprint: unsupported.fingerprint }),
    ).rejects.toThrow('阻止导入')
    await rm(join(options.sourceHome, 'sessions/--tmp-project--/parent/session.v4.jsonl'))
    const latest = await previewDshImport(options)
    const controller = new AbortController()
    let restored = 0
    const interruptingCatalog: SessionImportCatalog = {
      currentVersion: sessionFormatCatalog.currentVersion,
      createRestore(header, restoreOptions) {
        // 两份会话预检完成后，在提交前的再次校验阶段取消，覆盖已存在暂存数据的清理。
        if (++restored === 3) controller.abort()
        return sessionFormatCatalog.createRestore(header, restoreOptions)
      },
    }
    await expect(
      commitDshImport({
        ...options,
        sessionFormat: interruptingCatalog,
        expectedFingerprint: latest.fingerprint,
        signal: controller.signal,
      }),
    ).rejects.toThrow()
    expect(await readFile(join(options.mydshHome, 'data/format.json'))).toEqual(original)
    expect(await readdir(join(options.mydshHome, 'data'))).toEqual(['format.json'])
    expect((await readdir(options.mydshHome)).filter(name => name.startsWith('.import-'))).toEqual(
      [],
    )
    expect(await readFile(join(options.mydshHome, 'config/settings.yaml'))).toEqual(
      originalSettings,
    )
    // 模拟两次目录切换完成、成功标记尚未落盘时退出；只恢复 data 会留下混合配置。
    const interrupted = await mkdtemp(join(options.mydshHome, '.import-'))
    await writeFile(
      join(interrupted, 'transaction.json'),
      JSON.stringify({ version: 1, hadData: true, hadConfig: true }),
    )
    await rename(join(options.mydshHome, 'data'), join(interrupted, 'previous-data'))
    await rename(join(options.mydshHome, 'config'), join(interrupted, 'previous-config'))
    await mkdir(join(options.mydshHome, 'data'))
    await mkdir(join(options.mydshHome, 'config'))
    await writeFile(join(options.mydshHome, 'data/uncommitted'), '未提交数据')
    await writeFile(join(options.mydshHome, 'config/settings.yaml'), '未提交配置')
    await recoverDshImport(options.mydshHome)
    expect(await readFile(join(options.mydshHome, 'data/format.json'))).toEqual(original)
    expect(await readdir(join(options.mydshHome, 'data'))).toEqual(['format.json'])
    expect(await readFile(join(options.mydshHome, 'config/settings.yaml'))).toEqual(
      originalSettings,
    )
    expect(await readFile(join(options.mydshHome, 'config/credentials.enc'), 'utf8')).toBe(
      '测试密文占位',
    )
    expect((await readdir(options.mydshHome)).filter(name => name.startsWith('.import-'))).toEqual(
      [],
    )
  })
})
