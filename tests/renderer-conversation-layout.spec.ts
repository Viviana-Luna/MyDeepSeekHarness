import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const stylesheet = readFileSync(
  new URL('../src/renderer/src/features/conversation/ConversationView.module.css', import.meta.url),
  'utf8',
)

function declarations(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'u').exec(stylesheet)
  expect(match, `缺少 ${selector} 样式规则`).not.toBeNull()
  return (match?.[1] ?? '').replace(/\s+/gu, ' ').trim()
}

describe('对话视图宽度契约', () => {
  it('所有 Grid 与 Flex 边界都允许内容收缩到中央视口', () => {
    expect(declarations('.list')).toContain('grid-template-columns: minmax(0, 1fr)')
    expect(declarations('.list')).toContain('min-width: 0')
    expect(declarations('.message')).toContain('max-width: 100%')
    expect(declarations('.user')).toContain('width: fit-content')
    expect(declarations('.user')).toContain('max-width: min(100%, 760px)')
    expect(declarations('.messageBody')).toContain('grid-template-columns: minmax(0, 1fr)')
    expect(declarations('.messageText')).toContain('overflow-wrap: anywhere')
    expect(declarations('.eventRow')).toContain('min-width: 0')
    expect(declarations('.thinking')).toContain('max-width: 100%')
    expect(declarations('.thinking summary')).toContain('min-width: 0')
    expect(declarations('.thinkingPreview')).toContain('min-width: 0')
    expect(declarations('.thinkingPreview')).toContain('flex: 1 1 auto')
  })

  it('回到最新以容器底部定位，输入区避让高度只扣除一次', () => {
    const latest = declarations('.latestButton')
    expect(latest).toContain('position: absolute')
    expect(latest).toContain('bottom: 8px')
    expect(latest).toContain('left: 50%')
    expect(latest).not.toContain('top:')
    const overlay = declarations('.frame[data-composer-overlay] .latestButton')
    expect(overlay).toContain('bottom: var(--conversation-dock-space, 180px)')
    expect(overlay).not.toContain('top:')
  })
})
