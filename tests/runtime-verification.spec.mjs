import { existsSync, readdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { runRuntimeVerification } from '../scripts/runtime-verification.mjs'

function verifyDirectories() {
  return new Set(readdirSync(tmpdir()).filter(name => name.startsWith('mydsh-verify-')))
}

describe('真实运行时验收 runner', () => {
  it('系统凭据验收保留钥匙串查找环境，MyDSH 数据仍隔离并自动清理', async () => {
    const result = await runRuntimeVerification({
      command: process.execPath,
      args: [
        '-e',
        'console.log(JSON.stringify({userHome:process.env.HOME,mydshHome:process.env.MYDSH_HOME}))',
      ],
      cwd: process.cwd(),
      label: '系统钥匙串环境',
      useSystemKeychain: true,
      timeoutMs: 2000,
    })
    expect(JSON.parse(result.stdout)).toEqual({ userHome: homedir(), mydshHome: result.mydshHome })
    expect(existsSync(result.verifyHome)).toBe(false)
  })
  it('向子进程提供隔离目录并在成功后删除目录', async () => {
    const result = await runRuntimeVerification({
      command: process.execPath,
      args: ['-e', "console.log(process.env.MYDSH_VERIFY_HOME ?? '')"],
      cwd: process.cwd(),
      label: 'runner 成功场景',
      timeoutMs: 2_000,
    })

    expect(result.stdout).toContain(result.verifyHome)
    expect(existsSync(result.verifyHome)).toBe(false)
  })

  it('超过总时限时终止子进程并删除目录', async () => {
    const before = verifyDirectories()
    await expect(
      runRuntimeVerification({
        command: process.execPath,
        args: ['-e', 'setInterval(() => undefined, 1000)'],
        cwd: process.cwd(),
        label: 'runner 超时场景',
        timeoutMs: 50,
      }),
    ).rejects.toThrow('超过 50ms 总时限')
    const after = verifyDirectories()
    expect([...after].filter(name => !before.has(name))).toEqual([])
  })

  it('隔离项目准备失败时仍删除临时目录', async () => {
    const before = verifyDirectories()
    const originalPath = process.env.PATH
    process.env.PATH = ''
    try {
      await expect(
        runRuntimeVerification({
          command: process.execPath,
          args: ['-e', 'process.exit(0)'],
          cwd: process.cwd(),
          label: 'runner 项目准备失败场景',
          timeoutMs: 2_000,
        }),
      ).rejects.toThrow()
    } finally {
      process.env.PATH = originalPath
    }
    const after = verifyDirectories()
    expect([...after].filter(name => !before.has(name))).toEqual([])
  })

  it('已取消的验收不创建目录或启动进程', async () => {
    const before = verifyDirectories()
    await expect(
      runRuntimeVerification({
        command: process.execPath,
        args: ['-e', 'process.exit(0)'],
        cwd: process.cwd(),
        label: '提前取消',
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow('已取消')
    expect([...verifyDirectories()].filter(name => !before.has(name))).toEqual([])
  })

  it('运行中取消会等待子进程退出并清理隔离目录', async () => {
    const before = verifyDirectories()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 100)
    try {
      await expect(
        runRuntimeVerification({
          command: process.execPath,
          args: ['-e', 'setInterval(() => undefined, 1000)'],
          cwd: process.cwd(),
          label: '运行中取消',
          timeoutMs: 5000,
          signal: controller.signal,
        }),
      ).rejects.toThrow('已取消')
    } finally {
      clearTimeout(timer)
    }
    expect([...verifyDirectories()].filter(name => !before.has(name))).toEqual([])
  })
})
