import { describe, expect, it } from 'vitest'
import { verifyQueuedCancellation } from '../scripts/verify-queued-cancellation.mjs'

const modules = {
  cordis: '../vendor/cordis/lib/index.js',
  'dsh-llm': '../packages/llm/llm/lib/index.js',
  'dsh-session': '../packages/core/session/lib/index.js',
  'dsh-session-projection': '../packages/session/session-projection/lib/index.js',
  'dsh-system-prompt': '../packages/core/system-prompt/lib/index.js',
  'dsh-tools': '../packages/core/tools/lib/index.js',
  'dsh-agent': '../packages/core/agent/lib/index.js',
  'dsh-agent-loop': '../packages/core/agent-loop/lib/index.js',
  'dsh-api-session-controller': '../packages/api/session-controller/lib/index.js',
}

describe('停止当前回复后接续排队消息', () => {
  it('等待旧回复清理、顺序接续、隔离取消信号并保持退出清理', async () => {
    const cases = await verifyQueuedCancellation(
      (name, file) =>
        import(
          new URL(
            file === undefined ? modules[name] : modules[name].replace('index.js', file),
            import.meta.url,
          ).href
        ),
    )
    expect(cases).toHaveLength(6)
  })
})
