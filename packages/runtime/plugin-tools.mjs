import { defineTool } from '@deepseek-ai/dsh-tools'

const TOOL_NAMES = new Set([
  'converter_prepare',
  'converter_validate',
  'converter_install',
  'converter_list',
])
const output = {
  schema: { type: 'json' },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
}

/**
 * 转换工具进入现有工具注册表，继续接受 Agent 预设、权限门禁、取消和调用日志。
 * 安装会执行受信任原生代码，因此复用现有审批交互；没有审批服务时正常拒绝。
 */
export function installPluginTools(ctx, services) {
  return ctx.plugin({
    name: 'mydsh-plugin-converter-tools',
    inject: ['tools'],
    apply(pluginContext) {
      pluginContext.tools.guard(exec =>
        TOOL_NAMES.has(exec.name) && !exec.agent
          ? '插件转换工具仅供 MyDSH 内部 Agent 使用。'
          : undefined,
      )
      pluginContext.on('tools/pre-execute', async (exec, next) => {
        const decision = await next()
        if (decision.kind !== 'allow' || exec.name !== 'converter_install') return decision
        return {
          kind: 'ask',
          reason: '安装此转换产物后，插件将作为受信任代码在 MyDSH 中运行。请确认安装。',
        }
      })
      pluginContext.tools.register(
        defineTool({
          name: 'converter_prepare',
          description:
            '为用户指定的插件准备独立源码副本。此工具不会自动兼容或重写代码。返回目录后，你必须用普通文件读取和编辑工具分析源码，按 MyDSH SDK 重写后台服务、界面插槽及清单，再调用 converter_validate。不能修改原插件、MyDSH 核心或假称所有官方插件都受支持。',
          parameters: {
            kind: {
              type: 'string',
              required: true,
              enum: ['local', 'git', 'npm'],
              description: '来源类型。',
            },
            path: { type: 'string', description: '本地源码目录，kind=local 时必填。' },
            url: { type: 'string', description: '不含凭据的 HTTPS Git 仓库地址。' },
            ref: { type: 'string', description: 'Git 提交、标签或分支；会记录解析后的固定提交。' },
            name: { type: 'string', description: 'npm 包名。' },
            version: { type: 'string', description: 'npm 精确版本，不接受 latest 或范围。' },
          },
          output,
          async execute(args, exec) {
            requireAgent(exec)
            const field = key => {
              if (typeof args[key] !== 'string' || !args[key].trim())
                throw new Error(`插件来源缺少字段：${key}`)
              return args[key]
            }
            const source =
              args.kind === 'local'
                ? { kind: 'local', path: field('path') }
                : args.kind === 'git'
                  ? { kind: 'git', url: field('url'), ref: field('ref') }
                  : { kind: 'npm', name: field('name'), version: field('version') }
            const record = await services.converter.prepare(source, exec.signal)
            return {
              ...record,
              nextStep:
                '请先读取源码并实际改写。提供 mydsh.plugin.json、tsconfig.json 和 package.json.mydshBuild；使用 @mydsh/sdk 与 @mydsh/ui 公开接口。静态验证成功后还需检查用户要求的实际功能。',
            }
          },
        }),
      )
      pluginContext.tools.register(
        defineTool({
          name: 'converter_validate',
          description:
            '对已经由你修改的插件执行真实 TypeScript 检查、构建和语法验证，生成带来源记录的 MyDSH 插件产物。此工具不会进行 AI 重写，也不会证明业务功能正确。错误需要继续修复源码；不能跳过验证安装。',
          parameters: {
            id: {
              type: 'string',
              required: true,
              description: 'converter_prepare 返回的任务标识。',
            },
          },
          output,
          execute(args, exec) {
            requireAgent(exec)
            return services.converter.validate(args.id, exec.signal)
          },
        }),
      )
      pluginContext.tools.register(
        defineTool({
          name: 'converter_install',
          description:
            '将已验证、未再次修改的转换产物交给插件管理器安装。调用进入现有工具审批流程；必须向用户说明验证结果和已知缺口。安装不会撤销插件之后造成的外部副作用。',
          parameters: {
            id: { type: 'string', required: true, description: '验证成功的转换任务标识。' },
          },
          output,
          execute(args, exec) {
            requireAgent(exec)
            exec.signal.throwIfAborted()
            return services.converter.install(args.id)
          },
        }),
      )
      pluginContext.tools.register(
        defineTool({
          name: 'converter_list',
          description:
            '读取 MyDSH 已安装插件的公开清单和现有转换任务，用于检查依赖、继续失败任务和核对安装结果。不会执行插件或修改文件。',
          parameters: {},
          output,
          async execute(_args, exec) {
            requireAgent(exec)
            return {
              plugins: services.manager.list(),
              conversions: await services.converter.list(),
            }
          },
        }),
      )
    },
  })
}

function requireAgent(exec) {
  if (!exec.agent) throw new Error('插件转换工具只能由 MyDSH 内部 Agent 调用。')
  exec.signal.throwIfAborted()
}
