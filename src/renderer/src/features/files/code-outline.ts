import { syntaxTree } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'
import type { OutlineItem, OutlineItemKind } from '../project-workspace/project-types.ts'

interface OutlineSyntaxNode {
  readonly name: string
  readonly parent: OutlineSyntaxNode | null
}

const NODE_KINDS: Readonly<Record<string, OutlineItemKind>> = Object.freeze({
  ClassDeclaration: 'class',
  ClassDefinition: 'class',
  InterfaceDeclaration: 'interface',
  FunctionDeclaration: 'function',
  FunctionDefinition: 'function',
  FunctionItem: 'function',
  MethodDeclaration: 'method',
  MethodDefinition: 'method',
  MethodItem: 'method',
  TypeDeclaration: 'type',
  TypeAliasDeclaration: 'type',
  StructItem: 'type',
  EnumItem: 'type',
  TraitItem: 'interface',
  ATXHeading1: 'heading',
  ATXHeading2: 'heading',
  ATXHeading3: 'heading',
  ATXHeading4: 'heading',
  ATXHeading5: 'heading',
  ATXHeading6: 'heading',
  SetextHeading1: 'heading',
  SetextHeading2: 'heading',
})

function outlineDepth(node: OutlineSyntaxNode, kind: OutlineItemKind): number {
  if (kind === 'heading') {
    const match = node.name.match(/Heading([1-6])$/u)
    return match === null ? 0 : Math.max(0, Number(match[1]) - 1)
  }
  let depth = 0
  for (let parent = node.parent; parent !== null; parent = parent.parent) {
    if (
      parent.name === 'ClassDeclaration' ||
      parent.name === 'ClassDefinition' ||
      parent.name === 'InterfaceDeclaration' ||
      parent.name === 'StructItem' ||
      parent.name === 'TraitItem'
    )
      depth += 1
  }
  return Math.min(depth, 6)
}

function symbolLabel(text: string, kind: OutlineItemKind): string | null {
  if (kind === 'heading') {
    const label = text
      .replace(/^\s*#{1,6}\s*/u, '')
      .replace(/\s*#*\s*$/u, '')
      .trim()
    return label === '' ? null : label.slice(0, 120)
  }
  const named =
    text.match(/\b(?:class|interface|enum|trait|struct|type)\s+([\p{L}_$][\p{L}\p{N}_$]*)/u) ??
    text.match(/\b(?:async\s+)?(?:function|def|fn)\s+([\p{L}_$][\p{L}\p{N}_$]*)/u) ??
    text.match(/\bfunc\s+(?:\([^)]*\)\s*)?([\p{L}_$][\p{L}\p{N}_$]*)/u) ??
    text.match(/([\p{L}_$][\p{L}\p{N}_$]*)\s*(?:<[^>]*>\s*)?\(/u)
  return named?.[1]?.slice(0, 120) ?? null
}

export function outlineFromEditorState(state: EditorState): readonly OutlineItem[] {
  const items: OutlineItem[] = []
  syntaxTree(state).iterate({
    enter(reference) {
      if (items.length >= 500) return false
      const kind = NODE_KINDS[reference.name]
      if (kind === undefined) return
      const label = symbolLabel(state.doc.sliceString(reference.from, reference.to), kind)
      if (label === null) return
      const line = state.doc.lineAt(reference.from).number
      items.push({
        id: `${reference.name}:${String(reference.from)}:${label}`,
        label,
        kind,
        line,
        depth: outlineDepth(reference.node, kind),
      })
    },
  })
  return items
}
