import { describe, expect, it, vi } from 'vitest'
import { renameWithRetry } from '../src/runtime/filesystem/file-operations.ts'

describe('Windows 原子替换的占用恢复', () => {
  it('短暂占用只重试同一对路径，最终完成替换', async () => {
    const rename = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('暂时占用'), { code: 'EBUSY' }))
      .mockResolvedValue(undefined)
    const wait = vi.fn().mockResolvedValue(undefined)
    await renameWithRetry('临时文件', '原文件', { platform: 'win32', rename, wait })
    expect(rename.mock.calls).toEqual([
      ['临时文件', '原文件'],
      ['临时文件', '原文件'],
    ])
    expect(wait).toHaveBeenCalledWith(20)
  })
  it('持续占用有上限，非瞬态错误及其他平台立即返回错误', async () => {
    const failure = Object.assign(new Error('持续占用'), { code: 'EPERM' })
    const rename = vi.fn().mockRejectedValue(failure)
    const wait = vi.fn().mockResolvedValue(undefined)
    await expect(
      renameWithRetry('临时文件', '原文件', { platform: 'win32', rename, wait }),
    ).rejects.toBe(failure)
    expect(rename).toHaveBeenCalledTimes(9)
    rename.mockClear()
    await expect(
      renameWithRetry('临时文件', '原文件', { platform: 'darwin', rename, wait }),
    ).rejects.toBe(failure)
    expect(rename).toHaveBeenCalledOnce()
    rename.mockClear().mockRejectedValue(Object.assign(new Error('目标无效'), { code: 'ENOENT' }))
    await expect(
      renameWithRetry('临时文件', '原文件', { platform: 'win32', rename, wait }),
    ).rejects.toThrow('目标无效')
    expect(rename).toHaveBeenCalledOnce()
  })
})
