// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  formatHubDuration,
  formatHubExactTokens,
  formatHubSpeed,
  formatHubTokens,
  hubCacheHitPercent,
  hubHasUsage,
  hubTodoProgress,
  hubTotalTokens,
  parseHubContext,
  parseHubContextBreakdown,
  parseHubStats,
  parseHubTokenUsage,
  parseHubTodos,
} from '../src/renderer/src/domain/session-hub.ts'
import { ComposerTodos } from '../src/renderer/src/features/composer/ComposerTodos.tsx'
import { ComposerStatus } from '../src/renderer/src/features/composer/ComposerStatus.tsx'
import {
  ChatRightPanel,
  readChatContext,
} from '../src/renderer/src/pages/workspace/components/rightpanel/chat-rightpanel/index.tsx'

// 会话信息右栏的组合里带 Umi Model 与项目 Provider 的依赖，这里只验证读数卡片的投影解析与排版。
const selectedModel = vi.hoisted(() => ({ provider: 'deepseek-official' }))
vi.mock('../src/renderer/src/hooks/useWorkspace.ts', () => ({
  useWorkspaceSnapshot: () => ({
    hostStatus: { kind: 'ready' },
    selectedSessionId: '会话-1',
    pluginRevision: 0,
    sessionModels: { current: selectedModel },
  }),
  useWorkspaceStore: () => ({
    selectedSession: () => ({ sessionId: '会话-1', blank: false, agentPreset: 'standard' }),
    callHost: async () => ({ presets: [], authorable: false, hasDocument: false }),
    selectAgentPreset: async () => true,
  }),
}))
vi.mock('../src/renderer/src/features/project-workspace/ProjectWorkspaceProvider.tsx', () => ({
  useProjectWorkspace: () => ({ openFileFromConversation: async () => undefined }),
}))
vi.mock('../src/renderer/src/features/source-control/SourceControlProvider.tsx', () => ({
  useSourceControl: () => ({ gitSummary: null }),
}))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  selectedModel.provider = 'deepseek-official'
})

const usage = { uncachedInput: 1_200, cacheRead: 40_000, cacheWrite: 800, output: 9_000 }

function renderStatus(overrides: Partial<Parameters<typeof ComposerStatus>[0]> = {}) {
  return render(
    <ComposerStatus
      usage={usage}
      context={{ projectedTokens: 42_000, window: 128_000, percent: 33 }}
      breakdown={{ systemTokens: 3700, toolsTokens: 3900, messageTokens: 101000 }}
      stats={{
        turns: 3,
        steps: 7,
        llmMs: 18_000,
        toolMs: 4_000,
        ttftSteps: 3,
        ttftMs: 1_800,
        speed: { tokensPerSecond: 42.5, outputTokens: 9_000, decodeMs: 211_765 },
      }}
      running={false}
      onRestoreFocus={() => undefined}
      {...overrides}
    />,
  )
}

describe('会话读数组投影解析', () => {
  it('按投影字段名读取四个互不重叠的计费桶', () => {
    expect(
      parseHubTokenUsage({
        uncachedInputTokens: 1_200,
        cacheReadTokens: 40_000,
        cacheWriteTokens: 800,
        outputTokens: 9_000,
      }),
    ).toEqual(usage)
  })

  it('缺少任意计费桶时整份用量按不可用处理', () => {
    expect(parseHubTokenUsage({ uncachedInputTokens: 1, outputTokens: 2 })).toBeNull()
    expect(parseHubTokenUsage({ inputTokens: 1, output: 2 })).toBeNull()
    expect(parseHubTokenUsage(null)).toBeNull()
  })

  it('拒绝负数、非整数与越界读数，不把它们当成 0', () => {
    expect(
      parseHubTokenUsage({
        uncachedInputTokens: -1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
      }),
    ).toBeNull()
    expect(
      parseHubTokenUsage({
        uncachedInputTokens: 1.5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
      }),
    ).toBeNull()
    expect(
      parseHubTokenUsage({
        uncachedInputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 1e16,
      }),
    ).toBeNull()
  })

  it('合计只统计提示词侧桶与输出', () => {
    expect(hubTotalTokens(usage)).toBe(51_000)
    expect(hubHasUsage(usage)).toBe(true)
    expect(hubHasUsage({ uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 })).toBe(false)
  })

  it('缓存命中率按提示词侧三桶求比例，没有提示词输入时不给读数', () => {
    expect(hubCacheHitPercent(usage)).toBe(95)
    expect(
      hubCacheHitPercent({ uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 10 }),
    ).toBeNull()
    expect(
      hubCacheHitPercent({ uncachedInput: 10, cacheRead: 90, cacheWrite: 10, output: 0 }),
    ).toBe(82)
    // 全部命中：读满三个桶时给 100，不留下小数尾巴。
    expect(hubCacheHitPercent({ uncachedInput: 0, cacheRead: 90, cacheWrite: 0, output: 0 })).toBe(
      100,
    )
  })

  it('上下文占用缺少任一侧读数时不给百分比', () => {
    expect(parseHubContext({ projectedTokens: 42_000, contextWindow: 128_000 })).toEqual({
      projectedTokens: 42_000,
      window: 128_000,
      percent: 33,
    })
    expect(parseHubContext({ contextWindow: 128_000 }).percent).toBeNull()
    expect(parseHubContext({ projectedTokens: 42_000 }).percent).toBeNull()
    expect(parseHubContext({ projectedTokens: 200, contextWindow: 100 }).percent).toBe(200)
    expect(parseHubContext({ contextWindow: 0 })).toEqual({
      projectedTokens: null,
      window: null,
      percent: null,
    })
  })

  it('超窗文字不封顶，原生压缩等待期间不显示旧读数', () => {
    const context = parseHubContext({ projectedTokens: 395000, contextWindow: 272000 })
    expect(context.percent).toBe(145)
    const view = renderStatus({ context, breakdown: null })
    fireEvent.click(screen.getByRole('button', { name: '上下文占用 145%' }))
    expect(screen.getByText('超过标称窗口')).toBeTruthy()
    expect(screen.getByRole('dialog').querySelector('i')?.style.width).toBe('100%')
    view.unmount()
    const waiting = parseHubContext({
      projectedTokens: 395000,
      contextWindow: 272000,
      awaitingUsage: true,
      nativeCompaction: true,
    })
    expect(waiting.projectedTokens).toBeNull()
    renderStatus({ context: waiting })
    fireEvent.click(screen.getByRole('button', { name: '请求占用等待更新' }))
    expect(screen.getByText('请求占用：等待更新')).toBeTruthy()
    expect(screen.getByText('本地保留历史与配置（估算，非请求占用）')).toBeTruthy()
    expect(screen.queryByText(/395K/)).toBeNull()
  })

  it('速度只在解码时长与输出量同时为正时成立', () => {
    const stats = parseHubStats({
      turns: 3,
      steps: 7,
      llmMs: 18_000.4,
      toolMs: 4_000,
      ttftMs: 1_800,
      ttftSteps: 3,
      decodeMs: 2_000,
      decodeTokens: 100,
    })
    expect(stats?.llmMs).toBe(18_000)
    expect(stats?.speed).toEqual({ tokensPerSecond: 50, outputTokens: 100, decodeMs: 2_000 })
    const settled = { turns: 1, steps: 1, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0 }
    expect(parseHubStats({ ...settled, decodeMs: 2_000, decodeTokens: 0 })?.speed).toBeNull()
    expect(parseHubStats({ ...settled, decodeMs: 0, decodeTokens: 0 })?.speed).toBeNull()
  })

  it('缺少统计字段时整份耗时读数按不可用处理', () => {
    expect(parseHubStats({ turns: 1, steps: 2 })).toBeNull()
    expect(parseHubStats('stats')).toBeNull()
  })

  it('待办保留 content 与三态 status，丢弃无效条目', () => {
    expect(
      parseHubTodos([
        { content: '写测试', status: 'in_progress' },
        { content: '旧字段', text: '不能读' },
        { content: '状态未知', status: 'blocked' },
        { content: '', status: 'pending' },
        { content: '收尾', status: 'completed' },
      ]),
    ).toEqual([
      { content: '写测试', status: 'in_progress' },
      { content: '收尾', status: 'completed' },
    ])
    expect(parseHubTodos(null)).toEqual([])
  })

  it('格式化读数：紧凑计数、精确分位、速度、时长与进度', () => {
    expect(formatHubTokens(517)).toBe('517')
    expect(formatHubTokens(12_200)).toBe('12.2K')
    expect(formatHubTokens(1_240_000)).toBe('1.2M')
    expect(formatHubExactTokens(51_000)).toContain('51')
    expect(formatHubSpeed(null)).toBe('—')
    expect(formatHubSpeed(9.64)).toBe('9.6 tok/s')
    expect(formatHubSpeed(42.4)).toBe('42 tok/s')
    expect(formatHubDuration(45_200)).toBe('45.2s')
    expect(formatHubDuration(162_000)).toBe('2m42s')
    expect(
      hubTodoProgress([
        { content: 'a', status: 'completed' },
        { content: 'b', status: 'in_progress' },
        { content: 'c', status: 'pending' },
      ]),
    ).toBe('已完成 1 · 进行中 1 · 待处理 1')
  })
})

describe('会话读数组', () => {
  it('ChatGPT 会话暂不显示订阅额度入口，保留实际用量与上下文读数', () => {
    selectedModel.provider = 'chatgpt-subscription'
    renderStatus()
    expect(screen.queryByRole('button', { name: /ChatGPT 订阅额度/u })).toBeNull()
    expect(screen.queryByText('额度 —')).toBeNull()
    expect(screen.queryByRole('link', { name: '在 ChatGPT 查看额度' })).toBeNull()
    expect(screen.getByRole('button', { name: /Token 用量/u }).textContent).toContain('51K tok')
    expect(screen.getByRole('button', { name: '上下文占用 33%' })).not.toBeNull()
  })
  it('显示上下文占用、输出速度与 Token 合计', () => {
    renderStatus()
    expect(screen.getByRole('button', { name: '上下文占用 33%' }).textContent).toContain('33%')
    expect(screen.getByRole('button', { name: '输出速度 43 tok/s' }).textContent).toContain(
      '43 tok/s',
    )
    expect(screen.getByRole('button', { name: /Token 用量/u }).textContent).toContain('51K tok')
  })

  it('点开用量只显示累计用量与四个计费桶', () => {
    renderStatus()
    fireEvent.click(screen.getByRole('button', { name: /Token 用量/u }))
    const panel = screen.getByRole('dialog', { name: 'Token 用量' })
    expect(panel.dataset.menuMorph).toBe('settled')
    expect(panel.textContent).toContain('缓存读取')
    expect(panel.textContent).toContain('缓存写入')
    expect(panel.textContent).toContain('缓存命中')
    expect(panel.textContent).not.toContain('上下文已用')
  })

  it('上下文单独显示真实构成估算，不用累计 Token 冒充上下文', () => {
    renderStatus()
    fireEvent.click(screen.getByRole('button', { name: '上下文占用 33%' }))
    const panel = screen.getByRole('dialog', { name: '上下文占用' })
    expect(panel.textContent).toContain('上下文已用 33%')
    expect(panel.textContent).toContain('~42K / 128K')
    expect(panel.textContent).toContain('系统提示词~3.7K')
    expect(panel.textContent).toContain('工具定义~3.9K')
    expect(panel.textContent).toContain('对话消息~101K')
    expect(panel.textContent).not.toContain('缓存读取')
    expect(
      parseHubContextBreakdown({ systemTokens: 1, toolsTokens: -1, messageTokens: 2 }),
    ).toBeNull()
    expect(parseHubContextBreakdown({ systemTokens: 1, messageTokens: 2 })).toBeNull()
  })

  it('点开耗时给出模型、工具、首字时长与速度', () => {
    renderStatus()
    fireEvent.click(screen.getByRole('button', { name: '输出速度 43 tok/s' }))
    const panel = screen.getByRole('dialog', { name: '会话统计' })
    expect(panel.textContent).toContain('43 tok/s')
    expect(panel.textContent).toContain('18s')
    expect(panel.textContent).toContain('4s')
    expect(panel.textContent).toContain('0.6s')
  })

  it('输入框上方的待办支持展开、状态更新与空清单隐藏', () => {
    const todos = [
      { content: '接入投影', status: 'in_progress' as const },
      { content: '补测试', status: 'pending' as const },
    ]
    const view = render(<ComposerTodos todos={todos} />)
    const toggle = screen.getByRole('button', { name: /本轮待办/u, expanded: false })
    expect(screen.queryByRole('list')).toBeNull()
    fireEvent.click(toggle)
    expect(screen.getByRole('list', { name: '任务清单' }).textContent).toContain('进行中：接入投影')
    view.rerender(<ComposerTodos todos={[{ content: '接入投影', status: 'completed' }]} />)
    expect(screen.getByRole('list').textContent).toContain('已完成：接入投影')
    expect(toggle.textContent).toContain('已完成 1')
    view.rerender(<ComposerTodos todos={[]} />)
    expect(screen.queryByRole('region', { name: '本轮待办' })).toBeNull()
  })

  it('面板跟随实际按钮切换和缩放，关闭后归还输入焦点', () => {
    let offset = 0
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.getAttribute('role') === 'dialog') return new DOMRect(0, 0, 320, 200)
      return new DOMRect(
        (this.getAttribute('aria-label')?.startsWith('Token 用量') ? 650 : 400) + offset,
        500,
        70,
        24,
      )
    })
    const input = render(<textarea aria-label="验收输入框" />).getByRole('textbox')
    input.focus()
    renderStatus({
      onRestoreFocus: () => {
        input.focus()
      },
    })
    const contextButton = screen.getByRole('button', { name: '上下文占用 33%' })
    const tokenButton = screen.getByRole('button', { name: /Token 用量/u })
    fireEvent.click(contextButton)
    expect(screen.getByRole('dialog', { name: '上下文占用' }).style.left).toBe('150px')
    fireEvent.click(tokenButton)
    const panel = screen.getByRole('dialog', { name: 'Token 用量' })
    expect(panel.style.position).toBe('fixed')
    expect(panel.style.left).toBe('400px')
    expect(contextButton.getAttribute('aria-expanded')).toBe('false')
    expect(tokenButton.getAttribute('aria-expanded')).toBe('true')
    offset = 25
    fireEvent.resize(window)
    expect(panel.style.left).toBe('425px')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Token 用量' })).toBeNull()
    expect(document.activeElement).toBe(input)
    fireEvent.click(tokenButton)
    fireEvent.click(tokenButton)
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(tokenButton)
    fireEvent.pointerDown(input)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('没有用量与统计时不显示对应读数，正在产出时给出统计提示', () => {
    renderStatus({
      usage: null,
      stats: null,
      context: { projectedTokens: null, window: null, percent: null },
      running: true,
    })
    expect(screen.queryByRole('button', { name: /Token 用量/u })).toBeNull()
    expect(screen.queryByRole('button', { name: /本轮待办/u })).toBeNull()
    expect(screen.getByText('统计中…')).toBeTruthy()
    expect(screen.getByRole('button', { name: '上下文占用未知' })).toBeTruthy()
  })

  it('新会话没有任何读数也不在产出时整条不占位', () => {
    selectedModel.provider = 'chatgpt-subscription'
    renderStatus({
      usage: null,
      stats: null,
      context: { projectedTokens: null, window: null, percent: null },
      breakdown: null,
      running: false,
    })
    expect(document.querySelector('[data-composer-readings="true"]')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('只有一份读数时保留整条，不因其余投影缺失收起', () => {
    renderStatus({ usage: null, stats: null, breakdown: null, running: false })
    expect(document.querySelector('[data-composer-readings="true"]')).not.toBeNull()
    expect(screen.getByRole('button', { name: '上下文占用 33%' })).toBeTruthy()
  })

  it('会话信息右栏按同一份投影解析，只在有用量时显示缓存写入', () => {
    const projected = {
      tokenUsage: {
        uncachedInputTokens: 1_200,
        cacheReadTokens: 40_000,
        cacheWriteTokens: 800,
        outputTokens: 9_000,
      },
      contextPressure: { projectedTokens: 42_000, contextWindow: 128_000 },
      sessionStats: {
        turns: 3,
        steps: 7,
        llmMs: 18_000,
        toolMs: 4_000,
        ttftSteps: 3,
        ttftMs: 1_800,
        decodeMs: 200_000,
        decodeTokens: 9_000,
      },
      todos: [
        { content: '读取需求', status: 'completed' },
        { content: '接入投影', status: 'in_progress' },
        { content: '验证界面', status: 'pending' },
      ],
    }
    const view = render(
      <ChatRightPanel
        values={projected}
        context={readChatContext(projected)}
        projectScopeKey="项目"
      />,
    )
    const card = document.querySelector('.usage-card dl')
    expect(card?.textContent).toContain('缓存读取')
    expect(card?.textContent).toContain('缓存写入')
    expect(card?.textContent).toContain('缓存命中')
    expect(screen.queryByText('当前任务')).toBeNull()
    expect(screen.queryByRole('heading', { name: '会话信息' })).toBeNull()
    expect(screen.queryByRole('region', { name: '本轮待办' })).toBeNull()
    expect(screen.getByText('45 tok/s')).toBeTruthy()
    view.rerender(
      <ChatRightPanel
        values={{ ...projected, tokenUsage: { ...projected.tokenUsage, cacheWriteTokens: 0 } }}
        context={readChatContext(projected)}
        projectScopeKey="项目"
      />,
    )
    expect(screen.queryByText('缓存写入')).toBeNull()
    view.unmount()
    // 没有投影时逐行留空占位，排版与字号保持不变。
    const empty = render(
      <ChatRightPanel values={{}} context={readChatContext({})} projectScopeKey="项目" />,
    )
    const emptyUsage = document.querySelector('.usage-card dl')
    expect(emptyUsage).not.toBeNull()
    expect(emptyUsage?.textContent).toContain('—')
    expect(document.querySelector('.context-card strong')?.textContent).toBe('—')
    expect(document.querySelector('.todo-card')).toBeNull()
    empty.unmount()
  })

  it('步骤已结算但没有速度时保留耗时入口', () => {
    renderStatus({
      stats: { turns: 1, steps: 1, llmMs: 900, toolMs: 0, ttftSteps: 0, ttftMs: 0, speed: null },
      running: false,
    })
    expect(screen.getByRole('button', { name: '耗时统计' }).textContent).toContain('耗时统计')
  })
})
