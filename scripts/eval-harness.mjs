/**
 * MyDSH Agent 调度评测命令行入口：默认运行零成本离线 Schema 预算与二级 CLI 沙箱闭环评测；
 * 显式传入 `--live --provider <id> --model <id>` 时追加运行真实大模型端到端基准任务对比。
 */
import './harness-eval/workspace-resolver.mjs'
import { runLiveHarnessBenchmark } from './harness-eval/live-benchmark.mjs'
import { runOfflineHarnessEvaluation } from './harness-eval/offline-eval.mjs'

function parseEvalFlags(argv) {
  const flags = {
    json: false,
    live: false,
    provider: '',
    model: '',
    presets: ['standard', 'minimal', 'gpt-coding'],
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--json') flags.json = true
    else if (arg === '--live') flags.live = true
    else if (arg === '--provider') flags.provider = argv[++i] ?? ''
    else if (arg === '--model') flags.model = argv[++i] ?? ''
    else if (arg === '--presets') {
      flags.presets = (argv[++i] ?? '')
        .split(',')
        .map(item => item.trim())
        .filter(Boolean)
    }
  }
  return flags
}

function formatOfflineMarkdown(report) {
  const lines = [
    '# MyDSH Agent 调度与工具暴露面评测报告',
    '',
    `- 运行平台：\`${report.platform}\``,
    `- 二级 CLI 隔离工具数：**${report.isolatedPeripheralCount}** 个（共 ${report.isolatedPeripheralBytes} B Schema 已从一级移除）`,
    `- 沙箱 Shell → \`mydsh\` CLI 往返闭环：${report.cliRoundtripPassed ? '通过' : '失败'}`,
    `- 租约防伪与子 Agent 主会话隔离：${report.securityBoundariesPassed ? '通过' : '失败'}`,
    `- 下线预设历史映射兼容：${report.retiredAliasPassed ? '通过' : '失败'}`,
    '',
    '| 预设 | 一级工具数 | 当前 Schema 字节 | 估算 Token | 旧版平铺字节 | Schema 降幅 |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
  ]
  for (const row of report.presets) {
    const pct = `${(row.schemaReductionRatio * 100).toFixed(1)}%`
    lines.push(
      `| \`${row.presetId}\` | ${row.toolCount} | ${row.schemaBytes} B | ~${row.estimatedSchemaTokens} | ${row.legacySchemaBytesWithPeripherals} B | **-${pct}** |`,
    )
  }
  return lines.join('\n')
}

function formatLiveMarkdown(live) {
  const lines = [
    '',
    `## 真实模型基准任务对比（\`${live.provider}/${live.model}\`）`,
    '',
    '| 预设 | 任务 | 结果 | 工具调用数 | 工具报错 | 输入 Token | 输出 Token | 耗时 |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |',
  ]
  for (const item of live.results) {
    const status = item.passed ? 'PASS' : `FAIL${item.error ? ` (${item.error.slice(0, 40)})` : ''}`
    lines.push(
      `| \`${item.presetId}\` | \`${item.taskId}\` | ${status} | ${item.toolCalls} | ${item.toolErrors} | ${item.inputTokens} | ${item.outputTokens} | ${item.durationMs}ms |`,
    )
  }
  return lines.join('\n')
}

const flags = parseEvalFlags(process.argv.slice(2))
const offline = await runOfflineHarnessEvaluation()
let live = null
if (flags.live) {
  if (!flags.provider || !flags.model) {
    throw new Error('启用 --live 评测时必须同时指定 --provider <提供方> 与 --model <模型ID>')
  }
  live = await runLiveHarnessBenchmark({
    provider: flags.provider,
    model: flags.model,
    presets: flags.presets,
  })
}

if (flags.json) {
  console.log(JSON.stringify({ offline, ...(live ? { live } : {}) }, null, 2))
} else {
  console.log(formatOfflineMarkdown(offline))
  if (live) console.log(formatLiveMarkdown(live))
}
