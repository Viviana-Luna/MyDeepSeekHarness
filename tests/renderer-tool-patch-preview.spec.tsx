// @vitest-environment jsdom

/** 验证补丁预览只消费完整请求，并限制长补丁的显示行数。 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  describeToolPatch,
  ToolPatchPreview,
} from '../src/renderer/src/features/conversation/ToolPatchPreview.tsx'

afterEach(cleanup)

describe('工具补丁预览', () => {
  it('仅展示完整补丁的前 16 行', () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: notes.txt',
      ...Array.from({ length: 20 }, (_, index) => `+第 ${String(index + 1)} 行`),
      '*** End Patch',
    ].join('\n')
    render(<ToolPatchPreview toolName="apply_patch" argumentsText={JSON.stringify({ patch })} />)
    expect(screen.getByText('+第 15 行')).toBeTruthy()
    expect(screen.queryByText('+第 16 行')).toBeNull()
    expect(screen.getByText('仅预览前 16 行，完整记录见下方输入。')).toBeTruthy()
  })

  it('不把其他工具或被截断的输入当作补丁', () => {
    const view = render(<ToolPatchPreview toolName="read" argumentsText='{"patch":"内容"}' />)
    expect(screen.queryByRole('region', { name: '请求的文件补丁预览' })).toBeNull()
    view.rerender(<ToolPatchPreview toolName="apply_patch" argumentsText='{"patch":"残缺' />)
    expect(screen.queryByRole('region', { name: '请求的文件补丁预览' })).toBeNull()
  })

  it('文件摘要只来自完整补丁中的文件头', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: a.ts',
      '@@',
      '-旧',
      '+新',
      '*** Add File: b.ts',
      '+内容',
      '*** End Patch',
    ].join('\n')
    expect(describeToolPatch('apply_patch', JSON.stringify({ patch }))).toBe('a.ts 等 2 个文件')
    expect(describeToolPatch('apply_patch', '{"patch":"截断')).toBeNull()
    expect(describeToolPatch('read', JSON.stringify({ patch }))).toBeNull()
  })
})
