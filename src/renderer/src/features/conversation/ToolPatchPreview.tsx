/** renderer 工具补丁预览：只展示会话记录中完整的 apply_patch 输入，不推断文件状态。 */
import { isRecord } from '../../../../shared/validation.ts'
import styles from './ToolPatchPreview.module.css'

const PREVIEW_LINE_LIMIT = 16

function readPatch(argumentsText: string | null): string[] | null {
  if (argumentsText === null) return null
  try {
    const input: unknown = JSON.parse(argumentsText)
    if (!isRecord(input) || typeof input.patch !== 'string') return null
    const lines = input.patch.replaceAll('\r\n', '\n').trim().split('\n')
    if (lines[0] !== '*** Begin Patch' || lines.at(-1) !== '*** End Patch') return null
    return lines.slice(1, -1)
  } catch {
    // 记录可能因长度限制被截断；保留原有输入展示，不把残缺内容当作完整补丁。
    return null
  }
}

function lineKind(line: string): 'addition' | 'deletion' | 'context' {
  if (line.startsWith('+')) return 'addition'
  if (line.startsWith('-')) return 'deletion'
  return 'context'
}

/** 从完整的补丁请求提取文件摘要，不推断写入结果。 */
export function describeToolPatch(
  toolName: string | null,
  argumentsText: string | null,
): string | null {
  if (toolName !== 'apply_patch') return null
  const lines = readPatch(argumentsText)
  if (lines === null) return null
  const paths = lines.flatMap(line => {
    const match = /^\*\*\* (?:Add|Update) File: (.+)$/u.exec(line)
    return match === null ? [] : [match[1]!]
  })
  if (paths.length === 0) return null
  return paths.length === 1 ? paths[0]! : `${paths[0]!} 等 ${String(paths.length)} 个文件`
}

/** 显示有界的补丁输入预览；未识别或不完整的输入继续由调用方展示原文。 */
export function ToolPatchPreview({
  toolName,
  argumentsText,
}: {
  toolName: string | null
  argumentsText: string | null
}) {
  if (toolName !== 'apply_patch') return null
  const lines = readPatch(argumentsText)
  if (lines === null || lines.length === 0) return null
  const shown = lines.slice(0, PREVIEW_LINE_LIMIT)
  return (
    <section className={styles.preview} aria-label="请求的文件补丁预览">
      <div className={styles.header}>请求的文件补丁</div>
      <pre>
        {shown.map((line, index) => (
          <span key={index} data-kind={lineKind(line)}>
            {line || ' '}
          </span>
        ))}
      </pre>
      {shown.length < lines.length && <p>仅预览前 {PREVIEW_LINE_LIMIT} 行，完整记录见下方输入。</p>}
    </section>
  )
}
