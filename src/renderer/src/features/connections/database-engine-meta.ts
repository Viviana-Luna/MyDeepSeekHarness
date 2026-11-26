/** 多引擎数据库界面元数据：定义名称、徽章、默认端口、提示文案与目标摘要格式。 */
import type {
  DatabaseEngine,
  DatabaseProfile,
} from '../../../../../packages/connections/database/types.d.ts'

/** 单个受支持数据库引擎的前端展示与默认值配置。 */
export interface DatabaseEngineOption {
  readonly engine: DatabaseEngine
  readonly label: string
  readonly shortLabel: string
  readonly defaultPort: number
  readonly isLocalFile: boolean
  readonly hostPlaceholder: string
  readonly databaseLabel: string
  readonly databasePlaceholder: string
  readonly summaryHint: string
}

/** 受支持的主流关系型数据库选项顺序列表。 */
export const DATABASE_ENGINE_OPTIONS: readonly DatabaseEngineOption[] = [
  {
    engine: 'mysql',
    label: 'MySQL',
    shortLabel: 'MySQL',
    defaultPort: 3306,
    isLocalFile: false,
    hostPlaceholder: '主机名或 IP 地址',
    databaseLabel: '默认数据库（可选）',
    databasePlaceholder: '例如：app_prod',
    summaryHint: '直连 / SSH',
  },
  {
    engine: 'mariadb',
    label: 'MariaDB',
    shortLabel: 'MariaDB',
    defaultPort: 3306,
    isLocalFile: false,
    hostPlaceholder: '主机名或 IP 地址',
    databaseLabel: '默认数据库（可选）',
    databasePlaceholder: '例如：app_prod',
    summaryHint: '兼容 MySQL',
  },
  {
    engine: 'postgresql',
    label: 'PostgreSQL',
    shortLabel: 'PostgreSQL',
    defaultPort: 5432,
    isLocalFile: false,
    hostPlaceholder: '主机名或 IP 地址',
    databaseLabel: '默认数据库（留空默认 postgres）',
    databasePlaceholder: 'postgres',
    summaryHint: '按 Schema 浏览',
  },
  {
    engine: 'sqlite',
    label: 'SQLite',
    shortLabel: 'SQLite',
    defaultPort: 0,
    isLocalFile: true,
    hostPlaceholder: '',
    databaseLabel: '',
    databasePlaceholder: '',
    summaryHint: '本地磁盘文件',
  },
] as const

/** 按引擎标识取得元数据；缺省按 MySQL 处理以兼容历史连接档案。 */
export function engineMeta(engine?: DatabaseEngine): DatabaseEngineOption {
  return DATABASE_ENGINE_OPTIONS.find(item => item.engine === engine) ?? DATABASE_ENGINE_OPTIONS[0]!
}

/** 从完整 SQLite 磁盘路径提取展示文件名，兼容 macOS `/` 与 Windows `\\`。 */
export function sqliteFileName(filePath?: string | null): string {
  if (!filePath) return ''
  const parts = filePath.split(/[\\/]/u).filter(Boolean)
  return parts.at(-1) ?? filePath
}

/** 格式化数据库连接目标地址，区分远程主机端口与本地 SQLite 文件。 */
export function formatConnectionTarget(profile: DatabaseProfile): string {
  if (profile.engine === 'sqlite') {
    return sqliteFileName(profile.filePath) || '未选择文件'
  }
  return `${profile.host}:${profile.port}`
}

/** 生成卡片与副标题使用的引擎 + 目标摘要文案。 */
export function formatConnectionSummary(profile: DatabaseProfile): string {
  const meta = engineMeta(profile.engine)
  return `${meta.shortLabel} · ${formatConnectionTarget(profile)}`
}

/** 生成悬浮提示与无障碍描述使用的完整连接目标信息。 */
export function formatConnectionTooltip(profile: DatabaseProfile): string {
  const meta = engineMeta(profile.engine)
  if (profile.engine === 'sqlite') {
    return `${meta.label} · ${profile.filePath || '本地数据库文件'}`
  }
  return `${meta.label} · ${profile.username}@${profile.host}:${profile.port}`
}
