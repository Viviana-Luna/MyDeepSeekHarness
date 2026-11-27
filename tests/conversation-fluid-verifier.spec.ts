// @vitest-environment jsdom
/**
 * 流式正文与页面轮询验收辅助脚本测试：覆盖低帧率增量显示、直接全量渲染失败与超时诊断。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildFluidTextCollectScript,
  buildFluidTextProbeScript,
  type FluidTextProbeResult,
} from '../src/main/verification/conversation-fluid-verifier.ts'
import {
  buildRendererPollScript,
  type PollRendererResult,
} from '../src/main/verification/verification-wait.ts'

beforeEach(() => {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }) as MediaQueryList
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('流式正文与通用页面轮询验收辅助', () => {
  it('软件渲染低帧率间隔超过 45ms 时仍能捕获递增前缀并正常通过', async () => {
    const expected = '正在读取真实内容并整理结果。'.repeat(4)
    new Function(buildFluidTextProbeScript(expected))()

    const node = document.createElement('div')
    node.setAttribute('data-streaming-cursor', 'true')
    node.textContent = expected.slice(0, 12)
    document.body.append(node)

    // 模拟软件渲染下 90ms 才推进下一帧（超过旧版写死的 45ms）。
    setTimeout(() => {
      node.textContent = expected.slice(0, 28)
    }, 90)

    const collect = new Function(
      `return ${buildFluidTextCollectScript(expected, 1_000)}`,
    ) as () => Promise<FluidTextProbeResult>
    const result = await collect()
    expect(result.ok).toBe(true)
    expect(result.firstLength).toBe(12)
    expect(result.nextLength).toBe(28)
    expect(result.expectedLength).toBe(expected.length)
    expect(result.samples).toEqual([12, 28])
  })

  it('首帧直接显示全部正文时拒绝通过并返回结构化诊断数据', async () => {
    const expected = '正在读取真实内容并整理结果。'.repeat(4)
    new Function(buildFluidTextProbeScript(expected))()

    const node = document.createElement('div')
    node.setAttribute('data-streaming-cursor', 'true')
    node.textContent = expected
    document.body.append(node)

    const collect = new Function(
      `return ${buildFluidTextCollectScript(expected, 500)}`,
    ) as () => Promise<FluidTextProbeResult>
    const result = await collect()
    expect(result.ok).toBe(false)
    expect(result.firstLength).toBe(0)
    expect(result.nextLength).toBe(0)
    expect(result.expectedLength).toBe(expected.length)
    expect(result.samples).toEqual([expected.length])
    expect(result.attempts).toBeGreaterThanOrEqual(5)
  })

  it('正文停留在首段不再推进时超时失败并保留采样上下文', async () => {
    const expected = '正在读取真实内容并整理结果。'.repeat(4)
    new Function(buildFluidTextProbeScript(expected))()

    const node = document.createElement('div')
    node.setAttribute('data-streaming-cursor', 'true')
    node.textContent = expected.slice(0, 10)
    document.body.append(node)

    const collect = new Function(
      `return ${buildFluidTextCollectScript(expected, 120)}`,
    ) as () => Promise<FluidTextProbeResult>
    const result = await collect()
    expect(result.ok).toBe(false)
    expect(result.firstLength).toBe(10)
    expect(result.nextLength).toBe(0)
    expect(result.samples).toEqual([10])
    expect(result.attempts).toBeGreaterThan(0)
  })

  it('通用页面轮询脚本在异步状态就绪后立即返回并在超时时保留最后采样', async () => {
    const marker = document.createElement('span')
    marker.id = 'poll-probe'
    marker.textContent = 'pending'
    document.body.append(marker)
    setTimeout(() => {
      marker.textContent = 'ready'
    }, 40)

    const runReady = new Function(
      `return ${buildRendererPollScript({
        probe: `document.getElementById('poll-probe')?.textContent ?? ''`,
        condition: `state === 'ready'`,
        timeoutMs: 500,
        intervalMs: 15,
      })}`,
    ) as () => Promise<PollRendererResult<string>>
    const ready = await runReady()
    expect(ready.ok).toBe(true)
    expect(ready.value).toBe('ready')
    expect(ready.attempts).toBeGreaterThanOrEqual(2)

    const runTimeout = new Function(
      `return ${buildRendererPollScript({
        probe: `document.getElementById('poll-probe')?.textContent ?? ''`,
        condition: `state === 'never'`,
        timeoutMs: 60,
        intervalMs: 15,
      })}`,
    ) as () => Promise<PollRendererResult<string>>
    const timedOut = await runTimeout()
    expect(timedOut.ok).toBe(false)
    expect(timedOut.value).toBe('ready')
    expect(timedOut.attempts).toBeGreaterThanOrEqual(2)
  })
})
