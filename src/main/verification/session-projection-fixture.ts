/**
 * 主进程的会话投影夹具：读取隔离会话的真实投影游标，再补入展示用统计。
 * 只通过验收调用方发布快照，不写会话日志，也不拥有需要释放的资源。
 */
import type { BrowserWindow } from 'electron'
import type { PluginProjectionSnapshot } from '../../shared/plugin-projections.ts'
import type { DesktopSessionFrame } from '../../shared/session-live.ts'

/** 读取隔离会话的完整投影基线，供展示夹具保留真实游标和未覆盖字段。 */
export async function readVerificationProjection(
  win: BrowserWindow,
  sessionId: string,
): Promise<PluginProjectionSnapshot> {
  const baseline = (await win.webContents.executeJavaScript(`(async () => {
    const { items } = await window.dshDesktop.host.call('listSessions', {})
    return items.find(item => item.sessionId === ${JSON.stringify(sessionId)})?.projections ?? null
  })()`)) as PluginProjectionSnapshot | null
  if (baseline === null) throw new Error('读数验收缺少真实会话投影')
  return baseline
}

/** 使用真实游标补齐当前隔离会话的读数，避免后续历史分页请求越过会话日志。 */
export async function seedComposerReadings(
  win: BrowserWindow,
  sessionId: string,
  emit: (frame: DesktopSessionFrame) => void,
): Promise<void> {
  const baseline = await readVerificationProjection(win, sessionId)
  // 同游标的完整快照可以补入展示样本；更晚的真实快照仍能正常替换它。
  emit({
    type: 'session/plugin-projections',
    sessionId,
    change: {
      ...baseline,
      kind: 'snapshot',
      values: {
        ...baseline.values,
        tokenUsage: {
          uncachedInputTokens: 1_200,
          cacheReadTokens: 9_000,
          cacheWriteTokens: 0,
          outputTokens: 800,
        },
        contextPressure: { projectedTokens: 12_000, contextWindow: 128_000 },
        sessionStats: {
          turns: 1,
          steps: 2,
          llmMs: 2_400,
          toolMs: 300,
          ttftSteps: 2,
          ttftMs: 600,
          decodeMs: 1_800,
          decodeTokens: 800,
        },
      },
    },
  })
  const ready = await win.webContents.executeJavaScript(`(async () => {
    for (let attempt = 0; attempt < 120; attempt++) {
      if ([...document.querySelectorAll('[data-composer-readings]')].some(node => node.checkVisibility())) return true
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    return false
  })()`)
  if (!ready) throw new Error('真实会话游标上的读数快照没有显示')
}
