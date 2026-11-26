/**
 * Windows 命名管道安全描述符加固：仅允许当前登录用户、当前登录会话（供 WRITE_RESTRICTED 沙箱子进程通过 Pass 2）与 SYSTEM 访问，并附加 Low-Integrity 标签。
 * 复用 `@deepseek-ai/dsh-win32-process` 已验证的 Koffi 绑定约定，失败时抛出中文错误以拒绝不安全暴露。
 */
import type koffi from 'koffi'
import { createLazyRequire } from '@deepseek-ai/dsh-lazy-require'
import {
  allocPtrSlot,
  allocUint32,
  decodePtr,
  decodeUint32,
  extendWin32ProcessBindings,
  isNullPtr,
  throwLastError,
  throwWin32,
  type NativePtr,
  type Win32ProcessBindings,
} from '@deepseek-ai/dsh-win32-process'

type Koffi = typeof koffi

const requireKoffi = createLazyRequire<Koffi>('koffi', import.meta.url)

const PROCESS_QUERY_INFORMATION = 0x0400
const TOKEN_QUERY = 0x0008
const TOKEN_USER_CLASS = 1
const TOKEN_GROUPS_CLASS = 2
const TOKEN_GROUPS_OFFSET = 8
const SID_AND_ATTRIBUTES_SIZE = 16
const SE_GROUP_LOGON_ID = 0xc0000000
const SDDL_REVISION_1 = 1
// 已打开的命名管道句柄在 SetSecurityInfo 中属于 SE_KERNEL_OBJECT（6），可一次原子设置 DACL 与 Mandatory Label。
const SE_KERNEL_OBJECT = 6
const WRITE_DAC = 0x00040000
const WRITE_OWNER = 0x00080000
const OPEN_EXISTING = 3
const INVALID_HANDLE_BITS = 0xffffffffffffffffn
const DACL_SECURITY_INFORMATION = 0x00000004
const LABEL_SECURITY_INFORMATION = 0x00000010
const PROTECTED_DACL_SECURITY_INFORMATION = 0x80000000
const SID_PATTERN = /^S-1-[0-9-]+$/u

interface PipeAclBindings extends Win32ProcessBindings {
  openProcess(desiredAccess: number, inheritHandle: number, pid: number): NativePtr
  openProcessToken(process: NativePtr, access: number, tokenOut: NativePtr): number
  getTokenInformation(
    token: NativePtr,
    cls: number,
    info: Buffer | null,
    len: number,
    neededOut: NativePtr,
  ): number
  convertSidToStringSidW(sid: NativePtr, strOut: NativePtr): number
  convertStringSd(sddl: string, rev: number, sdOut: NativePtr, sizeOut: null): number
  getSdDacl(
    sd: NativePtr,
    presentOut: NativePtr,
    daclOut: NativePtr,
    defaultedOut: NativePtr,
  ): number
  getSdSacl(
    sd: NativePtr,
    presentOut: NativePtr,
    saclOut: NativePtr,
    defaultedOut: NativePtr,
  ): number
  createFileW(
    fileName: string,
    desiredAccess: number,
    shareMode: number,
    securityAttributes: null,
    creationDisposition: number,
    flagsAndAttributes: number,
    templateFile: null,
  ): NativePtr
  setSecurityInfo(
    handle: NativePtr,
    objType: number,
    secInfo: number,
    owner: null,
    group: null,
    dacl: NativePtr | null,
    sacl: NativePtr | null,
  ): number
  localFree(ptr: NativePtr): NativePtr
}

let cachedBindings: PipeAclBindings | undefined

function isInvalidHandle(handle: NativePtr | null | undefined): boolean {
  if (isNullPtr(handle)) return true
  return BigInt.asUintN(64, handle as unknown as bigint) === INVALID_HANDLE_BITS
}

function loadBindings(): PipeAclBindings {
  if (cachedBindings) return cachedBindings
  const koffiMod = requireKoffi()
  const PVOID = koffiMod.pointer('void')
  const PPVOID = koffiMod.pointer(PVOID)
  const PINT = koffiMod.pointer('int')
  const PUINT32 = koffiMod.pointer('uint32')
  cachedBindings = extendWin32ProcessBindings(({ kernel32, advapi32, bind }) => ({
    openProcess: bind(kernel32, 'OpenProcess', PVOID, ['uint32', 'int', 'uint32']),
    openProcessToken: bind(advapi32, 'OpenProcessToken', 'int', [PVOID, 'uint32', PPVOID]),
    getTokenInformation: bind(advapi32, 'GetTokenInformation', 'int', [
      PVOID,
      'int',
      PVOID,
      'uint32',
      PUINT32,
    ]),
    convertSidToStringSidW: bind(advapi32, 'ConvertSidToStringSidW', 'int', [PVOID, PPVOID]),
    convertStringSd: bind(advapi32, 'ConvertStringSecurityDescriptorToSecurityDescriptorW', 'int', [
      'str16',
      'uint32',
      PPVOID,
      PVOID,
    ]),
    getSdDacl: bind(advapi32, 'GetSecurityDescriptorDacl', 'int', [PVOID, PINT, PPVOID, PINT]),
    getSdSacl: bind(advapi32, 'GetSecurityDescriptorSacl', 'int', [PVOID, PINT, PPVOID, PINT]),
    createFileW: bind(kernel32, 'CreateFileW', PVOID, [
      'str16',
      'uint32',
      'uint32',
      PVOID,
      'uint32',
      'uint32',
      PVOID,
    ]),
    setSecurityInfo: bind(advapi32, 'SetSecurityInfo', 'uint32', [
      PVOID,
      'int',
      'uint32',
      PVOID,
      PVOID,
      PVOID,
      PVOID,
    ]),
    localFree: bind(kernel32, 'LocalFree', PVOID, [PVOID]),
  })) as unknown as PipeAclBindings
  return cachedBindings
}

function decodeSidString(api: PipeAclBindings, sidPtr: NativePtr): string {
  const koffiMod = requireKoffi()
  const strSlot = allocPtrSlot()
  try {
    if (api.convertSidToStringSidW(sidPtr, strSlot) === 0) {
      throwLastError(api, 'ConvertSidToStringSidW')
    }
    const rawStrPtr = decodePtr(strSlot)
    if (rawStrPtr === null) throw new Error('无法格式化当前进程 SID 字符串')
    try {
      // Koffi 的 'str16' 解码按 LPWSTR* 槽位读取字符串指针，必须传入 strSlot 而非已解引用的字符地址。
      return String(koffiMod.decode(strSlot, 'str16'))
    } finally {
      api.localFree(rawStrPtr)
    }
  } finally {
    koffiMod.free(strSlot)
  }
}

function queryTokenBuffer(api: PipeAclBindings, token: NativePtr, cls: number): Buffer {
  const koffiMod = requireKoffi()
  const neededSlot = allocUint32()
  try {
    api.getTokenInformation(token, cls, null, 0, neededSlot)
    const size = decodeUint32(neededSlot)
    if (size === 0) throwLastError(api, 'GetTokenInformation', `class ${cls} size`)
    const buffer = Buffer.alloc(size)
    if (api.getTokenInformation(token, cls, buffer, size, neededSlot) === 0) {
      throwLastError(api, 'GetTokenInformation', `class ${cls}`)
    }
    return buffer
  } finally {
    koffiMod.free(neededSlot)
  }
}

function findLogonSid(api: PipeAclBindings, token: NativePtr): string | undefined {
  const koffiMod = requireKoffi()
  const PVOID = koffiMod.pointer('void')
  const groupsBuf = queryTokenBuffer(api, token, TOKEN_GROUPS_CLASS)
  const groupCount = groupsBuf.readUInt32LE(0)
  for (let i = 0; i < groupCount; i += 1) {
    const entryOffset = TOKEN_GROUPS_OFFSET + i * SID_AND_ATTRIBUTES_SIZE
    const attributes = groupsBuf.readUInt32LE(entryOffset + 8)
    const isLogon = (attributes & SE_GROUP_LOGON_ID) >>> 0 === SE_GROUP_LOGON_ID >>> 0
    if (!isLogon) continue
    const sidPtr = koffiMod.decode(groupsBuf, entryOffset, PVOID) as NativePtr | null
    if (!isNullPtr(sidPtr)) return decodeSidString(api, sidPtr)
  }
  return undefined
}

function queryTokenSidStrings(api: PipeAclBindings): { userSid: string; logonSid?: string } {
  const koffiMod = requireKoffi()
  // GetCurrentProcess() 伪句柄无法在 Koffi 中寻址，需经 OpenProcess 打开真实句柄。
  const processHandle = api.openProcess(PROCESS_QUERY_INFORMATION, 0, process.pid)
  if (isNullPtr(processHandle)) throwLastError(api, 'OpenProcess', `pid ${process.pid}`)
  const tokenSlot = allocPtrSlot()
  let token: NativePtr | null = null
  try {
    const opened = api.openProcessToken(processHandle, TOKEN_QUERY, tokenSlot)
    const openError = opened === 0 ? api.getLastError() : 0
    api.closeHandle(processHandle)
    if (opened === 0) throwWin32(api, 'OpenProcessToken', openError, `pid ${process.pid}`)
    token = decodePtr(tokenSlot)
  } finally {
    koffiMod.free(tokenSlot)
  }
  if (token === null) throw new Error('无法打开当前进程令牌以配置命名管道权限')
  try {
    const PVOID = koffiMod.pointer('void')
    const userBuf = queryTokenBuffer(api, token, TOKEN_USER_CLASS)
    const userSidPtr = koffiMod.decode(userBuf, 0, PVOID) as NativePtr | null
    if (isNullPtr(userSidPtr)) throw new Error('无法读取当前进程用户 SID')
    const userSid = decodeSidString(api, userSidPtr)
    const logonSid = findLogonSid(api, token)
    return { userSid, ...(logonSid ? { logonSid } : {}) }
  } finally {
    api.closeHandle(token)
  }
}

function applySecurityDescriptorToPipe(options: {
  readonly api: PipeAclBindings
  readonly koffiMod: Koffi
  readonly pipePath: string
  readonly sd: NativePtr
}): void {
  const { api, koffiMod, pipePath, sd } = options
  const daclPresent = koffiMod.alloc('int', 1) as NativePtr
  const daclSlot = allocPtrSlot()
  const daclDefaulted = koffiMod.alloc('int', 1) as NativePtr
  const saclPresent = koffiMod.alloc('int', 1) as NativePtr
  const saclSlot = allocPtrSlot()
  const saclDefaulted = koffiMod.alloc('int', 1) as NativePtr
  let pipeHandle: NativePtr | null = null
  try {
    if (
      api.getSdDacl(sd, daclPresent, daclSlot, daclDefaulted) === 0 ||
      api.getSdSacl(sd, saclPresent, saclSlot, saclDefaulted) === 0
    ) {
      throwLastError(api, 'GetSecurityDescriptorDacl/Sacl')
    }
    // SetNamedSecurityInfoW 对 NPFS 命名管道设置 LABEL_SECURITY_INFORMATION 会返回 ERROR_INVALID_PARAMETER(87)，
    // 需打开 WRITE_DAC|WRITE_OWNER 句柄后经 SetSecurityInfo(SE_KERNEL_OBJECT) 原子写入 DACL 与完整性标签。
    pipeHandle = api.createFileW(pipePath, WRITE_DAC | WRITE_OWNER, 0, null, OPEN_EXISTING, 0, null)
    if (isInvalidHandle(pipeHandle)) {
      pipeHandle = null
      throwLastError(api, 'CreateFileW', pipePath)
    }
    const status = api.setSecurityInfo(
      pipeHandle,
      SE_KERNEL_OBJECT,
      DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION | LABEL_SECURITY_INFORMATION,
      null,
      null,
      decodePtr(daclSlot),
      decodePtr(saclSlot),
    )
    if (status !== 0) {
      throwWin32(api, 'SetSecurityInfo', status, pipePath)
    }
  } finally {
    if (pipeHandle !== null) api.closeHandle(pipeHandle)
    koffiMod.free(daclPresent)
    koffiMod.free(daclSlot)
    koffiMod.free(daclDefaulted)
    koffiMod.free(saclPresent)
    koffiMod.free(saclSlot)
    koffiMod.free(saclDefaulted)
  }
}

/**
 * 构建 Windows 命名管道的受保护 SDDL 安全描述符字符串。
 * 包含 SYSTEM、当前用户 SID、可选当前登录会话 Logon SID（确保 WRITE_RESTRICTED 沙箱子进程通过 Pass 2 检查）以及 Low Mandatory Label。
 */
export function buildWindowsPipeSddl(userSid: string, logonSid?: string): string {
  if (!SID_PATTERN.test(userSid)) {
    throw new Error(`无效的 Windows 用户 SID："${userSid}"`)
  }
  if (logonSid !== undefined && !SID_PATTERN.test(logonSid)) {
    throw new Error(`无效的 Windows 登录会话 SID："${logonSid}"`)
  }
  const logonAce = logonSid ? `(A;;GRGW;;;${logonSid})` : ''
  // D:P 阻断继承；Logon SID 仅授读写不授改权，S:(ML;;NW;;;LW) 放行当前用户的 Low-IL 沙箱子进程。
  return `D:P(A;;GA;;;SY)(A;;GA;;;${userSid})${logonAce}S:(ML;;NW;;;LW)`
}

/**
 * 为已监听的 Windows 命名管道设置受保护当前用户 DACL 与 Low Mandatory Label。
 * 非 Windows 平台直接跳过；设置失败时抛出中文错误以拒绝不安全暴露。
 */
export function hardenWindowsNamedPipe(pipePath: string): void {
  if (process.platform !== 'win32') return
  const api = loadBindings()
  const koffiMod = requireKoffi()
  const { userSid, logonSid } = queryTokenSidStrings(api)
  const sddl = buildWindowsPipeSddl(userSid, logonSid)
  const sdSlot = allocPtrSlot()
  let sd: NativePtr | null = null
  try {
    if (api.convertStringSd(sddl, SDDL_REVISION_1, sdSlot, null) === 0) {
      throwLastError(api, 'ConvertStringSecurityDescriptorToSecurityDescriptorW')
    }
    sd = decodePtr(sdSlot)
  } finally {
    koffiMod.free(sdSlot)
  }
  if (sd === null) throw new Error('无法构建 Windows 命名管道安全描述符')
  try {
    applySecurityDescriptorToPipe({ api, koffiMod, pipePath, sd })
  } finally {
    api.localFree(sd)
  }
}
