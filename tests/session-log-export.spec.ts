/** 主进程导出的真实文件回归：覆盖 ZIP 内容、取消、源文件变化与半成品清理。 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { saveSessionLog } from '../src/main/session-exports/session-log-export.ts'
import { readStoredZip, writeSessionLog } from './helpers/session-logs.ts'
import { previewDshImport, type SessionImportCatalog } from '../src/runtime/import/dsh-import.ts'

const coreRequire = createRequire(
  new URL('../packages/session/session-format-catalog/package.json', import.meta.url),
)
const { sessionFormatCatalog } = coreRequire('@deepseek-ai/dsh-session-format-catalog') as {
  sessionFormatCatalog: SessionImportCatalog
}

const directories: string[] = []

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-session-export-test-'))
  directories.push(directory)
  return directory
}

/** 构建父会话、子会话与无关会话各一份,子会话放在不同项目目录里验证闭包跨目录收集。 */
async function fixture() {
  const dataRoot = join(temporaryDirectory(), 'data')
  const parent = await writeSessionLog(dataRoot, { id: 'session-parent', cwd: '/tmp/alpha' })
  const child = await writeSessionLog(dataRoot, {
    id: 'session-child',
    parentSession: 'session-parent',
    cwd: '/tmp/beta',
  })
  const unrelated = await writeSessionLog(dataRoot, { id: 'session-unrelated', cwd: '/tmp/alpha' })
  return { dataRoot, parent, child, unrelated }
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

describe('会话日志导出', () => {
  it('定位会话与子会话,流式打包成可解析的 ZIP', async () => {
    const { dataRoot, parent, child } = await fixture()
    const directory = temporaryDirectory()
    const destination = join(directory, '会话日志.zip')
    const suggestedNames: string[] = []

    const result = await saveSessionLog({
      dataRoot,
      sessionId: 'session-parent',
      chooseDestination: async suggestedName => {
        suggestedNames.push(suggestedName)
        return destination
      },
    })

    expect(result).toEqual({ status: 'saved', fileName: '会话日志.zip' })
    expect(suggestedNames).toEqual(['MyDSH-会话日志.zip'])
    // 无关会话不进入导出;条目保持 sessions/<项目>/<会话>/<文件> 布局,可直接作为导入来源。
    const entries = await readStoredZip(destination)
    expect(entries.map(entry => entry.name).toSorted()).toEqual(
      [
        `sessions/${child.projectDirectory}/${child.sessionDirectory}/${child.logFileName}`,
        `sessions/${parent.projectDirectory}/${parent.sessionDirectory}/${parent.logFileName}`,
      ].toSorted(),
    )
    const byName = new Map(entries.map(entry => [entry.name, entry.content]))
    expect(
      byName.get(
        `sessions/${parent.projectDirectory}/${parent.sessionDirectory}/${parent.logFileName}`,
      ),
    ).toEqual(parent.content)
    expect(
      byName.get(
        `sessions/${child.projectDirectory}/${child.sessionDirectory}/${child.logFileName}`,
      ),
    ).toEqual(child.content)
  })

  it('停止会话的导出解包后可由实际格式目录完成导入预览', async () => {
    const { dataRoot } = await fixture()
    const directory = temporaryDirectory()
    const destination = join(directory, '往返.zip')
    await saveSessionLog({
      dataRoot,
      sessionId: 'session-parent',
      chooseDestination: async () => destination,
    })
    const unpacked = join(directory, 'unpacked')
    await Promise.all(
      (await readStoredZip(destination)).map(async entry => {
        const target = join(unpacked, entry.name)
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, entry.content)
      }),
    )
    const preview = await previewDshImport({
      sourceHome: unpacked,
      mydshHome: join(directory, 'mydsh'),
      sessionFormat: sessionFormatCatalog,
    })
    expect(preview.issues.filter(issue => issue.severity === 'error')).toEqual([])
    expect(preview.sessions.map(session => session.id).toSorted()).toEqual([
      'session-child',
      'session-parent',
    ])
    expect(preview.sessions.find(session => session.id === 'session-child')?.parentSession).toBe(
      'session-parent',
    )
  })

  it('用户取消保存时不写任何文件', async () => {
    const { dataRoot } = await fixture()
    const result = await saveSessionLog({
      dataRoot,
      sessionId: 'session-parent',
      chooseDestination: async () => null,
    })
    expect(result).toEqual({ status: 'cancelled' })
  })

  it('会话不存在时在弹窗之前失败', async () => {
    const { dataRoot } = await fixture()
    let dialogOpened = false
    await expect(
      saveSessionLog({
        dataRoot,
        sessionId: 'session-missing',
        chooseDestination: async () => {
          dialogOpened = true
          return join(temporaryDirectory(), '不应出现.zip')
        },
      }),
    ).rejects.toThrow('要导出的会话已不存在')
    expect(dialogOpened).toBe(false)
  })

  it('目标路径不是绝对路径时拒绝导出', async () => {
    const { dataRoot } = await fixture()
    await expect(
      saveSessionLog({
        dataRoot,
        sessionId: 'session-parent',
        chooseDestination: async () => '相对/路径.zip',
      }),
    ).rejects.toThrow('会话日志导出目标路径无效')
  })

  it('写入中途失败时删除半成品,不留下最终文件', async () => {
    const { dataRoot, child } = await fixture()
    const directory = temporaryDirectory()
    const destination = join(directory, '失败.zip')
    await expect(
      saveSessionLog({
        dataRoot,
        sessionId: 'session-parent',
        // 对话框返回后删除子会话源文件:父会话已写入,第二条目失败,触发中途清理。
        chooseDestination: async () => {
          await rm(child.sourcePath)
          return destination
        },
      }),
    ).rejects.toThrow('会话日志导出失败')
    expect(existsSync(destination)).toBe(false)
    expect(readdirSync(directory).filter(name => name.endsWith('.part'))).toEqual([])
  })

  it('对话框停留期间取消不会覆盖已有目标或留下半成品', async () => {
    const { dataRoot } = await fixture()
    const directory = temporaryDirectory()
    const destination = join(directory, '已有.zip')
    await writeFile(destination, '保留旧内容')
    const controller = new AbortController()
    const opened = Promise.withResolvers<void>()
    const selection = Promise.withResolvers<string>()
    const exporting = saveSessionLog({
      dataRoot,
      sessionId: 'session-parent',
      signal: controller.signal,
      chooseDestination: () => {
        opened.resolve()
        return selection.promise
      },
    })
    await opened.promise
    controller.abort(new Error('验收退出'))
    await expect(exporting).rejects.toThrow('验收退出')
    selection.resolve(destination)
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(await readFile(destination, 'utf8')).toBe('保留旧内容')
    expect(readdirSync(directory)).toEqual(['已有.zip'])
  })

  it('目标目录不存在时捕获异步打开错误，不留下半成品', async () => {
    const { dataRoot } = await fixture()
    const directory = temporaryDirectory()
    await expect(
      saveSessionLog({
        dataRoot,
        sessionId: 'session-parent',
        chooseDestination: async () => join(directory, '不存在', '失败.zip'),
      }),
    ).rejects.toThrow('会话日志导出失败')
    expect(readdirSync(directory)).toEqual([])
  })

  it('不允许把导出目标设为原始会话日志', async () => {
    const { dataRoot, parent } = await fixture()
    await expect(
      saveSessionLog({
        dataRoot,
        sessionId: 'session-parent',
        chooseDestination: async () => parent.sourcePath,
      }),
    ).rejects.toThrow('不能覆盖原始日志')
    expect(await readFile(parent.sourcePath)).toEqual(parent.content)
  })

  it.skipIf(process.platform === 'win32')('不能通过目录别名把 ZIP 写回原始数据目录', async () => {
    const { dataRoot, parent } = await fixture()
    const directory = temporaryDirectory()
    const alias = join(directory, 'data-alias')
    await symlink(dirname(parent.sourcePath), alias)
    await expect(
      saveSessionLog({
        dataRoot,
        sessionId: 'session-parent',
        chooseDestination: async () => join(alias, parent.logFileName),
      }),
    ).rejects.toThrow('不能覆盖原始日志')
    expect(await readFile(parent.sourcePath)).toEqual(parent.content)
  })

  it.skipIf(process.platform === 'win32')(
    '对话框期间源日志换成符号链接时拒绝复制并保留原目标',
    async () => {
      const { dataRoot, child } = await fixture()
      const directory = temporaryDirectory()
      const external = join(directory, '不应导出的内容')
      const destination = join(directory, '已有.zip')
      await writeFile(external, '私有数据')
      await writeFile(destination, '原目标')
      await expect(
        saveSessionLog({
          dataRoot,
          sessionId: 'session-parent',
          chooseDestination: async () => {
            await rm(child.sourcePath)
            await symlink(external, child.sourcePath)
            return destination
          },
        }),
      ).rejects.toThrow('会话日志导出失败')
      expect(await readFile(destination, 'utf8')).toBe('原目标')
      expect(readdirSync(directory).some(name => name.endsWith('.part'))).toBe(false)
    },
  )
})
