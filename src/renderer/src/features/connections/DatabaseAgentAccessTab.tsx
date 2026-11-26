/** 数据库连接「Agent 权限」配置标签页：选择访问档位，并用可选表规则进一步收窄权限。 */
import { Button, Checkbox, Input, Switch } from 'antd'
import { Plus, ShieldCheck, Trash2 } from 'lucide-react'
import { useId } from 'react'
import type {
  DatabaseAgentAccess,
  DatabaseAgentAccessMode,
  DatabaseEngine,
  DatabasePermissionFlags,
  DatabasePermissionKey,
  DatabaseTablePermission,
} from '../../../../../packages/connections/database/types.d.ts'

function isSystemSchemaName(schema: string, engine: DatabaseEngine = 'mysql'): boolean {
  const lower = schema.toLowerCase()
  if (engine === 'postgresql') {
    return (
      lower === 'information_schema' ||
      lower === 'pg_catalog' ||
      lower === 'pg_toast' ||
      lower.startsWith('pg_temp_') ||
      lower.startsWith('pg_toast_temp_')
    )
  }
  if (engine === 'sqlite') {
    return (
      lower === 'sqlite_master' ||
      lower === 'sqlite_schema' ||
      lower === 'sqlite_temp_master' ||
      lower === 'sqlite_temp_schema' ||
      lower.startsWith('sqlite_')
    )
  }
  return ['information_schema', 'mysql', 'performance_schema', 'sys'].includes(lower)
}

const PERMISSION_OPTIONS: readonly { key: DatabasePermissionKey; label: string; short: string }[] =
  [
    { key: 'select', label: '查询与结构（SELECT）', short: '查询' },
    { key: 'insert', label: '新增（INSERT）', short: '新增' },
    { key: 'update', label: '修改（UPDATE）', short: '修改' },
    { key: 'delete', label: '删除（DELETE）', short: '删除' },
    { key: 'ddl', label: '结构变更（DDL）', short: 'DDL' },
  ]

const MODE_PERMISSIONS: Record<DatabaseAgentAccessMode, DatabasePermissionFlags> = {
  readonly: { select: true, insert: false, update: false, delete: false, ddl: false },
  readwrite: { select: true, insert: true, update: true, delete: true, ddl: false },
  full: { select: true, insert: true, update: true, delete: true, ddl: true },
}

const MODE_OPTIONS: readonly {
  mode: DatabaseAgentAccessMode
  label: string
  description: string
}[] = [
  { mode: 'readonly', label: '只读', description: '读取结构和查询数据，不允许写入或 DDL。' },
  { mode: 'readwrite', label: '数据读写', description: '允许增删改查，不允许修改表结构。' },
  { mode: 'full', label: '完整访问', description: '允许业务表 DML、DDL、TRUNCATE 和重命名。' },
]

/** 生成默认模型访问策略：连接先保持关闭，开启后默认只读。 */
export function createDefaultAgentAccess(): DatabaseAgentAccess {
  return { enabled: false, mode: 'readonly', tableRules: [] }
}

/** 深拷贝已有连接模型访问策略；缺失时回退为关闭的默认策略。 */
export function cloneAgentAccess(source?: DatabaseAgentAccess): DatabaseAgentAccess {
  if (!source) return createDefaultAgentAccess()
  return {
    enabled: source.enabled,
    mode: source.mode,
    tableRules: source.tableRules.map(rule => ({ ...rule })),
  }
}

/** 保存前校验表级规则必填项、系统库限制与重复项，返回中文错误提示或 null。 */
export function validateAgentAccessDraft(
  access: DatabaseAgentAccess,
  engine: DatabaseEngine = 'mysql',
): string | null {
  if (access.tableRules.length > 200) return '表级权限规则最多允许 200 条'
  const seen = new Set<string>()
  for (const [index, rule] of access.tableRules.entries()) {
    const schema = rule.schema.trim()
    const table = rule.table.trim()
    if (!schema || !table) return `第 ${index + 1} 条表级规则必须填写数据库和表名（支持 *）`
    if (isSystemSchemaName(schema, engine)) return `第 ${index + 1} 条规则不能针对系统库 ${schema}`
    if (engine === 'sqlite' && table.toLowerCase().startsWith('sqlite_'))
      return `第 ${index + 1} 条规则不能针对系统保留表 ${table}`
    const dedupeKey = `${schema.toLowerCase()}\0${table.toLowerCase()}`
    if (seen.has(dedupeKey)) return `表级规则存在重复目标：${schema}.${table}`
    seen.add(dedupeKey)
  }
  return null
}

/** 生成用于数据库工作区头部的紧凑模型权限摘要文案。 */
export function formatAgentAccessSummary(access: DatabaseAgentAccess): string {
  if (!access.enabled) return '模型访问已关闭'
  const mode = MODE_OPTIONS.find(item => item.mode === access.mode)?.label ?? '只读'
  return access.tableRules.length > 0
    ? `模型已开放 · ${mode} · 表规则 ${access.tableRules.length} 条`
    : `模型已开放 · ${mode}`
}

/** 「Agent 权限」标签页组件的参数契约。 */
export interface DatabaseAgentAccessTabProps {
  value: DatabaseAgentAccess
  onChange: (next: DatabaseAgentAccess) => void
  engine?: DatabaseEngine | undefined
  availableSchemas?: readonly string[] | undefined
  availableTables?: Readonly<Record<string, readonly { name: string }[]>> | undefined
  defaultDatabase?: string | null | undefined
}

function clampRuleToMode(
  rule: DatabaseTablePermission,
  mode: DatabaseAgentAccessMode,
): DatabaseTablePermission {
  const allowed = MODE_PERMISSIONS[mode]
  return {
    ...rule,
    select: rule.select && allowed.select,
    insert: rule.insert && allowed.insert,
    update: rule.update && allowed.update,
    delete: rule.delete && allowed.delete,
    ddl: rule.ddl && allowed.ddl,
  }
}

function TableRuleRow({
  index,
  rule,
  mode,
  schemaListId,
  schemaPlaceholder,
  availableTables,
  onPatch,
  onRemove,
}: {
  index: number
  rule: DatabaseTablePermission
  mode: DatabaseAgentAccessMode
  schemaListId: string
  schemaPlaceholder: string
  availableTables?: Readonly<Record<string, readonly { name: string }[]>> | undefined
  onPatch: (index: number, patch: Partial<DatabaseTablePermission>) => void
  onRemove: (index: number) => void
}) {
  const tableListId = `${schemaListId}-tables-${index}`
  const tableSuggestions = rule.schema.trim() ? (availableTables?.[rule.schema.trim()] ?? []) : []
  const allowed = MODE_PERMISSIONS[mode]
  return (
    <div className="database-agent-rule" role="group" aria-label={`表级规则 ${index + 1}`}>
      <div className="database-agent-rule-targets">
        <Input
          size="small"
          list={schemaListId}
          value={rule.schema}
          maxLength={64}
          placeholder={schemaPlaceholder}
          aria-label={`第 ${index + 1} 条规则数据库名`}
          onChange={event => onPatch(index, { schema: event.target.value })}
        />
        <span aria-hidden="true">.</span>
        <Input
          size="small"
          list={tableListId}
          value={rule.table}
          maxLength={64}
          placeholder="表名或 *"
          aria-label={`第 ${index + 1} 条规则表名`}
          onChange={event => onPatch(index, { table: event.target.value })}
        />
        <datalist id={tableListId}>
          <option value="*" />
          {tableSuggestions.map(item => (
            <option key={item.name} value={item.name} />
          ))}
        </datalist>
        <Button
          size="small"
          type="text"
          danger
          aria-label={`删除第 ${index + 1} 条表级规则`}
          icon={<Trash2 size={14} />}
          onClick={() => onRemove(index)}
        />
      </div>
      <div className="database-agent-rule-flags">
        {PERMISSION_OPTIONS.map(option => (
          <Checkbox
            key={option.key}
            checked={rule[option.key] && allowed[option.key]}
            disabled={!allowed[option.key]}
            onChange={event => onPatch(index, { [option.key]: event.target.checked })}
          >
            {option.short}
          </Checkbox>
        ))}
      </div>
    </div>
  )
}

/** 在连接编辑弹窗中渲染模型开关、访问档位与表级访问策略。 */
export function DatabaseAgentAccessTab({
  value,
  onChange,
  engine = 'mysql',
  availableSchemas,
  availableTables,
  defaultDatabase,
}: DatabaseAgentAccessTabProps) {
  const schemaListId = useId()
  const filteredSchemas = (availableSchemas ?? []).filter(name => !isSystemSchemaName(name, engine))
  const schemaPlaceholder = engine === 'sqlite' ? 'main' : '数据库名（schema）'
  const effectiveSchemaPlaceholder =
    engine === 'postgresql' ? 'public（Schema）' : schemaPlaceholder

  const changeMode = (mode: DatabaseAgentAccessMode) => {
    onChange({
      ...value,
      mode,
      tableRules: value.tableRules.map(rule => clampRuleToMode(rule, mode)),
    })
  }

  const defaultSchemaForEngine = () => {
    if (engine === 'sqlite') return 'main'
    if (engine === 'postgresql') return 'public'
    return defaultDatabase || ''
  }

  const addRule = () => {
    const initialSchema = filteredSchemas[0] || defaultSchemaForEngine()
    onChange({
      ...value,
      tableRules: [
        ...value.tableRules,
        {
          schema: initialSchema,
          table: '*',
          ...MODE_PERMISSIONS[value.mode],
        },
      ],
    })
  }

  const patchRule = (index: number, patch: Partial<DatabaseTablePermission>) =>
    onChange({
      ...value,
      tableRules: value.tableRules.map((item, idx) =>
        idx === index ? clampRuleToMode({ ...item, ...patch }, value.mode) : item,
      ),
    })

  const removeRule = (index: number) =>
    onChange({
      ...value,
      tableRules: value.tableRules.filter((_, idx) => idx !== index),
    })

  return (
    <div className="database-agent-tab">
      <div className="database-agent-switch-row">
        <div>
          <div className="database-agent-title">
            <ShieldCheck size={15} aria-hidden="true" />
            <span>向模型开放此连接</span>
          </div>
          <p className="database-agent-hint">
            关闭后模型工具不会发现或访问该连接。开启后选择最高权限档位，写入和 DDL 仍会单独确认。
          </p>
        </div>
        <Switch
          aria-label="向模型开放此连接"
          checked={value.enabled}
          onChange={enabled => onChange({ ...value, enabled })}
        />
      </div>

      {value.enabled && (
        <>
          <section className="database-agent-section" aria-label="Agent 权限档位">
            <div className="database-agent-section-head">
              <div>
                <strong>连接权限档位</strong>
                <p className="database-agent-hint">
                  档位决定默认能力；表级规则只会进一步收窄。越过权限墙时可临时申请本次或本会话提权。
                </p>
              </div>
            </div>
            <div className="database-agent-mode-grid" aria-label="Agent 权限档位">
              {MODE_OPTIONS.map(option => (
                <button
                  key={option.mode}
                  type="button"
                  aria-pressed={value.mode === option.mode}
                  data-mode={option.mode}
                  className="database-agent-mode"
                  onClick={() => changeMode(option.mode)}
                >
                  <strong>{option.label}</strong>
                  <span>{option.description}</span>
                </button>
              ))}
            </div>
            {value.mode === 'full' && (
              <p className="database-agent-warning">
                完整访问允许模型创建、修改、删除和清空业务表，请为 Agent 使用独立数据库账号。
              </p>
            )}
          </section>

          <section className="database-agent-section" aria-label="表级细粒度规则">
            <div className="database-agent-section-head">
              <div>
                <strong>表级细粒度规则（{value.tableRules.length}/200）</strong>
                <p className="database-agent-hint">
                  精确表优先于整库通配；未匹配规则时使用连接档位。系统库始终禁止。
                </p>
              </div>
              <Button size="small" icon={<Plus size={14} />} onClick={addRule}>
                添加表规则
              </Button>
            </div>
            <datalist id={schemaListId}>
              {filteredSchemas.map(name => (
                <option key={name} value={name} />
              ))}
            </datalist>
            {value.tableRules.length === 0 ? (
              <div className="database-agent-empty">
                未配置单独表规则，连接内业务表使用上方档位。
              </div>
            ) : (
              <div className="database-agent-rule-list">
                {value.tableRules.map((rule, index) => (
                  <TableRuleRow
                    key={`${index}`}
                    index={index}
                    rule={rule}
                    mode={value.mode}
                    schemaListId={schemaListId}
                    schemaPlaceholder={effectiveSchemaPlaceholder}
                    availableTables={availableTables}
                    onPatch={patchRule}
                    onRemove={removeRule}
                  />
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  )
}
