export type DiffRow = {
  kind: 'hunk' | 'context' | 'addition' | 'deletion' | 'meta'
  text: string
  oldLine: number | null
  newLine: number | null
  noNewline?: boolean
  changed?: readonly [number, number]
}

export function parseUnifiedDiff(patch: string): DiffRow[] {
  let oldLine = 0
  let newLine = 0
  let oldRemaining = 0
  let newRemaining = 0
  let oldMode = ''
  const rows: DiffRow[] = []
  const info = (kind: 'hunk' | 'meta', text: string) => {
    rows.push({ kind, text, oldLine: null, newLine: null })
  }
  for (const text of patch.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(text)
    if (hunk !== null) {
      oldLine = Number(hunk[1])
      newLine = Number(hunk[3])
      oldRemaining = Number(hunk[2] ?? 1)
      newRemaining = Number(hunk[4] ?? 1)
      info('hunk', `旧版第 ${String(oldLine)} 行 · 新版第 ${String(newLine)} 行`)
      continue
    }
    if (text.startsWith('\\ No newline')) {
      const previous = rows.at(-1)
      if (previous !== undefined) previous.noNewline = true
      continue
    }
    // 进入分块后，首字符属于补丁标记，其余内容即使以 ++/-- 开头也仍是代码。
    if (oldRemaining > 0 && text.startsWith('-')) {
      rows.push({ kind: 'deletion', text: text.slice(1), oldLine: oldLine++, newLine: null })
      oldRemaining -= 1
      continue
    }
    if (newRemaining > 0 && text.startsWith('+')) {
      rows.push({ kind: 'addition', text: text.slice(1), oldLine: null, newLine: newLine++ })
      newRemaining -= 1
      continue
    }
    if (oldRemaining > 0 && newRemaining > 0 && text.startsWith(' ')) {
      rows.push({ kind: 'context', text: text.slice(1), oldLine: oldLine++, newLine: newLine++ })
      oldRemaining -= 1
      newRemaining -= 1
      continue
    }
    if (text.startsWith('diff --git ')) {
      oldRemaining = newRemaining = 0
      oldMode = ''
    } else if (text.startsWith('old mode ')) {
      oldMode = text.slice(9)
    } else if (text.startsWith('new mode ')) {
      const newMode = text.slice(9)
      info(
        'meta',
        oldMode === '100644' && newMode === '100755'
          ? '新增可执行权限'
          : oldMode === '100755' && newMode === '100644'
            ? '移除可执行权限'
            : `文件权限：${oldMode} → ${newMode}`,
      )
    } else if (text.startsWith('new file mode ')) {
      info('meta', '新文件')
    } else if (text.startsWith('deleted file mode ')) {
      info('meta', '文件已删除')
    } else if (text.startsWith('rename from ')) {
      info('meta', `原路径：${text.slice(12)}`)
    } else if (text.startsWith('rename to ')) {
      info('meta', `新路径：${text.slice(10)}`)
    }
  }
  return rows
}

export type DiffPair = { left: DiffRow | null; right: DiffRow | null; info?: DiffRow }

export function pairDiffRows(rows: readonly DiffRow[]): DiffPair[] {
  const pairs: DiffPair[] = []
  for (let index = 0; index < rows.length;) {
    const row = rows[index]!
    if (row.kind !== 'addition' && row.kind !== 'deletion') {
      pairs.push(
        row.kind === 'context' ? { left: row, right: row } : { left: null, right: null, info: row },
      )
      index += 1
      continue
    }
    const removed: DiffRow[] = []
    const added: DiffRow[] = []
    while (rows[index]?.kind === 'deletion' || rows[index]?.kind === 'addition') {
      const change = rows[index++]!
      const side = change.kind === 'deletion' ? removed : added
      side.push({ ...change })
    }
    for (let offset = 0; offset < Math.max(removed.length, added.length); offset += 1) {
      const left = removed[offset] ?? null
      const right = added[offset] ?? null
      if (left !== null && right !== null) {
        let start = 0
        let oldEnd = left.text.length
        let newEnd = right.text.length
        while (start < oldEnd && start < newEnd && left.text[start] === right.text[start])
          start += 1
        while (
          oldEnd > start &&
          newEnd > start &&
          left.text[oldEnd - 1] === right.text[newEnd - 1]
        ) {
          oldEnd -= 1
          newEnd -= 1
        }
        left.changed = [start, oldEnd]
        right.changed = [start, newEnd]
      }
      pairs.push({ left, right })
    }
  }
  return pairs
}
