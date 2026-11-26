/**
 * 二级受控 CLI 的命令目录与帮助文档生成器：维护领域子命令到真实工具名的映射，并从工具 Schema 动态渲染说明。
 * 无状态纯数据模块，可同时在后台 Runtime 与 CLI 客户端子进程中使用。
 */
/** 二级 CLI 参数渲染与转换所需的工具 Schema 最小契约。 */
export interface CliToolSchema {
  readonly name: string
  readonly description: string
  readonly parameters: unknown
}

/** 单个二级 CLI 子命令条目。 */
export interface CliActionEntry {
  readonly action: string
  readonly toolName: string
  readonly summary: string
}

/** 二级 CLI 的能力分组定义。 */
export interface CliDomainSpec {
  readonly domain: string
  readonly summary: string
  readonly actions: readonly CliActionEntry[]
}

/** MyDSH 二级受控 CLI 的完整领域与动作表。 */
export const CLI_DOMAINS: readonly CliDomainSpec[] = [
  {
    domain: 'db',
    summary: '数据库连接发现、结构查看、只读 SQL 查询与受控变更（MySQL/MariaDB/PostgreSQL/SQLite）',
    actions: [
      {
        action: 'list',
        toolName: 'database_connections_list',
        summary: '列出开放给模型的数据库连接与权限',
      },
      {
        action: 'schema',
        toolName: 'database_schema',
        summary: '查看库、表、字段、索引或外键结构',
      },
      {
        action: 'query',
        toolName: 'database_query',
        summary: '执行只读 SQL 查询（支持 --sql-stdin）',
      },
      {
        action: 'mutate',
        toolName: 'database_mutate',
        summary: '执行需要确认的数据修改或结构变更 SQL',
      },
    ],
  },
  {
    domain: 'ssh',
    summary: '已授权 SSH 主机发现、远程 SFTP 目录/文件读写与受控命令执行',
    actions: [
      {
        action: 'list',
        toolName: 'ssh_connections_list',
        summary: '列出开放给模型的 SSH 主机连接',
      },
      { action: 'ls', toolName: 'ssh_list_dir', summary: '列出远程目录条目' },
      { action: 'read', toolName: 'ssh_read_file', summary: '按行读取远程文本文件' },
      { action: 'write', toolName: 'ssh_write_file', summary: '写入或覆盖远程文本文件（需审批）' },
      { action: 'exec', toolName: 'ssh_exec', summary: '在远程主机执行受控命令' },
    ],
  },
  {
    domain: 'browser',
    summary: '内置隔离浏览器与外置 Chrome/Edge（统一 CDP）自动化控制',
    actions: [
      {
        action: 'status',
        toolName: 'browser_status',
        summary: '查看浏览器启用状态、授权域名与接管态',
      },
      { action: 'tabs', toolName: 'browser_tabs', summary: '列出、新建、切换或关闭受管标签页' },
      { action: 'navigate', toolName: 'browser_navigate', summary: '导航、刷新或前进/后退页面' },
      {
        action: 'snapshot',
        toolName: 'browser_snapshot',
        summary: '提取可交互元素快照与 @eN 引用编号',
      },
      { action: 'click', toolName: 'browser_click', summary: '按 @eN 引用点击页面元素' },
      { action: 'type', toolName: 'browser_type', summary: '向页面输入框填入文本' },
      { action: 'press-key', toolName: 'browser_press_key', summary: '向当前页面发送按键' },
      { action: 'select', toolName: 'browser_select', summary: '选择下拉框选项' },
      { action: 'scroll', toolName: 'browser_scroll', summary: '滚动页面或指定元素' },
      { action: 'wait', toolName: 'browser_wait', summary: '等待页面文本出现或固定毫秒数' },
      {
        action: 'diagnostics',
        toolName: 'browser_diagnostics',
        summary: '读取当前标签页脱敏后的 Console 日志与网络请求摘要',
      },
      {
        action: 'screenshot',
        toolName: 'browser_screenshot',
        summary: '截取网页画面并返回本地图片路径',
      },
    ],
  },
  {
    domain: 'computer',
    summary: '系统级桌面窗口截图、聚焦与键鼠操控（macOS / Windows）',
    actions: [
      {
        action: 'status',
        toolName: 'computer_status',
        summary: '查看系统权限、显示器与可见窗口列表',
      },
      {
        action: 'screenshot',
        toolName: 'computer_screenshot',
        summary: '截取屏幕或后台窗口并返回图片路径',
      },
      { action: 'focus-window', toolName: 'computer_focus_window', summary: '聚焦并锁定目标窗口' },
      { action: 'click', toolName: 'computer_click', summary: '点击屏幕或后台窗口坐标' },
      { action: 'drag', toolName: 'computer_drag', summary: '按住拖放鼠标从起点到终点' },
      { action: 'scroll', toolName: 'computer_scroll', summary: '在目标坐标执行滚轮滚动' },
      { action: 'type', toolName: 'computer_type', summary: '向当前焦点窗口输入文本' },
      { action: 'key', toolName: 'computer_key', summary: '发送系统按键或快捷键组合' },
    ],
  },
  {
    domain: 'plugin',
    summary: 'MyDSH 原生插件与预设开发：Cordis 接口自省、转换准备、构建验证与安装',
    actions: [
      { action: 'list', toolName: 'converter_list', summary: '查看已安装插件清单与现有转换任务' },
      {
        action: 'prepare',
        toolName: 'converter_prepare',
        summary: '为本地/Git/npm 插件准备独立转换目录',
      },
      {
        action: 'validate',
        toolName: 'converter_validate',
        summary: '对改写后的插件执行类型检查与构建验证',
      },
      {
        action: 'install',
        toolName: 'converter_install',
        summary: '经用户审批安装已验证的转换产物',
      },
      {
        action: 'inspect-list',
        toolName: 'cordis_inspect_list',
        summary: '列出宿主与前端公开的 Cordis 自省提供方',
      },
      {
        action: 'inspect-query',
        toolName: 'cordis_inspect_query',
        summary: '查询指定 Cordis 服务、事件或插槽契约',
      },
    ],
  },
]

const DOMAIN_MAP = new Map(CLI_DOMAINS.map(item => [item.domain, item]))

/** 根据领域名查找对应的二级 CLI 分组定义。 */
export function findCliDomain(domain: string): CliDomainSpec | undefined {
  return DOMAIN_MAP.get(domain)
}

/** 根据领域名与子命令查找对应的真实工具名。 */
export function resolveCliToolName(domain: string, action: string): string | undefined {
  const spec = DOMAIN_MAP.get(domain)
  if (!spec) return undefined
  return spec.actions.find(item => item.action === action)?.toolName
}

/** 渲染顶层 `mydsh --help` 概览说明。 */
export function renderRootHelp(): string {
  const lines = [
    'MyDSH 受控二级能力命令行（仅在模型 Shell 会话内通过本地 IPC 调用宿主服务）',
    '',
    '用法：',
    '  mydsh --help',
    '  mydsh <domain> --help',
    '  mydsh <domain> <action> --help',
    '  mydsh <domain> <action> [--flag value ...] [--json \'{"key":"value"}\'] [--json-stdin]',
    '  mydsh call <tool_name> [--flag value ...] [--json \'{"key":"value"}\'] [--json-stdin]',
    '',
    '可用领域（Domains）：',
  ]
  for (const item of CLI_DOMAINS) {
    lines.push(`  ${item.domain.padEnd(10)} ${item.summary}`)
  }
  lines.push(
    '',
    '参数传递提示：',
    '  - 普通字段可直接传 --kebab-case（如 --connection-id local）或原字段名（--connection_id local）；值以 -- 开头时请使用 --flag=value',
    '  - 多行 SQL、脚本或带复杂引号的文本建议通过管道传入：--<字段名>-stdin 或 --json-stdin',
    '  - 涉及数据库写入、SSH 写入/执行、桌面操控或插件安装的命令会触发界面审批，请留足命令超时时间',
  )
  return lines.join('\n')
}

/** 渲染单个领域的子命令列表说明。 */
export function renderDomainHelp(domain: string): string | undefined {
  const spec = DOMAIN_MAP.get(domain)
  if (!spec) return undefined
  const lines = [
    `mydsh ${spec.domain} — ${spec.summary}`,
    '',
    `用法：mydsh ${spec.domain} <action> [options]`,
    '',
    '子命令（Actions）：',
  ]
  for (const entry of spec.actions) {
    lines.push(`  ${entry.action.padEnd(16)} ${entry.summary}（对应 ${entry.toolName}）`)
  }
  lines.push('', `查看具体参数：mydsh ${spec.domain} <action> --help`)
  return lines.join('\n')
}

function formatPropertyType(prop: Record<string, unknown>): string {
  if (Array.isArray(prop.enum)) {
    return prop.enum.map(item => JSON.stringify(item)).join(' | ')
  }
  if (Array.isArray(prop.oneOf)) {
    return prop.oneOf
      .map(branch =>
        typeof branch === 'object' && branch !== null && 'type' in branch
          ? String((branch as { type: unknown }).type)
          : 'json',
      )
      .join(' | ')
  }
  return typeof prop.type === 'string' ? prop.type : 'json'
}

/** 根据真实工具 Schema 渲染单条子命令的参数手册。 */
export function renderActionHelp(invocationLabel: string, schema: CliToolSchema): string {
  const lines = [
    `${invocationLabel}（工具：${schema.name}）`,
    '',
    schema.description,
    '',
    `用法：${invocationLabel} [options]`,
    '',
    '参数（Options）：',
  ]
  const rawParams = schema.parameters as {
    properties?: Record<string, Record<string, unknown>>
    required?: readonly string[]
  }
  const properties = rawParams.properties ?? {}
  const requiredSet = new Set(rawParams.required ?? [])
  const keys = Object.keys(properties)
  if (keys.length === 0) {
    lines.push('  （无业务参数）')
  } else {
    for (const key of keys) {
      const prop = properties[key] ?? {}
      const flag = `--${key
        .replace(/([a-z0-9])([A-Z])/gu, '$1-$2')
        .replaceAll('_', '-')
        .toLowerCase()}`
      const reqTag = requiredSet.has(key) ? '必填' : '可选'
      const typeLabel = formatPropertyType(prop)
      const desc = typeof prop.description === 'string' ? prop.description : ''
      lines.push(`  ${flag} <${typeLabel}> [${reqTag}]`)
      if (desc) lines.push(`      ${desc}`)
    }
  }
  lines.push(
    '',
    '通用选项：',
    '  --json <json>         直接传入完整 JSON 参数对象',
    '  --json-stdin          从标准输入读取完整 JSON 参数对象',
    '  --<field>-stdin       从标准输入读取单字段原始文本（如 --sql-stdin、--content-stdin）',
  )
  return lines.join('\n')
}
