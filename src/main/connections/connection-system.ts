import { app, dialog, type BrowserWindow } from 'electron'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { cancelFileSheet } from '../window-controls.ts'
import { openCredential, sealCredential, type CredentialBinding } from './credential-envelope.ts'
import { createLocalKeyStorage, resolveLocalMasterKey } from './local-secret-key.ts'

const activeFileDialogs = new WeakSet<BrowserWindow>()

function assertSupportedPlatform(): void {
  if (process.platform !== 'darwin' && process.platform !== 'win32')
    throw new Error('连接凭据目前仅支持 macOS 与 Windows')
}

async function sealWithLocalKey(secret: string, binding: CredentialBinding, keyDirectory: string) {
  const masterKey = await resolveLocalMasterKey(keyDirectory, true)
  try {
    return sealCredential(secret, binding, createLocalKeyStorage(masterKey))
  } finally {
    masterKey.fill(0)
  }
}

async function openStoredEnvelope(
  envelope: unknown,
  binding: CredentialBinding,
  keyDirectory: string,
): Promise<string> {
  const protection =
    envelope && typeof envelope === 'object' && !Array.isArray(envelope)
      ? (envelope as { protection?: unknown }).protection
      : undefined
  if (protection === 'local-key-file') {
    const masterKey = await resolveLocalMasterKey(keyDirectory, false)
    try {
      return openCredential(envelope, binding, createLocalKeyStorage(masterKey))
    } finally {
      masterKey.fill(0)
    }
  }
  if (protection === 'electron-safe-storage') {
    throw new Error(
      '该连接凭据仍使用旧版系统钥匙串加密；当前版本已停用系统钥匙串并改用本地受保护密钥文件，请点击「编辑连接」重新输入密码（或重新导入私钥）保存一次即可。',
    )
  }
  throw new Error('凭据格式无效或已损坏；请重新输入凭据并保存，原记录保持不变。')
}

async function readSshPrivateKeyFromDialog(signal: AbortSignal, win?: BrowserWindow) {
  if (!win || win.isDestroyed()) throw new Error('窗口已关闭，无法导入私钥')
  if (activeFileDialogs.has(win)) throw new Error('请先完成当前文件选择')
  activeFileDialogs.add(win)
  const abort = () => {
    if (!win.isDestroyed()) cancelFileSheet(win)
  }
  signal.addEventListener('abort', abort, { once: true })
  try {
    const selected = await dialog.showOpenDialog(win, {
      title: '选择 SSH 私钥',
      buttonLabel: '导入私钥',
      properties: ['openFile', 'dontAddToRecent'],
    })
    signal.throwIfAborted()
    const path = selected.filePaths[0]
    if (selected.canceled || !path) return null
    const file = await open(path, 'r')
    try {
      const info = await file.stat()
      if (!info.isFile() || info.size > 65536) throw new Error('私钥必须是小于 64 KiB 的普通文件')
      const bytes = Buffer.alloc(65537)
      try {
        const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
        signal.throwIfAborted()
        if (bytesRead > 65536) throw new Error('私钥文件超过大小限制')
        const secret = bytes.subarray(0, bytesRead).toString('utf8')
        if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(secret))
          throw new Error('文件不是支持的 SSH 私钥格式')
        return secret
      } finally {
        bytes.fill(0)
      }
    } finally {
      await file.close()
    }
  } finally {
    activeFileDialogs.delete(win)
    signal.removeEventListener('abort', abort)
  }
}

async function pickSqliteDatabaseFile(
  signal: AbortSignal,
  win?: BrowserWindow,
): Promise<{ path: string | null }> {
  if (!win || win.isDestroyed()) throw new Error('窗口已关闭，无法选择 SQLite 文件')
  if (activeFileDialogs.has(win)) throw new Error('请先完成当前文件选择')
  activeFileDialogs.add(win)
  const abort = () => {
    if (!win.isDestroyed()) cancelFileSheet(win)
  }
  signal.addEventListener('abort', abort, { once: true })
  try {
    const selected = await dialog.showOpenDialog(win, {
      title: '选择 SQLite 数据库文件',
      buttonLabel: '选择文件',
      properties: ['openFile', 'dontAddToRecent'],
      filters: [
        { name: 'SQLite 数据库', extensions: ['db', 'sqlite', 'sqlite3', 's3db', 'sl3'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    })
    signal.throwIfAborted()
    const picked = selected.canceled ? null : (selected.filePaths[0] ?? null)
    return { path: picked }
  } finally {
    activeFileDialogs.delete(win)
    signal.removeEventListener('abort', abort)
  }
}

/** 连接凭据请求可选上下文：可直接传入宿主窗口，或在测试中覆盖本地主密钥目录。 */
export type ConnectionSystemContext =
  BrowserWindow | { readonly win?: BrowserWindow; readonly localKeyDirectory?: string }

function resolveConnectionContext(context?: ConnectionSystemContext): {
  win?: BrowserWindow
  localKeyDirectory?: string
} {
  if (!context) return {}
  if ('isDestroyed' in context) return { win: context }
  return context
}

/** 只供自有 Runtime 使用的连接凭据与本地文件选择操作，不对 renderer 开放解密能力。 */
export async function connectionSystem(
  method: string,
  value: Record<string, unknown>,
  signal: AbortSignal,
  context?: ConnectionSystemContext,
): Promise<unknown> {
  const { win, localKeyDirectory } = resolveConnectionContext(context)
  assertSupportedPlatform()
  signal.throwIfAborted()
  if (method === 'database.pick-sqlite') {
    if (Object.keys(value).length > 0) throw new Error('选择 SQLite 文件参数无效')
    return pickSqliteDatabaseFile(signal, win)
  }
  const id = value.connectionId
  if (typeof id !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(id))
    throw new Error('连接凭据身份无效')
  const purpose = method === 'ssh.import-key' ? 'ssh-private-key' : value.purpose
  const database = method === 'database.seal' || method === 'database.open'
  if (
    typeof purpose !== 'string' ||
    !(
      database ? ['database-password'] : ['ssh-password', 'ssh-private-key', 'ssh-passphrase']
    ).includes(purpose)
  )
    throw new Error('连接凭据用途无效')
  const sealing = method === 'ssh.seal' || method === 'database.seal'
  const expected =
    method === 'ssh.import-key'
      ? ['connectionId']
      : sealing
        ? ['connectionId', 'purpose', 'secret']
        : ['connectionId', 'purpose', 'envelope']
  if (Object.keys(value).some(key => !expected.includes(key))) throw new Error('连接凭据参数无效')
  const binding = { connectionId: id, purpose }
  const keyDirectory = localKeyDirectory ?? join(app.getPath('userData'), 'connection-secrets')
  if (method === 'ssh.import-key') {
    const secret = await readSshPrivateKeyFromDialog(signal, win)
    return secret === null ? null : sealWithLocalKey(secret, binding, keyDirectory)
  }
  if (sealing && typeof value.secret === 'string')
    return sealWithLocalKey(value.secret, binding, keyDirectory)
  if (method === 'ssh.open' || method === 'database.open')
    return openStoredEnvelope(value.envelope, binding, keyDirectory)
  throw new Error('未知连接凭据操作')
}
