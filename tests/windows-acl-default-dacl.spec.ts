/**
 * Windows ACL 沙箱受限令牌默认 DACL 回归测试：覆盖提权管理员宿主下 LUA_TOKEN 匿名管道 Pass 1/Pass 2 权限、失败封闭路径与原生资源清理。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { buildExplicitAccess } from '../packages/sandbox/sandbox-windows-acl/src/acl.ts'
import {
  allocPtrSlot,
  decodePtr,
  ptrAddress,
  win32,
  type NativePtr,
  type Win32Bindings,
} from '../packages/sandbox/sandbox-windows-acl/src/ffi.ts'
import {
  drainPipe,
  spawnSandboxed,
  waitForExit,
} from '../packages/sandbox/sandbox-windows-acl/src/spawn.ts'
import {
  createRestrictedToken,
  findLogonSid,
  makeWellKnownSid,
  openCurrentProcessToken,
  restrictTokenIntegrity,
  setTokenDefaultDaclGrant,
} from '../packages/sandbox/sandbox-windows-acl/src/token.ts'
import * as abi from '../packages/sandbox/sandbox-windows-acl/src/win32-abi.ts'
import {
  tempWriteSid,
  workspaceWriteSid,
} from '../packages/sandbox/sandbox-windows-acl/src/workspace-sid.ts'

const asPtr = (value: bigint): NativePtr => value as NativePtr
const asMockBuffer = (slot: NativePtr): Buffer | null =>
  Buffer.isBuffer(slot as unknown) ? (slot as unknown as Buffer) : null
const writeMockUint32 = (slot: NativePtr, value: number): void => {
  ;(slot as unknown as Buffer).writeUInt32LE(value, 0)
}
const WIN_LOCAL_SYSTEM_SID = 22
const WIN_BUILTIN_ADMINISTRATORS_SID = 26

const mockState = vi.hoisted(() => ({ enabled: false }))

vi.mock('../packages/sandbox/sandbox-windows-acl/src/ffi.ts', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../packages/sandbox/sandbox-windows-acl/src/ffi.ts')>()
  return {
    ...actual,
    allocUint32: () =>
      mockState.enabled ? (Buffer.alloc(4) as unknown as NativePtr) : actual.allocUint32(),
    decodeUint32: (slot: NativePtr) => {
      const buffer = mockState.enabled ? asMockBuffer(slot) : null
      return buffer !== null ? buffer.readUInt32LE(0) : actual.decodeUint32(slot)
    },
    encodeUint32: (slot: NativePtr, value: number) => {
      const buffer = mockState.enabled ? asMockBuffer(slot) : null
      if (buffer !== null) {
        buffer.writeUInt32LE(value, 0)
        return
      }
      actual.encodeUint32(slot, value)
    },
    allocPtrSlot: () =>
      mockState.enabled ? (Buffer.alloc(8) as unknown as NativePtr) : actual.allocPtrSlot(),
    decodePtr: (slot: NativePtr) => {
      const buffer = mockState.enabled ? asMockBuffer(slot) : null
      if (buffer !== null) {
        const value = buffer.readBigUInt64LE(0)
        return value === 0n ? null : (value as NativePtr)
      }
      return actual.decodePtr(slot)
    },
    decodePtrAt: (buffer: Buffer, offset: number) => {
      if (mockState.enabled) {
        const value = buffer.readBigUInt64LE(offset)
        return value === 0n ? null : (value as NativePtr)
      }
      return actual.decodePtrAt(buffer, offset)
    },
    ptrAddress: (ptr: NativePtr) =>
      mockState.enabled && typeof ptr === 'bigint' ? ptr : actual.ptrAddress(ptr),
  }
})

function withMockSlots<T>(fn: () => T): T {
  mockState.enabled = true
  try {
    return fn()
  } finally {
    mockState.enabled = false
  }
}

function createMockDefaultDaclApi(options: {
  readonly daclPtr?: bigint
  readonly userSize?: number
  readonly userReadFail?: boolean
  readonly userSidPtr?: bigint
  readonly setEntriesResult?: number
  readonly setTokenInfoFail?: boolean
}) {
  const token = asPtr(0x1001n)
  const restrictSid = asPtr(0x2002n)
  const daclPtr = options.daclPtr ?? 0x3003n
  const userSidPtr = options.userSidPtr ?? 0x4004n
  const mergedDacl = asPtr(0x5005n)
  const freed: NativePtr[] = []
  let capturedCount = 0
  let capturedEntries: Buffer | undefined
  let appliedDacl: bigint | undefined
  let lastError = 5

  // 用真实可写 Buffer 模拟 Win32 输出槽，便于跨平台验证 setTokenDefaultDaclGrant 的打包与错误处理逻辑。
  const getTokenInformation = vi.fn(
    (...callArgs: Parameters<Win32Bindings['getTokenInformation']>): number => {
      const [, cls, info, , neededSlot] = callArgs
      if (cls === abi.TokenDefaultDacl) {
        if (info === null) {
          writeMockUint32(neededSlot, 8)
          return 0
        }
        info.writeBigUInt64LE(daclPtr, 0)
        return 1
      }
      if (cls === abi.TokenUser) {
        const size = options.userSize ?? 32
        if (info === null) {
          writeMockUint32(neededSlot, size)
          return 0
        }
        if (options.userReadFail) {
          lastError = 122
          return 0
        }
        info.writeBigUInt64LE(userSidPtr, 0)
        return 1
      }
      return 0
    },
  )

  const setEntriesInAclW = vi.fn(
    (count: number, entries: Buffer, _oldAcl: NativePtr | null, newAclSlot: NativePtr): number => {
      capturedCount = count
      capturedEntries = Buffer.from(entries)
      if ((options.setEntriesResult ?? abi.ERROR_SUCCESS) !== abi.ERROR_SUCCESS) {
        return options.setEntriesResult ?? 5
      }
      ;(newAclSlot as unknown as Buffer).writeBigUInt64LE(mergedDacl, 0)
      return abi.ERROR_SUCCESS
    },
  )

  const setTokenInformation = vi.fn((_token: NativePtr, cls: number, info: Buffer): number => {
    if (cls === abi.TokenDefaultDacl) {
      appliedDacl = info.readBigUInt64LE(0)
    }
    if (options.setTokenInfoFail) {
      lastError = 5
      return 0
    }
    return 1
  })

  const localFree = vi.fn((ptr: NativePtr): NativePtr => {
    freed.push(ptr)
    return asPtr(0n)
  })

  const api = {
    getTokenInformation,
    setEntriesInAclW,
    setTokenInformation,
    localFree,
    getLastError: () => lastError,
    formatMessageW: () => 0,
  } as unknown as Win32Bindings

  return {
    api,
    token,
    restrictSid,
    userSidPtr,
    mergedDacl,
    freed,
    setEntriesInAclW,
    getCaptured: () => ({ capturedCount, capturedEntries, appliedDacl }),
  }
}

async function runConfinedCmd(api: Win32Bindings, token: NativePtr, cwd: string, command: string) {
  const child = spawnSandboxed(api, token, { command: 'cmd.exe', args: ['/c', command], cwd })
  const [stdout, stderr] = await Promise.all([
    drainPipe(api, child.stdoutRead),
    drainPipe(api, child.stderrRead),
  ])
  const exitCode = waitForExit(api, child.process)
  return {
    exitCode,
    stdout: stdout.toString('utf8').trim(),
    stderr: stderr.toString('utf8').trim(),
  }
}

describe('Windows ACL 受限令牌默认 DACL 合并逻辑', () => {
  it('同时合并 TokenUser（GENERIC_ALL）与受限能力 SID（FILE_ALL_ACCESS）并释放临时 ACL', () => {
    withMockSlots(() => {
      const mock = createMockDefaultDaclApi({})
      setTokenDefaultDaclGrant(mock.api, mock.token, mock.restrictSid)

      const { capturedCount, capturedEntries, appliedDacl } = mock.getCaptured()
      expect(capturedCount).toBe(2)
      expect(capturedEntries?.length).toBe(abi.EXPLICIT_ACCESS_W_SIZE * 2)
      // 第一条为 TokenUser（Pass 1），第二条为受限能力 SID（Pass 2）。
      expect(capturedEntries?.readUInt32LE(0)).toBe(abi.GENERIC_ALL)
      expect(capturedEntries?.readUInt32LE(4)).toBe(abi.GRANT_ACCESS)
      expect(capturedEntries?.readBigUInt64LE(40)).toBe(mock.userSidPtr)
      expect(capturedEntries?.readUInt32LE(abi.EXPLICIT_ACCESS_W_SIZE)).toBe(abi.FILE_ALL_ACCESS)
      expect(capturedEntries?.readUInt32LE(abi.EXPLICIT_ACCESS_W_SIZE + 4)).toBe(abi.GRANT_ACCESS)
      expect(capturedEntries?.readBigUInt64LE(abi.EXPLICIT_ACCESS_W_SIZE + 40)).toBe(
        mock.restrictSid,
      )
      expect(appliedDacl).toBe(mock.mergedDacl)
      expect(mock.freed).toEqual([mock.mergedDacl])
    })
  })

  it('TokenUser 尺寸异常或读取失败时立即失败封闭，不调用 SetEntriesInAclW', () => {
    withMockSlots(() => {
      const zeroSize = createMockDefaultDaclApi({ userSize: 0 })
      expect(() =>
        setTokenDefaultDaclGrant(zeroSize.api, zeroSize.token, zeroSize.restrictSid),
      ).toThrow('TokenUser size query')
      expect(zeroSize.setEntriesInAclW).not.toHaveBeenCalled()

      const tinySize = createMockDefaultDaclApi({ userSize: 8 })
      expect(() =>
        setTokenDefaultDaclGrant(tinySize.api, tinySize.token, tinySize.restrictSid),
      ).toThrow('implausible TokenUser size 8')
      expect(tinySize.setEntriesInAclW).not.toHaveBeenCalled()

      const readFail = createMockDefaultDaclApi({ userReadFail: true })
      expect(() =>
        setTokenDefaultDaclGrant(readFail.api, readFail.token, readFail.restrictSid),
      ).toThrow('TokenUser')
      expect(readFail.setEntriesInAclW).not.toHaveBeenCalled()

      const nullSid = createMockDefaultDaclApi({ userSidPtr: 0n })
      expect(() =>
        setTokenDefaultDaclGrant(nullSid.api, nullSid.token, nullSid.restrictSid),
      ).toThrow('null TokenUser SID')
      expect(nullSid.setEntriesInAclW).not.toHaveBeenCalled()
    })
  })

  it('缺少原始默认 DACL 或 SetTokenInformation 失败时走失败封闭与释放清理路径', () => {
    withMockSlots(() => {
      const nullDacl = createMockDefaultDaclApi({ daclPtr: 0n })
      expect(() =>
        setTokenDefaultDaclGrant(nullDacl.api, nullDacl.token, nullDacl.restrictSid),
      ).toThrow('carries no default DACL')
      expect(nullDacl.setEntriesInAclW).not.toHaveBeenCalled()

      const setInfoFail = createMockDefaultDaclApi({ setTokenInfoFail: true })
      expect(() =>
        setTokenDefaultDaclGrant(setInfoFail.api, setInfoFail.token, setInfoFail.restrictSid),
      ).toThrow('SetTokenInformation')
      expect(setInfoFail.freed).toEqual([setInfoFail.mergedDacl])
    })
  })

  it.runIf(process.platform === 'win32')(
    '在模拟提权管理员默认 DACL（仅含 SYSTEM 与 Administrators）与标准令牌下均允许受限子进程匿名管道',
    async () => {
      const api = await win32()
      const ws = mkdtempSync(join(tmpdir(), 'mydsh-dacl-test-ws-'))
      const td = mkdtempSync(join(tmpdir(), 'mydsh-dacl-test-td-'))
      let currentToken: NativePtr | undefined
      let elevatedLikeToken: NativePtr | undefined
      let normalToken: NativePtr | undefined
      const localFreeList: NativePtr[] = []
      try {
        currentToken = openCurrentProcessToken(api)
        const logonSid = findLogonSid(api, currentToken)
        const worldSid = makeWellKnownSid(api, abi.WinWorldSid)
        const lowSid = makeWellKnownSid(api, abi.WinLowLabelSid)
        const systemSid = makeWellKnownSid(api, WIN_LOCAL_SYSTEM_SID)
        const adminSid = makeWellKnownSid(api, WIN_BUILTIN_ADMINISTRATORS_SID)

        const parseSid = (sid: string): NativePtr => {
          const slot = allocPtrSlot()
          expect(api.convertStringSidToSidW(sid, slot)).not.toBe(0)
          const parsed = decodePtr(slot)
          expect(parsed).not.toBeNull()
          localFreeList.push(parsed as NativePtr)
          return parsed as NativePtr
        }
        const wsSidPtr = parseSid(workspaceWriteSid(ws))
        const tdSidPtr = parseSid(tempWriteSid(td))

        // 1. 复现提权管理员宿主缺陷形态：默认 DACL 仅含 SYSTEM、被 LUA_TOKEN 禁用的 Administrators 与 Pass 2 能力 SID。
        elevatedLikeToken = createRestrictedToken(
          api,
          currentToken,
          logonSid,
          [wsSidPtr, tdSidPtr],
          { world: worldSid },
          'workspace-write',
        )
        restrictTokenIntegrity(api, elevatedLikeToken, lowSid)

        const brokenEntries = Buffer.concat([
          buildExplicitAccess(systemSid, abi.GRANT_ACCESS, abi.GENERIC_ALL),
          buildExplicitAccess(adminSid, abi.GRANT_ACCESS, abi.GENERIC_ALL),
          buildExplicitAccess(tdSidPtr, abi.GRANT_ACCESS, abi.FILE_ALL_ACCESS),
        ])
        const brokenSlot = allocPtrSlot()
        expect(api.setEntriesInAclW(3, brokenEntries, null, brokenSlot)).toBe(abi.ERROR_SUCCESS)
        const brokenDacl = decodePtr(brokenSlot) as NativePtr
        const brokenInfo = Buffer.alloc(8)
        brokenInfo.writeBigUInt64LE(ptrAddress(brokenDacl), 0)
        expect(
          api.setTokenInformation(elevatedLikeToken, abi.TokenDefaultDacl, brokenInfo, 8),
        ).not.toBe(0)
        api.localFree(brokenDacl)

        const soloBeforeFix = await runConfinedCmd(api, elevatedLikeToken, ws, 'echo solo-ok')
        expect(soloBeforeFix).toEqual({ exitCode: 0, stdout: 'solo-ok', stderr: '' })
        const pipeBeforeFix = await runConfinedCmd(
          api,
          elevatedLikeToken,
          ws,
          'echo hello-pipe | findstr hello',
        )
        expect(pipeBeforeFix.exitCode).not.toBe(0)

        // 2. 应用 setTokenDefaultDaclGrant 合并 TokenUser 与能力 SID 后，匿名管道应立即恢复正常。
        setTokenDefaultDaclGrant(api, elevatedLikeToken, tdSidPtr)
        const pipeAfterFix = await runConfinedCmd(
          api,
          elevatedLikeToken,
          ws,
          'echo hello-pipe | findstr hello',
        )
        expect(pipeAfterFix).toEqual({ exitCode: 0, stdout: 'hello-pipe', stderr: '' })

        // 3. 在当前宿主原始默认 DACL 上直接调用 setTokenDefaultDaclGrant 也必须幂等兼容。
        normalToken = createRestrictedToken(
          api,
          currentToken,
          logonSid,
          [wsSidPtr, tdSidPtr],
          { world: worldSid },
          'workspace-write',
        )
        restrictTokenIntegrity(api, normalToken, lowSid)
        setTokenDefaultDaclGrant(api, normalToken, tdSidPtr)
        const normalPipe = await runConfinedCmd(
          api,
          normalToken,
          ws,
          'echo normal-pipe | findstr normal',
        )
        expect(normalPipe).toEqual({ exitCode: 0, stdout: 'normal-pipe', stderr: '' })
      } finally {
        if (normalToken !== undefined) api.closeHandle(normalToken)
        if (elevatedLikeToken !== undefined) api.closeHandle(elevatedLikeToken)
        if (currentToken !== undefined) api.closeHandle(currentToken)
        for (const ptr of localFreeList) api.localFree(ptr)
        rmSync(ws, { recursive: true, force: true })
        rmSync(td, { recursive: true, force: true })
      }
    },
  )
})
