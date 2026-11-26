import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { protectPrivateDirectory } from '../packages/runtime/windows-private-directory.mjs'

const execFileAsync = promisify(execFile)

describe.skipIf(process.platform !== 'win32')('Windows 私有配置目录', () => {
  it('普通用户可反复初始化目录和既有文件，设置 Medium NRNW 强制标签且不改写凭据内容', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mydsh-private-acl-'))
    try {
      const config = join(root, 'config')
      await protectPrivateDirectory(config)
      const cred = join(config, 'credentials.yaml')
      await writeFile(cred, '验收凭据内容')
      await protectPrivateDirectory(config)
      await protectPrivateDirectory(config)
      expect(await readFile(cred, 'utf8')).toBe('验收凭据内容')
      const { stdout } = await execFileAsync('icacls', [cred], { windowsHide: true })
      expect(stdout).toMatch(/Medium Mandatory Level:\((?:NW,NR|NR,NW)\)/u)
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })
  it('拒绝目录重解析点，不修改它指向的文件', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mydsh-private-junction-'))
    try {
      const target = join(root, 'outside'),
        link = join(root, 'config')
      await mkdir(target)
      await writeFile(join(target, '保留.txt'), '保留')
      await symlink(target, link, 'junction')
      await expect(protectPrivateDirectory(link)).rejects.toThrow('普通目录')
      expect(await readFile(join(target, '保留.txt'), 'utf8')).toBe('保留')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
