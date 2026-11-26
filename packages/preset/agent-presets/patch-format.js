/** 根据公开的 Codex 文本补丁格式独立实现；文件权限与原子发布由 DSH 文件服务拥有。 */
export function parsePatch(patch) {
  const lines = patch.replaceAll('\r\n', '\n').trim().split('\n')
  if (lines.shift() !== '*** Begin Patch' || lines.pop() !== '*** End Patch')
    throw new Error('补丁必须以 *** Begin Patch 开始，以 *** End Patch 结束')
  const operations = [],
    paths = new Set()
  let cursor = 0
  while (cursor < lines.length) {
    const header = /^(?:\*\*\* )(Add|Update) File: (.+)$/u.exec(lines[cursor++])
    if (!header) throw new Error('补丁只接受 Add File 与 Update File；删除和移动请使用命令工具')
    const path = header[2].trim()
    if (!path || path.includes('\0') || paths.has(path)) throw new Error('补丁路径无效或重复')
    paths.add(path)
    if (header[1] === 'Add') {
      const content = []
      while (cursor < lines.length && !lines[cursor].startsWith('*** ')) {
        const line = lines[cursor++]
        if (!line.startsWith('+')) throw new Error('新文件的每一行必须以 + 开始')
        content.push(line.slice(1))
      }
      operations.push({
        kind: 'add',
        path,
        content: content.join('\n') + (content.length ? '\n' : ''),
      })
    } else {
      const hunks = []
      while (cursor < lines.length && !/^\*\*\* (?:Add|Update|Delete|Move)/u.test(lines[cursor])) {
        if (!lines[cursor].startsWith('@@')) throw new Error('修改文件的每一段必须以 @@ 开始')
        const context = lines[cursor++].slice(2).trim()
        const before = [],
          after = []
        let end = false
        while (
          cursor < lines.length &&
          !lines[cursor].startsWith('@@') &&
          !lines[cursor].startsWith('*** ')
        ) {
          const line = lines[cursor++]
          if (![' ', '+', '-'].includes(line[0]))
            throw new Error('补丁内容必须使用空格、+ 或 - 前缀')
          if (line[0] !== '+') before.push(line.slice(1))
          if (line[0] !== '-') after.push(line.slice(1))
        }
        if (lines[cursor] === '*** End of File') {
          end = true
          cursor++
        }
        if (!before.length && !after.length) throw new Error('补丁段落不能为空')
        hunks.push({ before, after, context, end })
      }
      if (!hunks.length) throw new Error('文件修改缺少补丁段落')
      operations.push({ kind: 'update', path, hunks })
    }
  }
  if (!operations.length) throw new Error('补丁不能为空')
  return operations
}

export function applyPatchText(original, hunks) {
  const crlf = original.includes('\r\n')
  const lines = original.replaceAll('\r\n', '\n').split('\n')
  const newline = lines.at(-1) === ''
  if (newline) lines.pop()
  let cursor = 0
  for (const hunk of hunks) {
    if (hunk.context) {
      const context = lines.indexOf(hunk.context, cursor)
      if (context < 0) throw new Error('补丁定位上下文不匹配')
      cursor = context + 1
    }
    let match = -1
    for (let index = cursor; index <= lines.length - hunk.before.length; index += 1) {
      if (hunk.end && index + hunk.before.length !== lines.length) continue
      if (hunk.before.every((line, offset) => lines[index + offset] === line)) {
        match = index
        break
      }
    }
    if (match < 0) throw new Error('补丁上下文与当前文件不匹配，请重新读取文件')
    lines.splice(match, hunk.before.length, ...hunk.after)
    cursor = match + hunk.after.length
  }
  return lines.join(crlf ? '\r\n' : '\n') + (newline ? (crlf ? '\r\n' : '\n') : '')
}
