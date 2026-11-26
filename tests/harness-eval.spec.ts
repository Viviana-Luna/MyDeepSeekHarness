/**
 * Agent 调度层重构与二级受控 CLI 评测测试：覆盖命令行解析、Windows 管道 SDDL、租约防伪、预设独立工具暴露面、Schema 预算瘦身与真实沙箱往返。
 */
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import {
  materializeToolArguments,
  parseCliArgv,
} from '../packages/cli/cli-bridge/src/argv-parser.ts'
import {
  CLI_DOMAINS,
  renderActionHelp,
  renderDomainHelp,
  renderRootHelp,
} from '../packages/cli/cli-bridge/src/catalog.ts'
import { CliLeaseStore } from '../packages/cli/cli-bridge/src/lease-store.ts'
import { buildWindowsPipeSddl } from '../packages/cli/cli-bridge/src/windows-pipe-acl.ts'
import type { OfflineHarnessEvalReport } from '../scripts/harness-eval/offline-eval.mjs'

const execFileAsync = promisify(execFile)

describe('MyDSH 二级 CLI 参数解析、Windows SDDL 与租约安全', () => {
  it('支持领域帮助、help <domain> <action>、kebab-case 参数转换、布尔取反与 --<field>-stdin 注入', () => {
    expect(parseCliArgv([])).toEqual({ kind: 'help' })
    expect(parseCliArgv(['db', '--help'])).toEqual({ kind: 'help', domain: 'db' })
    expect(parseCliArgv(['help', 'db', 'query'])).toEqual({
      kind: 'help',
      domain: 'db',
      action: 'query',
      toolName: 'database_query',
    })
    expect(parseCliArgv(['help', 'call', 'database_query'])).toEqual({
      kind: 'help',
      toolName: 'database_query',
    })
    expect(renderRootHelp()).toContain('mydsh <domain> <action>')
    expect(renderDomainHelp('browser')).toContain('diagnostics')
    expect(renderDomainHelp('browser')).not.toContain('evaluate')
    expect(renderDomainHelp('computer')).not.toContain('move')
    expect(
      CLI_DOMAINS.find(item => item.domain === 'browser')?.actions.some(
        a => a.toolName === 'browser_diagnostics',
      ),
    ).toBe(true)

    const parsed = parseCliArgv([
      'db',
      'query',
      '--connection-id',
      'prod-pg',
      '--limit=25',
      '--no-explain',
      '--sql-stdin',
    ])
    expect(parsed.kind).toBe('invoke')
    if (parsed.kind !== 'invoke') return
    expect(parsed.toolName).toBe('database_query')
    const args = materializeToolArguments(
      parsed,
      {
        name: 'database_query',
        description: '执行只读 SQL 查询',
        parameters: {
          type: 'object',
          properties: {
            connection_id: { type: 'string', description: '连接 ID' },
            limit: { type: 'integer' },
            explain: { type: 'boolean' },
            sql: { type: 'string' },
          },
          required: ['connection_id', 'sql'],
        },
      },
      "SELECT 'ok' AS status;",
    )
    expect(args).toEqual({
      connection_id: 'prod-pg',
      limit: 25,
      explain: false,
      sql: "SELECT 'ok' AS status;",
    })

    const helpText = renderActionHelp('mydsh db query', {
      name: 'database_query',
      description: '执行只读 SQL 查询',
      parameters: {
        type: 'object',
        properties: {
          connection_id: { type: 'string', description: '连接 ID' },
        },
        required: ['connection_id'],
      },
    })
    expect(helpText).toContain('--connection-id <string> [必填]')
  })

  it('拒绝空数值强转与冲突的 stdin 参数声明', () => {
    const emptyLimit = parseCliArgv(['db', 'query', '--connection-id', 'prod', '--limit='])
    expect(emptyLimit.kind).toBe('invoke')
    if (emptyLimit.kind === 'invoke') {
      expect(() =>
        materializeToolArguments(
          emptyLimit,
          {
            name: 'database_query',
            description: '',
            parameters: {
              type: 'object',
              properties: {
                connection_id: { type: 'string' },
                limit: { type: 'integer' },
              },
            },
          },
          '',
        ),
      ).toThrow('不能为空')
    }
    expect(() => parseCliArgv(['db', 'query', '--json-stdin', '--sql-stdin'])).toThrow(
      '只能指定一个标准输入来源',
    )
  })

  it('Windows 命名管道 SDDL 包含 SYSTEM、当前用户、Logon SID 与 Low Mandatory Label，并拒绝非法 SID', () => {
    const sddl = buildWindowsPipeSddl('S-1-5-21-100-200-300-1001', 'S-1-5-5-0-4242')
    expect(sddl).toBe(
      'D:P(A;;GA;;;SY)(A;;GA;;;S-1-5-21-100-200-300-1001)(A;;GRGW;;;S-1-5-5-0-4242)S:(ML;;NW;;;LW)',
    )
    expect(() => buildWindowsPipeSddl('S-1-5-21-1)(A;;GA;;;WD')).toThrow('无效的 Windows 用户 SID')
    expect(() => buildWindowsPipeSddl('S-1-5-21-1', 'bad-sid')).toThrow(
      '无效的 Windows 登录会话 SID',
    )
  })

  it('会话租约按常量时间校验，支持过期淘汰与按 Agent 吊销', () => {
    const store = new CliLeaseStore(5_000)
    const fakeAgent = { id: 'agent-1' } as never
    const token = store.issue(fakeAgent)
    expect(store.verify(token)?.agent).toBe(fakeAgent)
    expect(store.verify(`${token}x`)).toBeNull()
    expect(store.verify('invalid')).toBeNull()
    store.revokeForAgent(fakeAgent)
    expect(store.verify(token)).toBeNull()
  })
})

describe('MyDSH 三预设工具暴露面与沙箱二级 CLI 闭环评测', () => {
  it('验证三预设独立暴露面、Schema 体积大幅缩减、目录零漂移与真实沙箱 CLI 审批/截图闭环', async () => {
    const scriptPath = fileURLToPath(new URL('../scripts/eval-harness.mjs', import.meta.url))
    const { stdout } = await execFileAsync(process.execPath, [scriptPath, '--json'], {
      timeout: 40_000,
    })
    const parsed = JSON.parse(stdout) as { offline: OfflineHarnessEvalReport }
    const report = parsed.offline
    expect(report.cliRoundtripPassed).toBe(true)
    expect(report.securityBoundariesPassed).toBe(true)
    expect(report.retiredAliasPassed).toBe(true)
    expect(report.isolatedPeripheralCount).toBeGreaterThanOrEqual(25)

    const byId = new Map(report.presets.map(item => [item.presetId, item]))
    const minimal = byId.get('minimal')!
    const standard = byId.get('standard')!
    const gpt = byId.get('gpt-coding')!

    // 1. 极简模式：POSIX 下严格只有 4 个基础工具，Windows 下额外补充 glob/grep。
    if (process.platform === 'win32') {
      expect(minimal.toolNames).toEqual(['edit', 'glob', 'grep', 'powershell', 'read', 'write'])
    } else {
      expect(minimal.toolNames).toEqual(['bash', 'edit', 'read', 'write'])
    }

    // 2. 标准模式：暴露 read/write/edit/bash 与高频通用工具，不暴露 apply_patch，也不泄漏任何外围自研工具。
    expect(standard.toolNames).toContain('read')
    expect(standard.toolNames).toContain('write')
    expect(standard.toolNames).toContain('edit')
    expect(standard.toolNames).toContain('update_plan')
    expect(standard.toolNames).toContain('web_search')
    expect(standard.toolNames).toContain('ask_user_question')
    expect(standard.toolNames).not.toContain('apply_patch')
    expect(standard.toolNames.some(name => name.startsWith('database_'))).toBe(false)
    expect(standard.toolNames.some(name => name.startsWith('browser_'))).toBe(false)
    expect(standard.toolNames.some(name => name.startsWith('computer_'))).toBe(false)
    expect(standard.toolNames.some(name => name.startsWith('ssh_'))).toBe(false)
    expect(standard.schemaReductionRatio).toBeGreaterThan(0.5)

    // 3. ChatGPT 模式：暴露 exec_command/apply_patch/update_plan，绝不暴露 write 与 edit。
    expect(gpt.toolNames).toContain('exec_command')
    expect(gpt.toolNames).toContain('apply_patch')
    expect(gpt.toolNames).toContain('update_plan')
    expect(gpt.toolNames).not.toContain('write')
    expect(gpt.toolNames).not.toContain('edit')
    expect(gpt.toolNames.some(name => name.startsWith('database_'))).toBe(false)
    expect(gpt.toolNames.some(name => name.startsWith('browser_'))).toBe(false)
    expect(gpt.schemaReductionRatio).toBeGreaterThan(0.5)
  }, 45_000)

  it('live 基准评测宿主复用完整核心装配表并成功挂载三套预设', async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        [
          "import './scripts/harness-eval/workspace-resolver.mjs'",
          "import { mkdtemp, rm } from 'node:fs/promises'",
          "import { tmpdir } from 'node:os'",
          "import { join } from 'node:path'",
          "import { createLiveEvalHost } from './scripts/harness-eval/live-benchmark.mjs'",
          "const dir = await mkdtemp(join(tmpdir(), 'mydsh-live-mount-'))",
          'let ctx',
          'try {',
          '  ctx = await createLiveEvalHost(dir, dir)',
          '  const counts = {}',
          "  for (const presetId of ['standard', 'minimal', 'gpt-coding']) {",
          "    const handle = await ctx.agents.create({ sessionId: 'live-' + presetId, agentOptions: { provider: 'deepseek-official', model: 'deepseek-flash' }, meta: { cwd: dir, agentPreset: presetId }, setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, presetId) } })",
          '    const prompt = await ctx.systemPrompt.assemble({ scope: handle.agent, agent: handle.agent })',
          '    counts[presetId] = prompt.tools.length',
          '    await handle.dispose()',
          '  }',
          '  console.log(JSON.stringify(counts))',
          '} finally {',
          '  if (ctx) await Promise.resolve(ctx.fiber.dispose()).catch(() => undefined)',
          '  await rm(dir, { recursive: true, force: true }).catch(() => undefined)',
          '}',
        ].join('\n'),
      ],
      { timeout: 30_000 },
    )
    const counts = JSON.parse(stdout) as Record<string, number>
    expect(counts.minimal).toBeGreaterThanOrEqual(4)
    expect(counts.standard).toBeGreaterThanOrEqual(15)
    expect(counts['gpt-coding']).toBeGreaterThanOrEqual(10)
  }, 35_000)
})
