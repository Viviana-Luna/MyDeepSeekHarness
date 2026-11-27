/**
 * 真实 Electron 的会话导出验收：轨迹按钮、preload、IPC、本地 ZIP 和导入预览贯通。
 * 仅接管本次隔离窗口的保存对话框返回值，不操作用户文件；临时归档和解包目录在 finally 删除。
 */
/* oxlint-disable no-await-in-loop -- 按中央目录顺序校验并解包，避免并行读取放大日志内存占用。 */
import { dialog, type BrowserWindow } from 'electron'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { crc32 } from 'node:zlib'
import { previewDshImport, type SessionImportCatalog } from '../../runtime/import/dsh-import.ts'
import type { DesktopSessionFrame } from '../../shared/session-live.ts'
import { collectSessionLogsForExport } from '../session-exports/session-log-discovery.ts'
import type { InstalledRuntime } from '../runtime/runtime-install.ts'
import { clickTrustedElement } from './desktop-verifier.ts'
import { pollRenderer } from './verification-wait.ts'

async function checkArchive(path: string, dataRoot: string, sessionId: string, unpacked: string) {
  const entries = await collectSessionLogsForExport(dataRoot, sessionId)
  const bytes = await readFile(path)
  const end = bytes.length - 22
  if (end < 0 || bytes.readUInt32LE(end) !== 0x06054b50)
    throw new Error('会话导出缺少 ZIP 结束记录')
  if (bytes.readUInt16LE(end + 10) !== entries.length) throw new Error('会话导出遗漏日志条目')
  let cursor = bytes.readUInt32LE(end + 16)
  for (const entry of entries) {
    if (bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error('会话导出中央目录无效')
    const size = bytes.readUInt32LE(cursor + 24)
    const nameLength = bytes.readUInt16LE(cursor + 28)
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')
    if (name !== entry.archivePath) throw new Error('会话导出条目路径与源日志不一致')
    const local = bytes.readUInt32LE(cursor + 42)
    const start = local + 30 + bytes.readUInt16LE(local + 26)
    const content = bytes.subarray(start, start + size)
    if (
      !content.equals(await readFile(entry.sourcePath)) ||
      crc32(content) !== bytes.readUInt32LE(cursor + 16)
    )
      throw new Error('会话导出字节或校验码与源日志不一致')
    const target = join(unpacked, entry.archivePath)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content)
    cursor += 46 + nameLength + bytes.readUInt16LE(cursor + 30) + bytes.readUInt16LE(cursor + 32)
  }
}

async function checkImportPreview(
  installation: InstalledRuntime,
  sourceHome: string,
  sessionId: string,
) {
  const format = (await import(
    pathToFileURL(
      join(
        installation.runtimeDirectory,
        'node_modules/@deepseek-ai/dsh-session-format-catalog/lib/index.js',
      ),
    ).href
  )) as { sessionFormatCatalog: SessionImportCatalog }
  const preview = await previewDshImport({
    sourceHome,
    mydshHome: installation.mydshHome,
    sessionFormat: format.sessionFormatCatalog,
  })
  if (
    !preview.sessions.some(session => session.id === sessionId) ||
    preview.issues.some(issue => issue.severity === 'error')
  )
    throw new Error('真实会话的导出 ZIP 未通过核心格式目录的导入预览')
}

async function verifyPendingSelection(
  win: BrowserWindow,
  sessionId: string,
  latePath: string,
  cancel: () => void,
): Promise<void> {
  const opened = Promise.withResolvers<void>()
  const selection = Promise.withResolvers<Electron.SaveDialogReturnValue>()
  dialog.showSaveDialog = () => {
    opened.resolve()
    return selection.promise
  }
  const request = () =>
    win.webContents
      .executeJavaScript(`window.dshDesktop.sessionExports.save(${JSON.stringify(sessionId)})`)
      .then(
        () => '',
        (error: unknown) => String(error),
      )
  try {
    const pending = request()
    await opened.promise
    cancel()
    const cancelled = await Promise.race([pending, delay(2_000, '', { ref: false })])
    if (!cancelled.includes('验收取消会话日志导出'))
      throw new Error('取消导出未结束对原生对话框的等待')
    const duplicate = await Promise.race([request(), delay(2_000, '', { ref: false })])
    if (!duplicate.includes('已有会话日志正在导出或等待选择保存位置'))
      throw new Error('已取消但未关闭的保存对话框未阻止重复打开')
    selection.resolve({ canceled: false, filePath: latePath })
    await delay(50)
    if ((await readdir(dirname(latePath))).includes(basename(latePath)))
      throw new Error('取消后仍写入了迟到的保存路径')
  } finally {
    selection.resolve({ canceled: true, filePath: '' })
  }
}

async function verifyEmptyTrajectoryAndSeedRecords(
  win: BrowserWindow,
  sessionId: string,
  emit: (frame: DesktopSessionFrame) => void,
): Promise<void> {
  await clickTrustedElement(win, '.conversation-view-tabs [data-view="trajectory"]')
  const emptyTrajectoryClean = await pollRenderer<boolean>(win, {
    probe: `Boolean(
      document.querySelector('#trajectory-view') &&
      document.querySelector('[aria-label="导出日志"]') === null &&
      document.querySelector('[aria-label="搜索轨迹"]') === null &&
      document.querySelector('[aria-label="轨迹概览"]') === null &&
      document.querySelector('[aria-label="收起输入框"]') === null,
    )`,
    condition: 'state === true',
    timeoutMs: 2_000,
  })
  if (!emptyTrajectoryClean.ok) {
    throw new Error('空轨迹会话仍渲染了无效的控制按钮或工具栏')
  }
  const now = Date.now()
  emit({
    type: 'session/snapshot',
    sessionId,
    events: [
      { seq: 0, time: now, type: 'turn/start', data: { turn: 1 } },
      {
        seq: 1,
        time: now + 5,
        type: 'user/message',
        data: {
          content: [{ type: 'text', text: '触发轨迹记录用于导出验收' }],
          source: { kind: 'user' },
        },
      },
      { seq: 2, time: now + 10, type: 'turn/end', data: { turn: 1 } },
    ],
    lastSeq: 2,
    hasMore: false,
  })
  const exportReady = await pollRenderer<boolean>(win, {
    probe: `document.querySelector('[aria-label="导出日志"]') !== null`,
    condition: 'state === true',
    timeoutMs: 2_000,
  })
  if (!exportReady.ok) throw new Error('有轨迹记录后未出现导出日志按钮')
}

/**
 * 从当前隔离会话的轨迹按钮触发导出，校验原生对话框参数、结果提示、内容与取消路径。
 * 保存路径由验收临时返回，操作系统保存面板本身仍需人工交互验收。
 */
export async function verifySessionLogExport(
  win: BrowserWindow,
  options: {
    installation: InstalledRuntime
    sessionId: string
    emit: (frame: DesktopSessionFrame) => void
    cancelPending: () => void
  },
): Promise<void> {
  // 空会话可能尚未物化到磁盘；用真实改名事件产生可导出的日志，不把界面投影夹具当成持久记录。
  await win.webContents.executeJavaScript(`(async () => {
    const sessionId = ${JSON.stringify(options.sessionId)}
    const { items } = await window.dshDesktop.host.call('listSessions', {})
    const title = items.find(item => item.sessionId === sessionId)?.title || '导出验收会话'
    await window.dshDesktop.host.call('renameSession', { sessionId, title })
  })()`)
  const directory = await mkdtemp(join(tmpdir(), 'mydsh-export-verify-'))
  const destination = join(directory, 'MyDSH-会话日志.zip')
  const dataRoot = join(options.installation.mydshHome, 'data')
  const originalDialog = dialog.showSaveDialog
  let cancel = false
  let dialogCount = 0
  dialog.showSaveDialog = (async (...args: unknown[]) => {
    const settings = args[1] as Electron.SaveDialogOptions
    if (settings.title !== '导出会话日志' || settings.filters?.[0]?.extensions[0] !== 'zip')
      throw new Error('会话导出未使用受限 ZIP 保存对话框')
    dialogCount += 1
    return { canceled: cancel, filePath: cancel ? undefined : destination }
  }) as typeof dialog.showSaveDialog
  try {
    await verifyEmptyTrajectoryAndSeedRecords(win, options.sessionId, options.emit)
    await clickTrustedElement(win, '[aria-label="导出日志"]')
    const completed = await win.webContents.executeJavaScript(`(async () => {
      for (let attempt = 0; attempt < 200; attempt++) {
        if (document.querySelector('#trajectory-view')?.textContent.includes('已导出 MyDSH-会话日志.zip')) return true
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      return false
    })()`)
    if (!completed) throw new Error('轨迹导出按钮未呈现保存成功结果')
    const unpacked = join(directory, 'unpacked')
    await checkArchive(destination, dataRoot, options.sessionId, unpacked)
    await checkImportPreview(options.installation, unpacked, options.sessionId)
    cancel = true
    const result = await win.webContents.executeJavaScript(
      `window.dshDesktop.sessionExports.save(${JSON.stringify(options.sessionId)})`,
    )
    if (result.status !== 'cancelled' || dialogCount !== 2) throw new Error('会话导出取消路径失败')
    await verifyPendingSelection(
      win,
      options.sessionId,
      join(directory, '迟到的保存.zip'),
      options.cancelPending,
    )
    if ((await readdir(directory)).some(name => name.endsWith('.part')))
      throw new Error('会话导出取消后留下了半成品')
    console.log('desktop-shell-verify-local: session-export', {
      emptyTrajectoryClean: true,
      button: true,
      ipc: true,
      archive: true,
      importPreview: true,
      cancelled: true,
    })
  } finally {
    dialog.showSaveDialog = originalDialog
    await rm(directory, { recursive: true, force: true })
    if (!win.isDestroyed()) {
      options.emit({
        type: 'session/snapshot',
        sessionId: options.sessionId,
        events: [],
        lastSeq: 0,
        hasMore: false,
      })
      await clickTrustedElement(win, '.conversation-view-tabs [data-view="conversation"]')
    }
  }
}
