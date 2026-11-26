import { describe, expect, it } from 'vitest'

import {
  activeFileReferenceToken,
  formatDesktopFileMention,
} from '../src/shared/file-references.ts'

describe('DSH Web 文件引用语法', () => {
  it('只识别独立 @ token，并按文件名和目录语义生成引用', () => {
    expect(activeFileReferenceToken('请看 @"src/main f', 15)).toMatchObject({
      query: 'src/main f',
      quoted: true,
    })
    expect(activeFileReferenceToken('邮箱 user@example.com', 19)).toBeNull()
    expect(formatDesktopFileMention({ path: 'src/main file.ts', kind: 'file' })).toBe(
      '@"src/main file.ts"',
    )
    expect(formatDesktopFileMention({ path: 'src/components', kind: 'directory' })).toBe(
      '@src/components/',
    )
  })
})
