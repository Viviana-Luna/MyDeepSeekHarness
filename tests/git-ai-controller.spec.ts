/** 主进程 AI 方案归属与页面生命周期测试；仅模拟现有 Remote 调用，不增加 IPC。 */
import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { createGitAiController } from '../src/main/runtime/git-ai-controller.ts'

const payload = {
  id: 'test',
  provider: 'test',
  model: 'test',
  confirmed: true,
  scope: { staged: true, working: true, untracked: true },
}
type RemoteCall = Parameters<typeof createGitAiController>[0]['call']

function fixture(remote: RemoteCall = async () => ({})) {
  const window = Object.assign(new EventEmitter(), { webContents: new EventEmitter() })
  const call = vi.fn(remote)
  const invoke = createGitAiController({ window: window as unknown as BrowserWindow, call })
  return { window, call, invoke }
}

describe('AI 提交主进程边界', () => {
  it('无确认、附加路径和未知方法不能进入后台；方案不能跨项目或窗口使用', async () => {
    const { invoke, call } = fixture()
    await expect(invoke('a', 'gitAiAnalyze', { ...payload, confirmed: false })).rejects.toThrow(
      '确认',
    )
    await expect(invoke('a', 'gitAiAnalyze', { ...payload, path: '../other' })).rejects.toThrow(
      '字段',
    )
    await expect(invoke('a', 'gitAiCommand', payload)).rejects.toThrow('方法')
    expect(call).not.toHaveBeenCalled()
    await invoke('a', 'gitAiAnalyze', payload)
    await expect(invoke('a', 'gitAiAnalyze', payload)).rejects.toThrow('已有')
    await expect(invoke('b', 'gitAiValidate', { id: 'test' })).rejects.toThrow('当前窗口')
    await expect(invoke('a', 'gitAiValidate', { id: 'other' })).rejects.toThrow('当前窗口')
    const otherWindow = fixture()
    await expect(otherWindow.invoke('a', 'gitAiValidate', { id: 'test' })).rejects.toThrow(
      '当前窗口',
    )
  })

  it.each(['did-navigate', 'render-process-gone', 'closed'])(
    '页面生命周期 %s 释放请求并丢弃迟到结果',
    async event => {
      let settle!: (value: unknown) => void
      const pending = new Promise(resolve => {
        settle = resolve
      })
      const { window, invoke, call } = fixture(async (_, operation) =>
        operation === 'gitAiAnalyze' ? pending : {},
      )
      const analysis = invoke('a', 'gitAiAnalyze', payload)
      if (event === 'closed') window.emit(event)
      else window.webContents.emit(event)
      expect(call).toHaveBeenCalledWith('a', 'gitAiRelease', { id: 'test' })
      settle({ id: 'test' })
      await expect(analysis).rejects.toThrow('结果已丢弃')
      await expect(invoke('a', 'gitAiValidate', { id: 'test' })).rejects.toThrow('当前窗口')
    },
  )

  it('执行前校验深层批次字段，不能用合法外壳携带补丁或重复标识', async () => {
    const { invoke, call } = fixture()
    await invoke('a', 'gitAiAnalyze', payload)
    const id = 'a'.repeat(64)
    const execute = (plan: unknown) =>
      invoke('a', 'gitAiExecute', { id: 'test', confirmed: true, wholeFileIds: [], plan })
    await expect(
      execute({ batches: [{ message: '更新', itemIds: [id], patch: '未知补丁' }], deferred: [] }),
    ).rejects.toThrow()
    await expect(
      execute({ batches: [{ message: '更新', itemIds: [id, id] }], deferred: [] }),
    ).rejects.toThrow()
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('旧请求的迟到释放回包不会删除已开始的新方案', async () => {
    let rejectAnalysis!: (error: Error) => void
    let finishRelease!: (value: unknown) => void
    const pendingAnalysis = new Promise((_, reject) => {
      rejectAnalysis = reject
    })
    const pendingRelease = new Promise(resolve => {
      finishRelease = resolve
    })
    const { invoke } = fixture(async (_, operation, input) => {
      if (operation === 'gitAiAnalyze' && input.id === 'test') return pendingAnalysis
      if (operation === 'gitAiRelease') return pendingRelease
      return {}
    })
    const analysis = invoke('a', 'gitAiAnalyze', payload)
    const release = invoke('a', 'gitAiRelease', { id: 'test' })
    rejectAnalysis(new Error('已取消'))
    await expect(analysis).rejects.toThrow('已取消')
    await invoke('a', 'gitAiAnalyze', { ...payload, id: 'new-request' })
    finishRelease({ released: true })
    await release
    await expect(invoke('a', 'gitAiValidate', { id: 'new-request' })).resolves.toEqual({})
  })

  it('分析失败后的重复释放为空操作，旧标识也不能释放新方案', async () => {
    const { invoke, call } = fixture(async (_, operation, input) => {
      if (operation === 'gitAiAnalyze' && input.id === 'test') throw new Error('快照超过预算')
      return {}
    })
    await expect(invoke('a', 'gitAiAnalyze', payload)).rejects.toThrow('快照超过预算')
    await expect(invoke('a', 'gitAiRelease', { id: 'test' })).resolves.toEqual({ released: true })
    expect(call).toHaveBeenCalledTimes(1)
    await invoke('a', 'gitAiAnalyze', { ...payload, id: 'new' })
    await expect(invoke('a', 'gitAiCancel', { id: 'test' })).resolves.toEqual({ released: true })
    await expect(invoke('other-project', 'gitAiRelease', { id: 'new' })).resolves.toEqual({
      released: true,
    })
    expect(call).toHaveBeenCalledTimes(2)
    await expect(invoke('a', 'gitAiValidate', { id: 'new' })).resolves.toEqual({})
  })
})
