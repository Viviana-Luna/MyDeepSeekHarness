import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import { LocalFileSystem } from '../packages/fs/fs-local/lib/index.js'
import { privateFileSystem, privateProcessSpec } from '../packages/runtime/private-files.mjs'
import { seatbeltProfileArgs } from '../packages/sandbox/sandbox-local/lib/profiles.js'

it('MyDSH 文件服务与 macOS 子进程保护私有配置，普通文件仍能读取', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mydsh-private-test-'))),
    ctx = new Context()
  const config = join(root, 'config'),
    work = join(root, 'work'),
    secret = join(config, 'credentials.yaml')
  try {
    await mkdir(config)
    await mkdir(work)
    await writeFile(secret, 'fixture-private-only', { mode: 0o600 })
    await writeFile(join(work, 'normal'), '普通文件')
    // Windows 非开发者模式使用目录联接指向 config，仍完整验证私有目录别名逃逸拦截。
    const aliasPath =
      process.platform === 'win32'
        ? join(work, 'alias-dir', 'credentials.yaml')
        : join(work, 'alias')
    if (process.platform === 'win32') {
      await symlink(config, join(work, 'alias-dir'), 'junction')
    } else {
      await symlink(secret, join(work, 'alias'))
    }
    await ctx.plugin(privateFileSystem(LocalFileSystem, config), { cwd: work }).await()
    expect(await ctx.fs.readText(await ctx.fs.resolve('normal'))).toBe('普通文件')
    await expect(ctx.fs.resolve(secret)).rejects.toThrow('私有配置')
    await expect(ctx.fs.resolve(aliasPath)).rejects.toThrow('私有配置')
    await expect(ctx.fs.readText({ targetKey: secret, displayPath: secret })).rejects.toThrow(
      '私有配置',
    )
    if (process.platform === 'darwin') {
      const read = path => {
        const spec = privateProcessSpec({ argv: ['/bin/cat', path] }, config)
        return spawnSync(spec.argv[0], spec.argv.slice(1), { encoding: 'utf8', timeout: 5000 })
      }
      expect(read(join(work, 'normal')).stdout).toBe('普通文件')
      expect(read(secret).status).not.toBe(0)
      expect(read(join(work, 'alias')).stdout).toBe('')
      const existing = privateProcessSpec(
        {
          argv: [
            '/usr/bin/sandbox-exec',
            ...seatbeltProfileArgs({ mode: 'workspace-write', workspaceRoot: work }),
            '--',
            '/bin/cat',
            secret,
          ],
        },
        config,
      )
      expect(
        spawnSync(existing.argv[0], existing.argv.slice(1), { encoding: 'utf8', timeout: 5000 })
          .status,
      ).not.toBe(0)
    }
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
