import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { bracketMatching, foldGutter, foldKeymap, indentOnInput } from '@codemirror/language'
import { Compartment, EditorState } from '@codemirror/state'
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from '@codemirror/view'
import { useEffect, useRef, useState } from 'react'
import type { ProjectTextFile } from '../project-workspace/project-types.ts'
import type { OutlineItem } from '../project-workspace/project-types.ts'
import { loadCodeLanguage } from './code-editor-language.ts'
import { codeEditorTheme } from './code-editor-theme.ts'
import { outlineFromEditorState } from './code-outline.ts'

interface CodeEditorProps {
  file: ProjectTextFile
  content: string
  selectedLine: number | null
  saving: boolean
  onChange(content: string): void
  onSave(): void
  onOutlineChange(items: readonly OutlineItem[]): void
  onActiveLineChange(line: number): void
  onCursorChange?(cursor: { line: number; column: number }): void
}

export default function CodeEditor({
  file,
  content,
  selectedLine,
  saving,
  onChange,
  onSave,
  onOutlineChange,
  onActiveLineChange,
  onCursorChange,
}: CodeEditorProps) {
  const parentRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  const onSaveRef = useRef(onSave)
  const onOutlineChangeRef = useRef(onOutlineChange)
  const onActiveLineChangeRef = useRef(onActiveLineChange)
  const onCursorChangeRef = useRef(onCursorChange)
  onCursorChangeRef.current = onCursorChange
  const syncing = useRef(false)
  const editable = useRef(new Compartment())
  const [languageState, setLanguageState] = useState<'loading' | 'ready' | 'error'>('loading')
  onChangeRef.current = onChange
  onSaveRef.current = onSave
  onOutlineChangeRef.current = onOutlineChange
  onActiveLineChangeRef.current = onActiveLineChange

  useEffect(() => {
    const parent = parentRef.current
    if (parent === null) return
    const language = new Compartment()
    setLanguageState('loading')
    let outlineTimer: number | undefined
    const scheduleOutline = () => {
      if (outlineTimer !== undefined) window.clearTimeout(outlineTimer)
      outlineTimer = window.setTimeout(() => {
        outlineTimer = undefined
        if (viewRef.current !== null)
          onOutlineChangeRef.current(outlineFromEditorState(viewRef.current.state))
      }, 80)
    }
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: content,
        extensions: [
          EditorState.readOnly.of(false),
          ['markdown', 'text'].includes(file.language.toLowerCase()) ? EditorView.lineWrapping : [],
          editable.current.of(EditorView.editable.of(!saving)),
          EditorView.contentAttributes.of({
            'aria-label': `${file.relativePath} 的代码内容`,
            spellcheck: 'false',
          }),
          lineNumbers(),
          highlightSpecialChars(),
          drawSelection(),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          bracketMatching(),
          foldGutter(),
          indentOnInput(),
          EditorState.tabSize.of(2),
          history(),
          keymap.of([
            {
              key: 'Mod-s',
              preventDefault: true,
              run: () => {
                onSaveRef.current()
                return true
              },
            },
            indentWithTab,
            ...foldKeymap,
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          EditorView.updateListener.of(update => {
            if (update.docChanged && !syncing.current) {
              onChangeRef.current(update.state.doc.toString())
              scheduleOutline()
            }
            if (update.selectionSet) {
              const head = update.state.selection.main.head
              const line = update.state.doc.lineAt(head)
              onActiveLineChangeRef.current(line.number)
              onCursorChangeRef.current?.({ line: line.number, column: head - line.from + 1 })
            }
          }),
          language.of([]),
          codeEditorTheme,
        ],
      }),
    })
    viewRef.current = view
    onCursorChangeRef.current?.({ line: 1, column: 1 })
    let active = true
    void loadCodeLanguage(file.language)
      .then(support => {
        if (!active) return
        view.dispatch({ effects: language.reconfigure(support) })
        setLanguageState('ready')
        scheduleOutline()
      })
      .catch(() => {
        if (!active) return
        setLanguageState('error')
      })
    return () => {
      active = false
      if (outlineTimer !== undefined) window.clearTimeout(outlineTimer)
      viewRef.current = null
      view.destroy()
      onOutlineChangeRef.current([])
    }
  }, [file.language, file.relativePath])

  useEffect(() => {
    const view = viewRef.current
    if (view === null || view.state.doc.toString() === content) return
    syncing.current = true
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: content },
    })
    syncing.current = false
  }, [content])

  useEffect(() => {
    const view = viewRef.current
    if (view === null) return
    view.dispatch({ effects: editable.current.reconfigure(EditorView.editable.of(!saving)) })
  }, [saving])

  useEffect(() => {
    const view = viewRef.current
    if (view === null || selectedLine === null || view.state.doc.lines === 0) return
    const targetLine = Math.min(Math.max(selectedLine, 1), view.state.doc.lines)
    if (view.state.doc.lineAt(view.state.selection.main.head).number === targetLine) return
    const line = view.state.doc.line(targetLine)
    view.dispatch({
      selection: { anchor: line.from },
      effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
    })
  }, [file.relativePath, selectedLine])

  return (
    <div
      className="code-editor"
      data-language={file.language}
      data-language-ready={languageState === 'ready' ? 'true' : languageState}
      data-saving={saving || undefined}
      aria-busy={languageState === 'loading' || saving}
    >
      <div className="code-editor__mount" ref={parentRef} />
      {languageState === 'error' && (
        <p className="code-editor__notice" role="status">
          语法高亮加载失败，已使用纯文本显示。
        </p>
      )}
    </div>
  )
}
