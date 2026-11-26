import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { tags } from '@lezer/highlight'

export const codeHighlightStyle = HighlightStyle.define([
  {
    tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment],
    class: 'tok-comment',
  },
  {
    tag: [
      tags.keyword,
      tags.controlKeyword,
      tags.definitionKeyword,
      tags.moduleKeyword,
      tags.operatorKeyword,
    ],
    class: 'tok-keyword',
  },
  {
    tag: [
      tags.string,
      tags.docString,
      tags.character,
      tags.attributeValue,
      tags.regexp,
      tags.escape,
    ],
    class: 'tok-string',
  },
  {
    tag: [tags.number, tags.integer, tags.float, tags.bool, tags.null, tags.atom, tags.unit],
    class: 'tok-literal',
  },
  { tag: [tags.typeName, tags.className, tags.namespace], class: 'tok-type' },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
    class: 'tok-function',
  },
  {
    tag: [tags.constant(tags.variableName), tags.macroName, tags.annotation, tags.modifier],
    class: 'tok-constant',
  },
  { tag: [tags.tagName, tags.attributeName], class: 'tok-tag' },
  { tag: [tags.operator, tags.punctuation, tags.separator, tags.bracket], class: 'tok-operator' },
  { tag: [tags.heading, tags.strong], class: 'tok-heading' },
  { tag: [tags.link, tags.url], class: 'tok-link' },
  { tag: tags.monospace, class: 'tok-code' },
  { tag: tags.invalid, class: 'tok-invalid' },
])

const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: 'var(--editor-background)',
    color: 'var(--editor-text)',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    overflow: 'auto',
    fontFamily: 'var(--editor-font-family)',
    fontSize: 'var(--code-editor-font-size)',
    fontVariantLigatures: 'var(--code-editor-font-ligatures)',
    lineHeight: 'var(--code-editor-line-height)',
  },
  '.cm-content': {
    minWidth: 'max-content',
    padding: '16px 24px 40px 0',
    caretColor: 'var(--editor-cursor)',
  },
  '.cm-content.cm-lineWrapping': { minWidth: '0' },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'var(--editor-cursor)',
    borderLeftWidth: '2px',
    marginLeft: '-1px',
  },
  '.cm-line': { padding: '0 0 0 12px' },
  '.cm-gutters': {
    borderRight: 'none',
    backgroundColor: 'var(--editor-gutter-background)',
    color: 'var(--editor-line-number)',
  },
  '.cm-lineNumbers .cm-gutterElement': {
    minWidth: '48px',
    padding: '0 8px 0 12px',
  },
  '.cm-foldGutter .cm-gutterElement': { padding: '0 4px', cursor: 'pointer' },
  '.cm-activeLine': { backgroundColor: 'var(--editor-active-line)' },
  '.cm-activeLineGutter': {
    borderLeft: '2px solid var(--editor-accent)',
    backgroundColor: 'var(--editor-active-line)',
    color: 'var(--editor-active-line-number)',
    fontWeight: '500',
  },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection':
    {
      backgroundColor: 'var(--editor-selection)',
    },
  '.cm-matchingBracket': {
    outline: '1px solid var(--editor-bracket-border)',
    backgroundColor: 'var(--editor-bracket-background)',
  },
})

export const codeEditorTheme: readonly Extension[] = Object.freeze([
  editorTheme,
  syntaxHighlighting(codeHighlightStyle),
])
