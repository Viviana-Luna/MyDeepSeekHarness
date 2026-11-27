/**
 * macOS DMG 构建与 hdiutil 瞬态重试单元测试：覆盖瞬态错误识别、有界递增退避、
 * 非瞬态立即失败以及重试前后和重试耗尽后的临时镜像与临时目录清理路径。
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_HDIUTIL_RETRY_DELAYS_MS,
  createMacosDmg,
  formatHdiutilErrorDetail,
  isTransientHdiutilError,
  runHdiutilWithRetry,
} from '../scripts/macos-hdiutil.mjs'

function createExecError({
  message = 'Command failed: /usr/bin/hdiutil',
  stderr = '',
  stdout = '',
  code,
}) {
  const error = new Error(message)
  error.stderr = stderr
  error.stdout = stdout
  if (code !== undefined) error.code = code
  return error
}

describe('macOS hdiutil 瞬态错误识别与诊断提取', () => {
  it('准确识别 stderr、stdout、message 与错误码中的明确瞬态繁忙错误', () => {
    expect(
      isTransientHdiutilError(
        createExecError({ stderr: 'hdiutil: create failed - Resource busy\n' }),
      ),
    ).toBe(true)
    expect(
      isTransientHdiutilError(
        createExecError({
          stderr: Buffer.from('hdiutil: detach failed - Resource temporarily unavailable\n'),
        }),
      ),
    ).toBe(true)
    expect(
      isTransientHdiutilError(createExecError({ stdout: 'diskimages-helper: resource busy' })),
    ).toBe(true)
    expect(
      isTransientHdiutilError(new Error('hdiutil attach failed: temporarily unavailable')),
    ).toBe(true)
    expect(isTransientHdiutilError(createExecError({ code: 'EBUSY' }))).toBe(true)
    expect(isTransientHdiutilError(createExecError({ code: 'EAGAIN' }))).toBe(true)
  })

  it('不将非瞬态失败误判为可重试错误', () => {
    expect(
      isTransientHdiutilError(
        createExecError({ stderr: 'hdiutil: create failed - No such file or directory\n' }),
      ),
    ).toBe(false)
    expect(
      isTransientHdiutilError(
        createExecError({ stderr: 'hdiutil: verify failed - image not recognized\n' }),
      ),
    ).toBe(false)
    expect(
      isTransientHdiutilError(createExecError({ code: 'ENOENT', message: 'spawn ENOENT' })),
    ).toBe(false)
    expect(isTransientHdiutilError(null)).toBe(false)
  })

  it('优先提取原始 stderr，缺失时回退至 stdout 与 message', () => {
    expect(
      formatHdiutilErrorDetail(
        createExecError({
          message: 'Command failed',
          stderr: Buffer.from('  hdiutil: create failed - Resource busy \n'),
          stdout: 'created: partial',
        }),
      ),
    ).toBe('hdiutil: create failed - Resource busy')
    expect(
      formatHdiutilErrorDetail(
        createExecError({
          message: 'Command failed',
          stdout: '  hdiutil: verify failed - corrupt  ',
        }),
      ),
    ).toBe('hdiutil: verify failed - corrupt')
    expect(formatHdiutilErrorDetail(new Error('自定义失败原因'))).toBe('自定义失败原因')
  })
})

describe('runHdiutilWithRetry', () => {
  it('默认退避配置为 5 次尝试且间隔递增', () => {
    expect(DEFAULT_HDIUTIL_RETRY_DELAYS_MS).toEqual([1000, 2000, 4000, 6000])
  })

  it('遇到瞬态繁忙错误时按退避间隔重试并在后续尝试成功后返回结果', async () => {
    const delays = []
    const retryEvents = []
    const cleanedAttempts = []
    let calls = 0

    const result = await runHdiutilWithRetry(['detach', '/tmp/mydsh-mount'], {
      retryDelaysMs: [1000, 2000, 4000],
      sleep: async ms => {
        delays.push(ms)
      },
      onRetry: event => {
        retryEvents.push({
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          delayMs: event.delayMs,
        })
      },
      beforeRetry: event => {
        cleanedAttempts.push(event.attempt)
      },
      runCommand: async () => {
        calls += 1
        if (calls === 1) {
          throw createExecError({ stderr: 'hdiutil: couldn\'t eject "disk4" - Resource busy\n' })
        }
        if (calls === 2) {
          throw createExecError({
            stderr: Buffer.from('hdiutil: detach failed - Resource temporarily unavailable\n'),
          })
        }
        return { stdout: '"disk4" ejected.', stderr: '' }
      },
    })

    expect(result).toEqual({ stdout: '"disk4" ejected.', stderr: '' })
    expect(calls).toBe(3)
    expect(delays).toEqual([1000, 2000])
    expect(cleanedAttempts).toEqual([1, 2])
    expect(retryEvents).toEqual([
      { attempt: 1, maxAttempts: 4, delayMs: 1000 },
      { attempt: 2, maxAttempts: 4, delayMs: 2000 },
    ])
  })

  it('遇到非瞬态错误立即原样抛出，不重试、不等待也不吞错', async () => {
    const originalError = createExecError({
      stderr: 'hdiutil: verify failed - image not recognized\n',
    })
    const delays = []
    let beforeRetryCount = 0
    let onRetryCount = 0
    let calls = 0

    let caught
    try {
      await runHdiutilWithRetry(['verify', '/tmp/broken.dmg'], {
        sleep: async ms => {
          delays.push(ms)
        },
        beforeRetry: () => {
          beforeRetryCount += 1
        },
        onRetry: () => {
          onRetryCount += 1
        },
        runCommand: async () => {
          calls += 1
          throw originalError
        },
      })
    } catch (error) {
      caught = error
    }

    expect(caught).toBe(originalError)
    expect(calls).toBe(1)
    expect(delays).toEqual([])
    expect(beforeRetryCount).toBe(0)
    expect(onRetryCount).toBe(0)
  })

  it('全部瞬态重试耗尽后抛出带尝试次数与原始 stderr 的中文错误并保留 cause', async () => {
    const delays = []
    let calls = 0
    const lastError = createExecError({ stderr: 'hdiutil: create failed - Resource busy\n' })

    let caught
    try {
      await runHdiutilWithRetry(['create', '-volname', 'MyDSH', '/tmp/out.dmg'], {
        sleep: async ms => {
          delays.push(ms)
        },
        onRetry: () => {},
        runCommand: async () => {
          calls += 1
          throw lastError
        },
      })
    } catch (error) {
      caught = error
    }

    expect(calls).toBe(5)
    expect(delays).toEqual([1000, 2000, 4000, 6000])
    expect(caught).toBeInstanceOf(Error)
    expect(caught.message).toContain('hdiutil create')
    expect(caught.message).toContain('5 次尝试')
    expect(caught.message).toContain('hdiutil: create failed - Resource busy')
    expect(caught.cause).toBe(lastError)
  })
})

describe('createMacosDmg', () => {
  it('重试成功路径：每次重试前清理半成品临时 DMG，成功后原子替换并清理临时目录', async () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'mydsh-dmg-test-'))
    try {
      const makeDirectory = join(sandbox, 'out', 'make')
      const tempRoot = join(sandbox, 'temp')
      const applicationPath = join(sandbox, 'MyDSH.app')
      const dmgPath = join(makeDirectory, 'mydsh-macOS-arm64-0.1.0.dmg')
      mkdirSync(makeDirectory, { recursive: true })
      mkdirSync(tempRoot, { recursive: true })
      mkdirSync(applicationPath, { recursive: true })
      writeFileSync(dmgPath, 'previous-dmg')

      const delays = []
      const seenPreExistingCandidate = []
      let attempts = 0

      const outputPath = await createMacosDmg({
        applicationPath,
        dmgPath,
        volumeName: 'MyDSH',
        tempRoot,
        sleep: async ms => {
          delays.push(ms)
        },
        onRetry: () => {},
        copyApplication: (_source, target) => {
          mkdirSync(target, { recursive: true })
          writeFileSync(join(target, 'Info.plist'), 'ok')
        },
        createApplicationsLink: linkPath => {
          writeFileSync(linkPath, 'applications-link-placeholder')
        },
        runHdiutil: async args => {
          attempts += 1
          const candidatePath = args.at(-1)
          seenPreExistingCandidate.push(existsSync(candidatePath))
          if (attempts < 3) {
            writeFileSync(candidatePath, `partial-attempt-${String(attempts)}`)
            throw createExecError({
              stderr:
                attempts === 1
                  ? 'hdiutil: create failed - Resource busy\n'
                  : 'hdiutil: create failed - Resource temporarily unavailable\n',
            })
          }
          writeFileSync(candidatePath, 'fresh-dmg-payload')
        },
      })

      expect(outputPath).toBe(dmgPath)
      expect(attempts).toBe(3)
      expect(delays).toEqual([1000, 2000])
      // 每次重试开始时，前一次写入的半成品临时 .dmg 必须已被删除。
      expect(seenPreExistingCandidate).toEqual([false, false, false])
      expect(readFileSync(dmgPath, 'utf8')).toBe('fresh-dmg-payload')
      expect(readdirSync(makeDirectory)).toEqual(['mydsh-macOS-arm64-0.1.0.dmg'])
      expect(readdirSync(tempRoot)).toEqual([])
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  it('非瞬态失败路径：立即失败不重试，保留既有正式 DMG 并清理半成品与临时目录', async () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'mydsh-dmg-non-transient-'))
    try {
      const makeDirectory = join(sandbox, 'out', 'make')
      const tempRoot = join(sandbox, 'temp')
      const applicationPath = join(sandbox, 'MyDSH.app')
      const dmgPath = join(makeDirectory, 'mydsh-macOS-arm64-0.1.0.dmg')
      mkdirSync(makeDirectory, { recursive: true })
      mkdirSync(tempRoot, { recursive: true })
      mkdirSync(applicationPath, { recursive: true })
      writeFileSync(dmgPath, 'stable-dmg')

      const fatalError = createExecError({
        stderr: 'hdiutil: create failed - Operation not permitted\n',
      })
      const delays = []
      let attempts = 0

      await expect(
        createMacosDmg({
          applicationPath,
          dmgPath,
          volumeName: 'MyDSH',
          tempRoot,
          sleep: async ms => {
            delays.push(ms)
          },
          onRetry: () => {},
          copyApplication: (_source, target) => {
            mkdirSync(target, { recursive: true })
          },
          createApplicationsLink: linkPath => {
            writeFileSync(linkPath, 'applications-link-placeholder')
          },
          runHdiutil: async args => {
            attempts += 1
            writeFileSync(args.at(-1), 'broken-partial-dmg')
            throw fatalError
          },
        }),
      ).rejects.toBe(fatalError)

      expect(attempts).toBe(1)
      expect(delays).toEqual([])
      expect(readFileSync(dmgPath, 'utf8')).toBe('stable-dmg')
      expect(readdirSync(makeDirectory)).toEqual(['mydsh-macOS-arm64-0.1.0.dmg'])
      expect(readdirSync(tempRoot)).toEqual([])
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  it('重试耗尽路径：抛出清晰中文错误、保留既有 DMG 并彻底清理末次半成品与临时目录', async () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'mydsh-dmg-exhausted-'))
    try {
      const makeDirectory = join(sandbox, 'out', 'make')
      const tempRoot = join(sandbox, 'temp')
      const applicationPath = join(sandbox, 'MyDSH.app')
      const dmgPath = join(makeDirectory, 'mydsh-macOS-arm64-0.1.0.dmg')
      mkdirSync(makeDirectory, { recursive: true })
      mkdirSync(tempRoot, { recursive: true })
      mkdirSync(applicationPath, { recursive: true })
      writeFileSync(dmgPath, 'stable-dmg')

      const delays = []
      const seenPreExistingCandidate = []
      let attempts = 0

      await expect(
        createMacosDmg({
          applicationPath,
          dmgPath,
          volumeName: 'MyDSH',
          tempRoot,
          sleep: async ms => {
            delays.push(ms)
          },
          onRetry: () => {},
          copyApplication: (_source, target) => {
            mkdirSync(target, { recursive: true })
          },
          createApplicationsLink: linkPath => {
            writeFileSync(linkPath, 'applications-link-placeholder')
          },
          runHdiutil: async args => {
            attempts += 1
            const candidatePath = args.at(-1)
            seenPreExistingCandidate.push(existsSync(candidatePath))
            writeFileSync(candidatePath, `partial-attempt-${String(attempts)}`)
            throw createExecError({ stderr: 'hdiutil: create failed - Resource busy\n' })
          },
        }),
      ).rejects.toThrow(
        /hdiutil create 在 5 次尝试后仍因瞬态错误失败：hdiutil: create failed - Resource busy/u,
      )

      expect(attempts).toBe(5)
      expect(delays).toEqual([1000, 2000, 4000, 6000])
      expect(seenPreExistingCandidate).toEqual([false, false, false, false, false])
      expect(readFileSync(dmgPath, 'utf8')).toBe('stable-dmg')
      expect(readdirSync(makeDirectory)).toEqual(['mydsh-macOS-arm64-0.1.0.dmg'])
      expect(readdirSync(tempRoot)).toEqual([])
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })
})
