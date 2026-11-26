/* oxlint-disable no-await-in-loop -- 每个场景独立装配真实服务，并按驱动生命周期等待清理。 */
const check = (condition, message) => {
  if (!condition) throw new Error(message)
}

/** 用真实 Agent 驱动和可控模型流检查取消、接续与退出，不访问网络或用户会话。 */
export async function verifyQueuedCancellation(load) {
  const [
    { Context },
    { default: LlmRuntime, LlmAdapter, createUserMessage },
    { default: SessionStore, SessionId },
    { default: Projections },
    { default: SystemPrompt },
    { default: Tools },
    { default: Agents },
    { default: AgentLoop },
    { SessionCommandController },
  ] = await Promise.all([
    load('cordis'),
    load('dsh-llm'),
    load('dsh-session'),
    load('dsh-session-projection'),
    load('dsh-system-prompt'),
    load('dsh-tools'),
    load('dsh-agent'),
    load('dsh-agent-loop'),
    load('dsh-api-session-controller', 'commands.js'),
  ])
  const cases = [
    '接续队列',
    '无排队',
    '重复停止',
    '清理期间移除队列',
    '退出时不接续',
    '保留但不自动接续',
  ]
  for (const scenario of cases) {
    const ctx = new Context()
    const started = Promise.withResolvers()
    const cleanup = Promise.withResolvers()
    const signals = []
    const settledTurns = []
    class Adapter extends LlmAdapter {
      async resolveModel(provider, model) {
        return { provider, id: model, name: model }
      }
      async *stream(options) {
        check(settledTurns.length === signals.length, `${scenario}：上一轮清理通知结束前启动了模型`)
        signals.push(options.signal)
        if (signals.length === 1) {
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'text-delta', index: 0, text: '当前回复' }
          started.resolve()
          await new Promise(resolve => {
            if (options.signal.aborted) resolve()
            else options.signal.addEventListener('abort', resolve, { once: true })
          })
          await cleanup.promise
          throw new Error('当前回复已取消')
        }
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: '队列已接续' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '队列已接续' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    try {
      for (const plugin of [LlmRuntime, SessionStore, Projections, SystemPrompt, Tools, Agents])
        await ctx.plugin(plugin)
      await ctx.plugin(AgentLoop, { agents: [] })
      ctx.on('agent/turn-settled', async ({ turn }) => {
        await new Promise(resolve => setTimeout(resolve, 5))
        settledTurns.push(turn)
      })
      ctx.llm.registerAdapter(['mydsh-queue-check'], new Adapter())
      const agent = await ctx.agentLoop.create(SessionId(`队列验收-${scenario}`), {
        provider: 'mydsh-queue-check',
        model: 'local',
      })
      const commands = new SessionCommandController(ctx, undefined, '')
      const send = text =>
        agent.followup(
          createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
        )
      send('当前消息')
      await started.promise
      if (scenario !== '无排队') {
        send('排队消息一')
        send('排队消息二')
      }
      if (scenario === '保留但不自动接续') agent.cancel({ kind: 'user' }, { keepInbox: true })
      else commands.cancel({ sessionId: agent.id })
      check(signals[0].aborted, `${scenario}：当前回复未立即收到取消`)
      if (scenario === '重复停止') commands.cancel({ sessionId: agent.id })
      if (scenario === '清理期间移除队列') agent.inbox.clear()
      if (scenario === '退出时不接续') {
        agent.cancel({ kind: 'disposed' }, { keepInbox: true })
        send('退出期间迟到的消息')
      }
      await Promise.resolve()
      check(signals.length === 1, `${scenario}：旧回复完成清理前启动了新回复`)
      cleanup.resolve()
      await agent.whenIdle()
      const resumed = scenario === '接续队列' || scenario === '重复停止'
      check(signals.length === (resumed ? 3 : 1), `${scenario}：模型调用数量异常 ${signals.length}`)
      const endings = agent.session
        .snapshotEvents()
        .filter(event => event.type === 'turn/end')
        .map(event => event.data.reason.kind)
      check(settledTurns.length === endings.length, `${scenario}：取消或完成时遗漏轮次清理通知`)
      check(
        endings.join(',') === (resumed ? 'aborted,completed,completed' : 'aborted'),
        `${scenario}：取消影响了后续轮次`,
      )
      if (resumed) {
        check(
          signals[1] !== signals[0] && signals.slice(1).every(signal => !signal.aborted),
          '后续回复复用了取消信号',
        )
        const texts = agent.session
          .snapshotEvents()
          .filter(event => event.type === 'user/message')
          .flatMap(event => event.data.content)
          .filter(block => block.type === 'text')
          .map(block => block.text)
        check(texts.join(',') === '当前消息,排队消息一,排队消息二', '排队消息顺序变化或丢失')
        check(agent.inbox.nextTurn.length === 0, '完成后队列没有清空')
      }
      if (scenario === '保留但不自动接续')
        check(agent.inbox.nextTurn.length === 2, '保留队列的原有语义改变')
    } finally {
      cleanup.resolve()
      await ctx.fiber.dispose()
    }
  }
  return cases
}
