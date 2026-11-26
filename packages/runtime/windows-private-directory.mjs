/** 凭据沿用文件提供方；Windows 由受保护的目录 DACL 与 Medium No-Read-Up 标签覆盖原文件、锁和原子写入临时文件。 */
import { execFile } from 'node:child_process'
import { lstat, mkdir, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const require = createRequire(import.meta.url)

const SE_FILE_OBJECT = 1
const TOKEN_QUERY = 0x0008
const TOKEN_USER_CLASS = 1
const SDDL_REVISION_1 = 1
const DACL_SECURITY_INFORMATION = 0x00000004
const LABEL_SECURITY_INFORMATION = 0x00000010
const PROTECTED_DACL_SECURITY_INFORMATION = 0x80000000
const PROTECT_SEC_INFO =
  (DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION | LABEL_SECURITY_INFORMATION) >>>
  0

let cachedKoffiApi

const protectFallbackScript = String.raw`
$ErrorActionPreference = 'Stop'
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class MydshPrivateAcl {
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
function Protect-MydshEntry([string] $path) {
  $entry = Get-Item -LiteralPath $path -Force
  if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw '私有配置目录不能包含重解析点' }
  $sddl = if ($entry.PSIsContainer) {
    "D:P(A;OICI;FA;;;$sid)(A;OICI;FA;;;SY)S:(ML;OICI;NRNW;;;ME)"
  } else {
    "D:P(A;;FA;;;$sid)(A;;FA;;;SY)S:(ML;;NRNW;;;ME)"
  }
  $status = [MydshPrivateAcl]::Apply((Format-LongPath $path), $sddl)
  if ($status -ne 0) { throw "设置私有目录安全描述符失败（Win32 $status）" }
  if ($entry.PSIsContainer) {
    foreach ($child in Get-ChildItem -LiteralPath $path -Force) { Protect-MydshEntry $child.FullName }
  }
}
Protect-MydshEntry $env:MYDSH_PRIVATE_DIRECTORY
`

function loadKoffiModule() {
  for (const loader of [
    () => require('koffi'),
    () => createRequire(new URL('../cli/cli-bridge/package.json', import.meta.url))('koffi'),
  ]) {
    try {
      return loader()
    } catch {
      /* 在未携带 koffi 的开发或降级环境下回退到 PowerShell。 */
    }
  }
  return null
}

function getWin32AclApi() {
  if (cachedKoffiApi !== undefined) return cachedKoffiApi
  const koffi = loadKoffiModule()
  if (!koffi) {
    cachedKoffiApi = null
    return null
  }
  const kernel32 = koffi.load('kernel32.dll')
  const advapi32 = koffi.load('advapi32.dll')
  cachedKoffiApi = {
    koffi,
    GetCurrentProcess: kernel32.func('void * GetCurrentProcess()'),
    CloseHandle: kernel32.func('bool CloseHandle(void *handle)'),
    LocalFree: kernel32.func('void * LocalFree(void *mem)'),
    OpenProcessToken: advapi32.func(
      'bool OpenProcessToken(void *proc, uint32 access, void **outToken)',
    ),
    GetTokenInformation: advapi32.func(
      'bool GetTokenInformation(void *token, uint32 infoClass, void *buf, uint32 len, uint32 *outLen)',
    ),
    ConvertSidToStringSidW: advapi32.func('bool ConvertSidToStringSidW(void *sid, void **outStr)'),
    ConvertStringSecurityDescriptorToSecurityDescriptorW: advapi32.func(
      'bool ConvertStringSecurityDescriptorToSecurityDescriptorW(str16 sddl, uint32 rev, void **outSd, void *outSize)',
    ),
    GetSecurityDescriptorDacl: advapi32.func(
      'bool GetSecurityDescriptorDacl(void *sd, int *outPresent, void **outDacl, int *outDefaulted)',
    ),
    GetSecurityDescriptorSacl: advapi32.func(
      'bool GetSecurityDescriptorSacl(void *sd, int *outPresent, void **outSacl, int *outDefaulted)',
    ),
    SetNamedSecurityInfoW: advapi32.func(
      'uint32 SetNamedSecurityInfoW(str16 name, int objType, uint32 secInfo, void *owner, void *group, void *dacl, void *sacl)',
    ),
  }
  return cachedKoffiApi
}

function queryCurrentUserSid(api) {
  const { koffi } = api
  const tokenSlot = koffi.alloc('void *', 1)
  const sizeSlot = koffi.alloc('uint32', 1)
  const strSlot = koffi.alloc('void *', 1)
  let tokenHandle = null
  let tokenBuf = null
  let sidStrPtr = null
  try {
    if (!api.OpenProcessToken(api.GetCurrentProcess(), TOKEN_QUERY, tokenSlot))
      throw new Error('OpenProcessToken 失败')
    tokenHandle = koffi.decode(tokenSlot, 'void *')
    api.GetTokenInformation(tokenHandle, TOKEN_USER_CLASS, null, 0, sizeSlot)
    const size = koffi.decode(sizeSlot, 'uint32')
    if (!size) throw new Error('GetTokenInformation 未返回缓冲区长度')
    tokenBuf = koffi.alloc('uint8', size)
    if (!api.GetTokenInformation(tokenHandle, TOKEN_USER_CLASS, tokenBuf, size, sizeSlot))
      throw new Error('GetTokenInformation 读取当前用户 SID 失败')
    const sidPtr = koffi.decode(tokenBuf, 'void *')
    if (!api.ConvertSidToStringSidW(sidPtr, strSlot)) throw new Error('ConvertSidToStringSidW 失败')
    sidStrPtr = koffi.decode(strSlot, 'void *')
    const sid = koffi.decode(strSlot, 'str16')
    if (!/^S-1-[0-9-]+$/u.test(sid)) throw new Error('解析当前用户 SID 格式异常')
    return sid
  } finally {
    if (sidStrPtr) api.LocalFree(sidStrPtr)
    if (tokenHandle) api.CloseHandle(tokenHandle)
    if (tokenBuf) koffi.free(tokenBuf)
    koffi.free(strSlot)
    koffi.free(sizeSlot)
    koffi.free(tokenSlot)
  }
}

function applySddlViaKoffi(api, targetPath, sddl) {
  const { koffi } = api
  const sdSlot = koffi.alloc('void *', 1)
  const daclPresent = koffi.alloc('int', 1)
  const daclDefaulted = koffi.alloc('int', 1)
  const daclSlot = koffi.alloc('void *', 1)
  const saclPresent = koffi.alloc('int', 1)
  const saclDefaulted = koffi.alloc('int', 1)
  const saclSlot = koffi.alloc('void *', 1)
  let sdPtr = null
  try {
    if (
      !api.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, SDDL_REVISION_1, sdSlot, null)
    )
      throw new Error('解析私有目录 SDDL 失败')
    sdPtr = koffi.decode(sdSlot, 'void *')
    if (!api.GetSecurityDescriptorDacl(sdPtr, daclPresent, daclSlot, daclDefaulted))
      throw new Error('读取 DACL 失败')
    if (!api.GetSecurityDescriptorSacl(sdPtr, saclPresent, saclSlot, saclDefaulted))
      throw new Error('读取 SACL 失败')
    const dacl = koffi.decode(daclSlot, 'void *')
    const sacl = koffi.decode(saclSlot, 'void *')
    const status = api.SetNamedSecurityInfoW(
      formatWindowsLongPath(targetPath),
      SE_FILE_OBJECT,
      PROTECT_SEC_INFO,
      null,
      null,
      dacl,
      sacl,
    )
    if (status !== 0) throw new Error(`设置私有目录安全描述符失败（Win32 ${status}）`)
  } finally {
    if (sdPtr) api.LocalFree(sdPtr)
    koffi.free(saclSlot)
    koffi.free(saclDefaulted)
    koffi.free(saclPresent)
    koffi.free(daclSlot)
    koffi.free(daclDefaulted)
    koffi.free(daclPresent)
    koffi.free(sdSlot)
  }
}

function formatWindowsLongPath(targetPath) {
  const full = resolve(targetPath)
  if (full.startsWith('\\\\?\\')) return full
  return full.length >= 240 && /^[A-Za-z]:\\/u.test(full) ? `\\\\?\\${full}` : full
}

async function protectTreeViaKoffi(api, sid, targetPath) {
  const info = await lstat(targetPath)
  if (info.isSymbolicLink()) throw new Error('私有配置目录不能包含重解析点')
  const isDir = info.isDirectory()
  const sddl = isDir
    ? `D:P(A;OICI;FA;;;${sid})(A;OICI;FA;;;SY)S:(ML;OICI;NRNW;;;ME)`
    : `D:P(A;;FA;;;${sid})(A;;FA;;;SY)S:(ML;;NRNW;;;ME)`
  applySddlViaKoffi(api, targetPath, sddl)
  if (!isDir) return
  const entries = await readdir(targetPath)
  await Promise.all(entries.map(name => protectTreeViaKoffi(api, sid, join(targetPath, name))))
}

/**
 * 创建并锁定 MyDSH 私有配置目录：macOS/Linux 使用 0700，Windows 优先经原生 Win32 API 施加受保护 DACL 与 Medium No-Read-Up 标签。
 * @param {string} directory 需要保护的配置目录路径
 */
export async function protectPrivateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const entry = await lstat(directory)
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('私有配置路径必须是普通目录')
  if (process.platform !== 'win32') return
  try {
    const api = getWin32AclApi()
    if (api) {
      const sid = queryCurrentUserSid(api)
      await protectTreeViaKoffi(api, sid, directory)
      return
    }
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
        Buffer.from(protectFallbackScript, 'utf16le').toString('base64'),
      ],
      {
        windowsHide: true,
        timeout: 45_000,
        env: { ...process.env, MYDSH_PRIVATE_DIRECTORY: directory },
      },
    )
  } catch (cause) {
    throw new Error('无法设置 MyDSH 私有配置目录权限，核心启动已停止', { cause })
  }
}
