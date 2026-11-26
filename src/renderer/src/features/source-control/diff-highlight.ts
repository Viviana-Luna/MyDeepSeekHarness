import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { highlightTree } from '@lezer/highlight'
import { languageFromPath } from '../../../../shared/file-language.ts'
import { loadCodeLanguage } from '../files/code-editor-language.ts'
import { codeHighlightStyle } from '../files/code-editor-theme.ts'
import type { DiffPair, DiffRow } from './diff-model.ts'

export type DiffToken = { from: number; to: number; className: string }

export async function highlightDiff(
  pairs: readonly DiffPair[],
  path: string,
): Promise<Map<DiffRow, DiffToken[]>> {
  const language = await loadCodeLanguage(languageFromPath(path))
  const tokens = new Map<DiffRow, DiffToken[]>()
  for (const side of ['left', 'right'] as const) {
    const rows = pairs.flatMap(pair => (pair[side] === null ? [] : [pair[side]]))
    const state = EditorState.create({
      doc: rows.map(row => row.text).join('\n'),
      extensions: [language],
    })
    const tree = ensureSyntaxTree(state, state.doc.length, 40) ?? syntaxTree(state)
    for (const row of rows) tokens.set(row, [])
    highlightTree(tree, codeHighlightStyle, (from, to, className) => {
      let line = state.doc.lineAt(from)
      while (line.from < to) {
        const row = rows[line.number - 1]
        if (row !== undefined && line.to > from) {
          tokens.get(row)!.push({
            from: Math.max(from, line.from) - line.from,
            to: Math.min(to, line.to) - line.from,
            className,
          })
        }
        if (line.number === state.doc.lines) break
        line = state.doc.line(line.number + 1)
      }
    })
  }
  return tokens
}
