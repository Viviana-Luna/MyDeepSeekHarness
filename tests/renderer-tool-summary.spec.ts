/** 验证工具摘要清洗，不改变原始输入。 */
import { describe, expect, it } from 'vitest'
import {
  formatToolSummary,
  stripMarkdownInline,
} from '../src/renderer/src/features/conversation/tool-summary.ts'

describe('对话工具摘要', () => {
  it('清理思考预览中的 Markdown', () => {
    expect(stripMarkdownInline('## **检查 [官方来源](https://example.com)**')).toBe('检查 官方来源')
  })
  it('展示查询、解码网址、路径与命令', () => {
    expect(formatToolSummary('Search', '{"queries":["甲","乙","丙"]}', '')).toBe(
      '甲 · 乙（共 3 项）',
    )
    expect(
      formatToolSummary('Web', '{"url":"https://www.example.com/%E5%86%85%E6%A0%B8"}', ''),
    ).toBe('example.com › 内核')
    expect(formatToolSummary('Read', '{"path":"src/a.ts","start_line":10,"end_line":50}', '')).toBe(
      'src/a.ts:L10-L50',
    )
    expect(formatToolSummary('Bash', '{"command":"pwd\\nls"}', '')).toBe('pwd')
  })
  it('畸形结构使用安全回退，不抛出错误', () => {
    expect(formatToolSummary('Search', '{"queries":', '')).toBe('查看调用详情')
    expect(formatToolSummary('Web', 'https://example.com/%E5%', '')).toBe('example.com › …')
    expect(formatToolSummary('未知', null, '已完成')).toBe('已完成')
  })
})
