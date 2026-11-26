/** 连接凭据本地主密钥管理：以受限权限文件存放 32 字节随机密钥并封装 AES-256-GCM 密钥包装器。 */
import { execFile } from 'node:child_process'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { chmod, link, lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { SystemSecretStorage } from './credential-envelope.ts'

const execute = promisify(execFile)
const KEY_FILE_NAME = 'secret.key'
const WRAP_ALGORITHM = 'aes-256-gcm'
const WRAP_AAD = Buffer.from('mydsh-local-master-key:v1', 'utf8')
const BASE64URL_32_BYTES = /^[A-Za-z0-9_-]{43}$/u
const MAX_KEY_FILE_BYTES = 256
const pendingCreations = new Map<string, Promise<void>>()

const WINDOWS_DACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class MydshSecretAcl {
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string sddl, uint rev, out IntPtr sd, IntPtr size);
  [DllImport("advapi32.dll", SetLastError=true)]
  public static extern bool GetSecurityDescriptorDacl(IntPtr sd, out bool present, out IntPtr dacl, out bool defaulted);
  [DllImport("advapi32.dll", SetLastError=true)]
  public static extern bool GetSecurityDescriptorSacl(IntPtr sd, out bool present, out IntPtr sacl, out bool defaulted);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode)]
  public static extern uint SetNamedSecurityInfoW(string name, int objType, uint secInfo, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
  [DllImport("kernel32.dll")]
  public static extern IntPtr LocalFree(IntPtr hMem);
  public static uint Apply(string path, string sddl) {
    IntPtr sd;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, out sd, IntPtr.Zero)) {
      return (uint)Marshal.GetLastWin32Error();
    }
    try {
      bool dp, dd, sp, sd2;
      IntPtr dacl, sacl;
      if (!GetSecurityDescriptorDacl(sd, out dp, out dacl, out dd) ||
          !GetSecurityDescriptorSacl(sd, out sp, out sacl, out sd2)) {
        return (uint)Marshal.GetLastWin32Error();
      }
      return SetNamedSecurityInfoW(path, 1, 0x00000004u | 0x80000000u | 0x00000010u, IntPtr.Zero, IntPtr.Zero, dacl, sacl);
    } finally {
      LocalFree(sd);
    }
  }
}
"@
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
function Format-LongPath([string] $path) {
  $full = [IO.Path]::GetFullPath($path)
  if ($full.StartsWith('\\?\')) { return $full }
  if ($full.Length -ge 240 -and $full -match '^[A-Za-z]:\\') { return '\\?\' + $full }
  return $full
}
function Protect-MydshSecretEntry([string] $path) {
  $entry = Get-Item -LiteralPath $path -Force
  if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw '本地密钥路径不能包含重解析点' }
  $sddl = if ($entry.PSIsContainer) {
    "D:P(A;OICI;FA;;;$sid)(A;OICI;FA;;;SY)S:(ML;OICI;NRNW;;;ME)"
  } else {
    "D:P(A;;FA;;;$sid)(A;;FA;;;SY)S:(ML;;NRNW;;;ME)"
  }
  $status = [MydshSecretAcl]::Apply((Format-LongPath $path), $sddl)
  if ($status -ne 0) { throw "设置本地主密钥安全描述符失败（Win32 $status）" }
  if ($entry.PSIsContainer) {
    foreach ($child in Get-ChildItem -LiteralPath $path -Force) { Protect-MydshSecretEntry $child.FullName }
  }
}
Protect-MydshSecretEntry $env:MYDSH_SECRET_PATH
`

async function renameSecretWithRetry(source: string, destination: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- Windows 杀毒软件短暂占用时串行退避重试重命名。
      await rename(source, destination)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? ''
      if (
        process.platform !== 'win32' ||
        attempt >= 8 ||
        !['EACCES', 'EBUSY', 'EPERM'].includes(code)
      ) {
        throw error
      }
      // oxlint-disable-next-line no-await-in-loop -- 退避等待后再次尝试原路径重命名。
      await new Promise(resolveWait => setTimeout(resolveWait, Math.min(20 * 2 ** attempt, 200)))
    }
  }
}

async function applyWindowsAcl(targetPath: string): Promise<void> {
  if (process.platform !== 'win32') return
  try {
    await execute(
      join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32/WindowsPowerShell/v1.0/powershell.exe',
      ),
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(WINDOWS_DACL_SCRIPT, 'utf16le').toString('base64'),
      ],
      {
        windowsHide: true,
        timeout: 45_000,
        env: { ...process.env, MYDSH_SECRET_PATH: targetPath },
      },
    )
  } catch (cause) {
    throw new Error('无法设置本地主密钥保护权限，凭据操作已中止', { cause })
  }
}

/** 创建并锁定存放本地主密钥的私有目录；若路径指向符号链接则拒绝。 */
export async function protectLocalKeyDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const info = await lstat(directory)
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error('本地主密钥目录必须是普通目录，不能使用符号链接')
  }
  if (process.platform !== 'win32') await chmod(directory, 0o700)
  await applyWindowsAcl(directory)
}

function parseMasterKeyText(raw: string): Buffer {
  const trimmed = raw.trim()
  if (!BASE64URL_32_BYTES.test(trimmed)) {
    throw new Error('本地主密钥文件格式损坏，已保留原文件；请检查后恢复')
  }
  const key = Buffer.from(trimmed, 'base64url')
  if (key.length !== 32 || key.toString('base64url') !== trimmed) {
    key.fill(0)
    throw new Error('本地主密钥文件格式损坏，已保留原文件；请检查后恢复')
  }
  return key
}

async function readExistingMasterKey(directory: string, keyPath: string): Promise<Buffer> {
  const dirInfo = await lstat(directory)
  if (dirInfo.isSymbolicLink() || !dirInfo.isDirectory()) {
    throw new Error('本地主密钥目录必须是普通目录，不能使用符号链接')
  }
  if (process.platform !== 'win32' && (dirInfo.mode & 0o077) !== 0) {
    await chmod(directory, 0o700)
  }
  // Windows 下 O_NOFOLLOW 不可用，打开前必须显式 lstat 拒绝符号链接或重解析点。
  const keyLinkInfo = await lstat(keyPath)
  if (keyLinkInfo.isSymbolicLink()) {
    throw new Error('本地主密钥文件不能使用符号链接')
  }
  if (!keyLinkInfo.isFile()) {
    throw new Error('本地主密钥路径必须是普通文件')
  }
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0)
  let handle
  try {
    handle = await open(keyPath, flags)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') throw error
    if (code === 'ELOOP') throw new Error('本地主密钥文件不能使用符号链接', { cause: error })
    throw new Error('本地主密钥文件无法读取，原文件已保留', { cause: error })
  }
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error('本地主密钥路径必须是普通文件')
    if (info.size > MAX_KEY_FILE_BYTES) {
      throw new Error('本地主密钥文件格式损坏，已保留原文件；请检查后恢复')
    }
    if (process.platform !== 'win32' && (info.mode & 0o777) !== 0o600) {
      await handle.chmod(0o600)
    }
    const raw = await handle.readFile({ encoding: 'utf8' })
    return parseMasterKeyText(raw)
  } finally {
    await handle.close()
  }
}

async function createMasterKeyAtomically(directory: string, keyPath: string): Promise<void> {
  await protectLocalKeyDirectory(directory)
  const generated = randomBytes(32)
  const encoded = `${generated.toString('base64url')}\n`
  const tempPath = join(directory, `.secret.key.${randomBytes(8).toString('hex')}.tmp`)
  let createdByUs = false
  try {
    const writeFlags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL
    const handle = await open(tempPath, writeFlags, 0o600)
    try {
      await handle.writeFile(encoded, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await applyWindowsAcl(tempPath)
    if (process.platform !== 'win32') {
      try {
        // 使用 hard link 原子发布且拒绝覆盖已存在的 secret.key，避免并发或崩溃遗留空文件。
        await link(tempPath, keyPath)
        createdByUs = true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    } else {
      try {
        await lstat(keyPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        await renameSecretWithRetry(tempPath, keyPath)
        createdByUs = true
      }
    }
    if (createdByUs) {
      const verified = await readExistingMasterKey(directory, keyPath)
      try {
        if (Buffer.compare(verified, generated) !== 0) {
          throw new Error('本地主密钥回读校验不一致，已停止凭据保存')
        }
      } finally {
        verified.fill(0)
      }
    }
  } finally {
    generated.fill(0)
    await unlink(tempPath).catch(() => {})
  }
}

/**
 * 解析或按需创建本地 32 字节连接主密钥；只读读取时从不自动创建新密钥覆盖已有密文。
 * @throws 密钥损坏、读取失败或允许创建之外的缺失情况时抛出。
 */
export async function resolveLocalMasterKey(
  directory: string,
  allowCreate: boolean,
): Promise<Buffer> {
  const keyPath = join(directory, KEY_FILE_NAME)
  const resolvedDirectory = resolve(directory)
  const singleflightKey =
    process.platform === 'win32' ? resolvedDirectory.toLowerCase() : resolvedDirectory
  const inflight = pendingCreations.get(singleflightKey)
  if (inflight) await inflight.catch(() => {})
  try {
    return await readExistingMasterKey(directory, keyPath)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') throw error
    if (!allowCreate) {
      throw new Error('本地主密钥文件不存在，无法解密已保存凭据', { cause: error })
    }
  }
  let creating = pendingCreations.get(singleflightKey)
  if (!creating) {
    creating = createMasterKeyAtomically(directory, keyPath).finally(() => {
      pendingCreations.delete(singleflightKey)
    })
    pendingCreations.set(singleflightKey, creating)
  }
  await creating
  return readExistingMasterKey(directory, keyPath)
}

/** 将 32 字节本地主密钥适配为与 credential-envelope 兼容的存储加解密器。 */
export function createLocalKeyStorage(masterKey: Buffer): SystemSecretStorage {
  if (masterKey.length !== 32) throw new Error('本地主密钥长度必须是 32 字节')
  return {
    protection: 'local-key-file',
    isEncryptionAvailable: () => true,
    encryptString(value: string): Buffer {
      const nonce = randomBytes(12)
      const cipher = createCipheriv(WRAP_ALGORITHM, masterKey, nonce, { authTagLength: 16 })
      cipher.setAAD(WRAP_AAD)
      const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
      return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext])
    },
    decryptString(value: Buffer): string {
      if (!Buffer.isBuffer(value) || value.length < 28) {
        throw new Error('本地主密钥密文损坏')
      }
      const nonce = value.subarray(0, 12)
      const tag = value.subarray(12, 28)
      const ciphertext = value.subarray(28)
      const decipher = createDecipheriv(WRAP_ALGORITHM, masterKey, nonce, { authTagLength: 16 })
      decipher.setAAD(WRAP_AAD)
      decipher.setAuthTag(tag)
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(plaintext)
      } finally {
        plaintext.fill(0)
      }
    },
  }
}
