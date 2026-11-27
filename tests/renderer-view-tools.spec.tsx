// @vitest-environment jsdom
/** 验证 renderer 的会话侧边入口与 Git 底部操作，几何与主题由 Electron 验收。 */
import { readFileSync } from 'node:fs'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConversationTools } from '../src/renderer/src/features/conversation/ConversationTools.tsx'
import { SourceControlView } from '../src/renderer/src/features/source-control/SourceControlView.tsx'
import type { GitDiff } from '../src/renderer/src/features/source-control/source-control-types.ts'

vi.mock('../src/renderer/src/features/source-control/SourceControlProvider.tsx', () => ({
  useSourceControl: () => ({ gitSummary: null, selectedDiff: null, selectedCommit: null }),
}))
vi.mock('../src/renderer/src/features/source-control/diff-highlight.ts', () => ({
  highlightDiff: async () => {
    throw new Error('语言高亮暂时不可用')
  },
}))
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('紧凑视图工具', () => {
  it('会话视图使用纵向键盘切换，并保留可访问名称与焦点，不再渲染重复的会话预设入口', () => {
    const onViewChange = vi.fn()
    const view = render(<ConversationTools view="conversation" onViewChange={onViewChange} />)
    expect(screen.getByRole('tablist', { name: '会话视图' }).getAttribute('aria-orientation')).toBe(
      'vertical',
    )
    expect(screen.queryByRole('button', { name: '会话预设' })).toBeNull()
    const conversation = screen.getByRole('tab', { name: '对话' })
    const trajectory = screen.getByRole('tab', { name: '轨迹' })
    fireEvent.keyDown(conversation, { key: 'ArrowDown' })
    expect(onViewChange).toHaveBeenLastCalledWith('trajectory')
    expect(document.activeElement).toBe(trajectory)
    view.rerender(<ConversationTools view="trajectory" onViewChange={onViewChange} />)
    expect(trajectory.getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(trajectory, { key: 'Home' })
    expect(onViewChange).toHaveBeenLastCalledWith('conversation')
    expect(document.activeElement).toBe(conversation)
  })

  it('Git 布局入口在滚动正文之后，切换不丢失代码和截断提示', () => {
    const diff: GitDiff = {
      relativePath: 'demo.ts',
      mode: 'working',
      presentation: 'text',
      truncated: true,
      patch: '@@ -1 +1 @@\n-const before = 1\n+const after = 2\n',
    }
    const view = render(<SourceControlView document={diff} />)
    expect(screen.getByLabelText('差异文件路径').textContent).toBe('demo.ts')
    const footer = screen.getByLabelText('差异视图操作')
    expect(footer.tagName).toBe('FOOTER')
    expect(footer.previousElementSibling?.classList.contains('diff-content')).toBe(true)
    const sources = screen.getByRole('group', { name: '比较来源' })
    expect(footer.contains(sources)).toBe(true)
    expect(sources.textContent).toBe('旧版 · 暂存区新版 · 工作区')
    expect(view.container.querySelector('.diff-content .diff-sources')).toBeNull()
    const inline = screen.getByRole('button', { name: '行内' })
    fireEvent.click(inline)
    expect(inline.getAttribute('aria-pressed')).toBe('true')
    expect(footer.contains(sources)).toBe(true)
    expect(view.container.querySelector('.diff-inline')?.textContent).toContain('const after = 2')
    expect(screen.getByText(/Diff 超过桌面查看器上限/u).closest('.diff-content')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '并排' }))
    expect(view.container.querySelector('.diff-split')?.textContent).toContain('const before = 1')
    view.rerender(<SourceControlView document={{ ...diff, presentation: 'binary' }} />)
    expect(screen.queryByLabelText('差异视图操作')).toBeNull()
  })

  it('提交与分支对比来源保持完整提示，不在正文重复呈现', () => {
    const diff: GitDiff = {
      relativePath: 'demo.ts',
      mode: 'commit',
      commitHash: 'abcdef1234567890',
      presentation: 'text',
      truncated: false,
      patch: '@@ -1 +1 @@\n-旧内容\n+新内容\n',
    }
    const view = render(<SourceControlView document={diff} />)
    expect(screen.getByTitle('新版 · abcdef1').closest('footer')).toBeTruthy()
    view.rerender(
      <SourceControlView
        document={{ ...diff, mode: 'review', sources: ['很长的比较起点分支', '目标分支'] }}
      />,
    )
    expect(screen.getByTitle('旧版 · 很长的比较起点分支').closest('footer')).toBeTruthy()
    expect(screen.getByTitle('新版 · 目标分支').closest('footer')).toBeTruthy()
    expect(view.container.querySelector('.diff-content .diff-sources')).toBeNull()
  })

  it('不显示分块定位标题，但保留真实行号、跨块配对和权限说明', () => {
    const diff: GitDiff = {
      relativePath: 'demo.ts',
      mode: 'working',
      presentation: 'text',
      truncated: false,
      patch: [
        'old mode 100644',
        'new mode 100755',
        '@@ -20,2 +30,1 @@',
        '-旧甲',
        '-旧乙',
        '+新甲',
        '@@ -50,1 +60,2 @@',
        '-旧丙',
        '+新乙',
        '+新丙',
      ].join('\n'),
    }
    const view = render(<SourceControlView document={diff} />)
    expect(screen.queryByText(/旧版第.*新版第/u)).toBeNull()
    expect(view.container.querySelector('.diff-row--hunk')).toBeNull()
    expect(screen.getByText('新增可执行权限')).toBeTruthy()
    const pairs = [...view.container.querySelectorAll('.diff-pair')]
    expect(pairs).toHaveLength(4)
    expect(
      pairs.map(pair => pair.querySelector('.diff-side:first-child > span')?.textContent),
    ).toEqual(['20', '21', '50', ''])
    expect(
      pairs.map(pair => pair.querySelector('.diff-side:last-child > span')?.textContent),
    ).toEqual(['30', '', '60', '61'])
    fireEvent.click(screen.getByRole('button', { name: '行内' }))
    expect(screen.queryByText(/旧版第.*新版第/u)).toBeNull()
    expect(screen.getByText('旧丙')).toBeTruthy()
    expect(screen.getByText('新丙')).toBeTruthy()
  })

  it('底栏使用共享分栏轨道，文字和按钮居中，公共样式后加载也不覆盖布局', () => {
    const style = document.createElement('style')
    style.textContent = [
      'src/renderer/src/styles/tokens.css',
      'src/renderer/src/features/source-control/source-control.css',
      'src/renderer/src/styles/view-tools.css',
    ]
      .map(path => readFileSync(path, 'utf8'))
      .join('\n')
    document.head.append(style)
    try {
      render(
        <SourceControlView
          document={{
            relativePath: 'demo.ts',
            mode: 'working',
            presentation: 'text',
            truncated: false,
            patch: '@@ -1 +1 @@\n-旧内容\n+新内容\n',
          }}
        />,
      )
      const footer = screen.getByLabelText('差异视图操作')
      const sources = screen.getByRole('group', { name: '比较来源' })
      const toggle = screen.getByRole('group', { name: 'Diff 布局' })
      expect(getComputedStyle(footer).display).toBe('grid')
      expect(getComputedStyle(footer).gridTemplateColumns).toBe('50% minmax(0, 1fr) max-content')
      expect(getComputedStyle(footer).alignItems).toBe('center')
      expect(getComputedStyle(sources).gridTemplateColumns).toBe('subgrid')
      expect(getComputedStyle(sources).alignItems).toBe('center')
      expect(getComputedStyle(sources.children[1]!).paddingLeft).toBe('10px')
      expect(getComputedStyle(toggle).gridColumn).toBe('3')
      expect(getComputedStyle(toggle).alignItems).toBe('center')
    } finally {
      style.remove()
    }
  })
})
