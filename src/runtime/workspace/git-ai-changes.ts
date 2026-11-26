/** 后台从同一份可信快照投影模型输入；差异不能作为 Git 写操作授权。 */
import type { GitAiScope, GitAiItem, GitAiExcludedChange } from '../../shared/git-ai.ts'
import type { GitAiSnapshot } from './git-ai-snapshot.ts'
import { GitAiError } from './git-ai-errors.ts'

const MAX_INPUT_BYTES = 256 * 1024

/** 保持分析与桌面使用相同的范围和排除项定义。 */
export type { GitAiScope, GitAiExcludedChange }

/** 模型只能分析此只读版本，不获得目标 blob 或索引字节。 */
export interface GitAiChange extends GitAiItem {
  patch: string
}

/** 分析数据与无法处理的文件，不含仓库外内容。 */
export interface GitAiChanges {
  items: GitAiChange[]
  excluded: GitAiExcludedChange[]
}

/** 从后台快照生成有界模型输入；必须在用户确认发送后调用。 */
export function captureGitAiChanges(snapshot: GitAiSnapshot): GitAiChanges {
  const items = snapshot.items.map(({ id, relativePath, mode, patch, requiresWholeFile }) => ({
    id,
    relativePath,
    mode,
    patch,
    requiresWholeFile,
  }))
  const bytes = Buffer.byteLength(JSON.stringify({ changes: items }))
  if (bytes > MAX_INPUT_BYTES)
    throw new GitAiError(
      `待分析的差异约 ${Math.ceil(bytes / 1024)} KiB，超过大小上限 256 KiB。请取消部分分析类别，或手动暂存部分文件后仅分析暂存区；本次未向模型发送内容`,
    )
  return { items, excluded: snapshot.excluded }
}
