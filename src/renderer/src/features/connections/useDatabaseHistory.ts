/** renderer 内保存当前窗口的成功查询记录，窗口销毁时释放，不写入磁盘。 */
import { useRef, useState } from 'react'
import type {
  DatabaseProfile,
  DatabaseResult,
} from '../../../../../packages/connections/database/types.d.ts'

/** 查询历史只恢复草稿，不自动重新执行 SQL。 */
export interface DatabaseHistoryEntry {
  readonly id: number
  readonly connectionId: string
  readonly connectionName: string
  readonly catalog?: string | null
  readonly schema: string | null
  readonly sql: string
  readonly executedAt: number
  readonly rowCount: number
  readonly elapsedMs: number
}

/** 只记录已完成且仍属于当前选择的查询，最多保留最近 30 条。 */
export function useDatabaseHistory() {
  const [entries, setEntries] = useState<DatabaseHistoryEntry[]>([])
  const nextId = useRef(0)
  const record = ({
    profile,
    catalog,
    schema,
    sql,
    result,
  }: {
    profile: DatabaseProfile
    catalog?: string | null
    schema: string | null
    sql: string
    result: DatabaseResult
  }) => {
    const entry: DatabaseHistoryEntry = {
      id: ++nextId.current,
      connectionId: profile.id,
      connectionName: profile.name,
      catalog: catalog ?? null,
      schema,
      sql,
      executedAt: Date.now(),
      rowCount: result.rowCount,
      elapsedMs: result.elapsedMs,
    }
    setEntries(current => [entry, ...current].slice(0, 30))
  }
  return { entries, record }
}
