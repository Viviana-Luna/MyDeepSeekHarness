import { syntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { highlightTree } from '@lezer/highlight'
import { describe, expect, it } from 'vitest'

import {
  codeLanguageKey,
  loadCodeLanguage,
} from '../src/renderer/src/features/files/code-editor-language.ts'
import {
  codeEditorTheme,
  codeHighlightStyle,
} from '../src/renderer/src/features/files/code-editor-theme.ts'

describe('代码编辑器主题', () => {
  it('自绘光标和拖放光标使用主题颜色并适当加粗', () => {
    const state = EditorState.create({ extensions: [codeEditorTheme] })
    const rules = state
      .facet(EditorView.styleModule)
      .map(module => module.getRules())
      .join('\n')
    const cursorRule = rules.match(/\.cm-cursor[^{}]*\.cm-dropCursor\s*\{([^}]*)\}/u)?.[1] ?? ''
    expect(cursorRule).toMatch(/border-left-color:\s*var\(--editor-cursor\)/u)
    expect(cursorRule).toMatch(/border-left-width:\s*2px/u)
    expect(cursorRule).toMatch(/margin-left:\s*-1px/u)
  })
})

describe('代码查看器语法高亮', () => {
  it('按项目服务语言标识动态加载解析器，并输出稳定的语义样式', async () => {
    expect(codeLanguageKey('TypeScriptReact')).toBe('typescriptreact')
    expect(await loadCodeLanguage('text')).toEqual([])

    const support = await loadCodeLanguage('java')
    const state = EditorState.create({
      doc: '// 中文注释\npublic final class Demo { private String value = "ready"; }',
      extensions: [support],
    })
    const classes = new Set<string>()
    highlightTree(syntaxTree(state), codeHighlightStyle, (_from, _to, value) => {
      for (const name of value.split(' ')) classes.add(name)
    })

    expect([...classes]).toEqual(
      expect.arrayContaining(['tok-comment', 'tok-keyword', 'tok-string', 'tok-type']),
    )
  })
})
