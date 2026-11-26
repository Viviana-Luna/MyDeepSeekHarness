/** MyDSH 的编码预设只调整模型看到的接口，执行仍交给 DSH 的权限、文件与作业服务。 */
/* oxlint-disable no-await-in-loop -- 补丁先按顺序核对全部上下文，再逐项原子发布，错误后不继续写入。 */
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createFileToolDefinitions } from '@deepseek-ai/dsh-tool-fs'
import { apply as applyBash } from '@deepseek-ai/dsh-tool-bash'
import { apply as applyPwsh } from '@deepseek-ai/dsh-tool-pwsh'
import { apply as applyTodo } from '@deepseek-ai/dsh-tool-todo'
import { applyPatchText, parsePatch } from './patch-format.js'

export const name = 'mydsh-coding-tools'
export const inject = [
  'tools',
  'fs',
  'shell',
  'shellEnv',
  'systemPrompt',
  'jobs',
  'attachments',
  'sessionProjections',
]
export const Config = z.object({
  flavor: z.union(['codex', 'pi']).required(),
  enableRunInBackground: z.boolean(),
  includePlan: z.boolean(),
})

/** 保留原工具的输出校验、可重放展示、取消信号和调用会话，只转换参数名称。 */
function remap(tool, toolName, mapping, description, defaults = {}) {
  const translate = args => ({
    ...defaults,
    ...Object.fromEntries(Object.entries(args).map(([key, value]) => [mapping[key] ?? key, value])),
  })
  const reverse = Object.fromEntries(Object.entries(mapping).map(([key, value]) => [value, key]))
  const properties = Object.fromEntries(
    Object.entries(tool.parameters.properties)
      .filter(([key]) => !(key in defaults))
      .map(([key, value]) => [reverse[key] ?? key, value]),
  )
  return {
    ...tool,
    name: toolName,
    description,
    parameters: {
      ...tool.parameters,
      properties,
      required: (tool.parameters.required ?? [])
        .filter(key => !(key in defaults))
        .map(key => reverse[key] ?? key),
    },
    execute: (args, exec) => tool.execute(translate(args), exec),
    output: {
      ...tool.output,
      render: (args, value) => tool.output.render(translate(args), value),
      ...(tool.output.presentationMeta
        ? {
            presentationMeta: (args, value) => tool.output.presentationMeta(translate(args), value),
          }
        : {}),
    },
    ...(tool.presentCall ? { presentCall: args => tool.presentCall(translate(args)) } : {}),
    ...(tool.presentResult
      ? { presentResult: (args, result) => tool.presentResult(translate(args), result) }
      : {}),
    ...(tool.isConcurrencySafe
      ? { isConcurrencySafe: args => tool.isConcurrencySafe(translate(args)) }
      : {}),
  }
}

/** 多处替换全部针对原文件求值，拒绝歧义和重叠，再用一次原子编辑发布。 */
export function replaceTextEdits(original, edits) {
  if (edits.length === 0) throw new Error('编辑列表不能为空')
  const replacements = edits
    .map(({ oldText, newText }) => {
      if (!oldText) throw new Error('待替换文本不能为空')
      const start = original.indexOf(oldText)
      if (start < 0 || original.indexOf(oldText, start + 1) >= 0)
        throw new Error('待替换文本必须在原文件中恰好出现一次')
      return { start, end: start + oldText.length, newText }
    })
    .toSorted((a, b) => a.start - b.start)
  for (let i = 1; i < replacements.length; i += 1) {
    if (replacements[i].start < replacements[i - 1].end)
      throw new Error('同一次调用的编辑范围不能重叠')
  }
  let result = original
  for (const edit of replacements.toReversed())
    result = result.slice(0, edit.start) + edit.newText + result.slice(edit.end)
  return result
}

const jsonResult = {
  schema: { type: 'json' },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}

/** 复用 Session 待办日志注册 `update_plan` 工具。 */
function registerUpdatePlanTool(ctx) {
  let todo
  applyTodo(ctx, { allowParallelInProgress: false }, definition => {
    todo = definition
  })
  ctx.tools.register(
    defineTool({
      name: 'update_plan',
      description: '更新多步任务的完整计划。简单任务无需计划，最多一项处于 in_progress。',
      parameters: {
        explanation: { type: 'string' },
        plan: {
          type: 'array',
          required: true,
          items: {
            type: 'object',
            properties: {
              step: { type: 'string', required: true },
              status: {
                type: 'string',
                required: true,
                enum: ['pending', 'in_progress', 'completed'],
              },
            },
            additionalProperties: false,
          },
        },
      },
      output: jsonResult,
      execute: (args, exec) =>
        todo.execute(
          { todos: args.plan.map(item => ({ content: item.step, status: item.status })) },
          exec,
        ),
    }),
  )
}

export function apply(ctx, config) {
  const pi = config.flavor === 'pi'
  const allowBackground = config.enableRunInBackground ?? !pi
  // 四种工具属于预设作用域；对该作用域设置空白名单会同时隐藏它们在 Agent 中的继承视图。
  const files = createFileToolDefinitions(ctx, { readLimit: 2000, readMaxBytes: 50 * 1024 })
  const shellName = process.platform === 'win32' ? 'powershell' : 'bash'
  let shell
  const collectShell = definition => {
    shell = definition
  }
  ;(process.platform === 'win32' ? applyPwsh : applyBash)(
    ctx,
    { enableRunInBackground: allowBackground },
    collectShell,
  )
  if (!shell) throw new Error('编码模式缺少 Shell 工具')
  if (pi) {
    const read = files.get('read'),
      image = files.get('read_image')
    const textRead = remap(
      read,
      'read',
      { path: 'file_path' },
      '读取文本或图片。文本最多 2000 行或 50KB；offset 从 1 开始，截断后继续读取。',
    )
    ctx.tools.register({
      ...textRead,
      output: {
        schema: {
          type: 'object',
          properties: { kind: { type: 'string' }, value: {} },
          required: ['kind', 'value'],
          additionalProperties: false,
        },
        render: (args, result) =>
          (result.kind === 'image' ? image : read).output.render(
            { file_path: args.path, offset: args.offset, limit: args.limit },
            result.value,
          ),
      },
      async execute(args, exec) {
        const kind = /\.(?:png|jpe?g|gif|webp)$/iu.test(args.path) ? 'image' : 'text'
        if (kind === 'image' && !image) throw new Error('当前环境不支持图片读取')
        const translated = {
          file_path: args.path,
          ...(args.offset === undefined ? {} : { offset: args.offset }),
          ...(args.limit === undefined ? {} : { limit: args.limit }),
        }
        return {
          kind,
          value: await (kind === 'image' ? image : read).execute(
            kind === 'image' ? { file_path: args.path } : translated,
            exec,
          ),
        }
      },
      presentResult: undefined,
    })
    const shellLabel = shellName === 'powershell' ? ' PowerShell' : ' Bash'
    const backgroundHint = allowBackground
      ? '长任务可设 run_in_background: true 并用 job_output 续读、job_kill 停止；'
      : ''
    const purpose = allowBackground
      ? '用于搜索、构建、验证与调用 mydsh 二级命令'
      : '用于搜索、构建与验证'
    const piShell = remap(
      shell,
      shellName,
      { timeout: 'timeoutMs' },
      `执行${shellLabel}命令。${purpose}；${backgroundHint}timeout 以秒计，调用结束或取消后进程完成清理。`,
      { description: '执行编码模式命令' },
    )
    piShell.parameters.properties.timeout.description = '最长执行秒数。'
    piShell.execute = (args, exec) => {
      const { timeout, ...rest } = args
      return shell.execute(
        {
          ...rest,
          description: '执行编码模式命令',
          ...(timeout === undefined ? {} : { timeoutMs: timeout * 1000 }),
        },
        exec,
      )
    }
    ctx.tools.register(piShell)
    ctx.tools.register(
      remap(
        files.get('write'),
        'write',
        { path: 'file_path' },
        '创建或整体写入 UTF-8 文件。覆盖已有文件前先读取，保留其他修改。',
      ),
    )
    const edit = files.get('edit')
    ctx.tools.register(
      defineTool({
        name: 'edit',
        description: '用精确文本批量编辑一个文件。每项 oldText 针对原文件匹配一次，范围不能重叠。',
        parameters: {
          path: { type: 'string', required: true },
          edits: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              properties: {
                oldText: { type: 'string', required: true },
                newText: { type: 'string', required: true },
              },
              additionalProperties: false,
            },
          },
        },
        output: {
          ...jsonResult,
          render: (_args, value) => [{ type: 'text', text: `已修改 ${value.path}` }],
        },
        async execute(args, exec) {
          const target = await ctx.fs.resolve(args.path, {
            cwd: exec.agent?.session.header.cwd,
            signal: exec.signal,
          })
          const before = await ctx.fs.readText(target, exec.signal)
          const after = replaceTextEdits(before, args.edits)
          return edit.execute({ file_path: args.path, old_string: before, new_string: after }, exec)
        },
        presentCall: args => ({
          card: 'diff',
          title: `编辑 ${args.path}`,
          diffs: args.edits.map(item => ({
            path: args.path,
            oldText: item.oldText,
            newText: item.newText,
          })),
          locations: [{ path: args.path }],
        }),
      }),
    )
    if (config.includePlan) registerUpdatePlanTool(ctx)
    return
  }
  ctx.tools.register(files.get('read'))
  const image = files.get('read_image')
  if (image)
    ctx.tools.register(
      remap(image, 'view_image', {}, '查看本地图片，遵守当前模型的图片输入能力与附件限制。'),
    )
  ctx.tools.register(
    defineTool({
      name: 'exec_command',
      description:
        '执行命令，等待 yield_time_ms 后返回。尚未结束时返回 session_id，可用 job_output 续读、job_kill 取消；所有进程由 MyDSH 管理。Windows 使用 PowerShell 语法。',
      parameters: {
        cmd: { type: 'string', required: true },
        workdir: { type: 'string' },
        yield_time_ms: { type: 'integer' },
        ...(shell.parameters.properties.sandbox_permissions
          ? {
              sandbox_permissions: {
                type: 'string',
                enum: shell.parameters.properties.sandbox_permissions.enum,
              },
              justification: { type: 'string' },
            }
          : {}),
      },
      output: jsonResult,
      async execute(args, exec) {
        const wait = args.yield_time_ms ?? 1000
        if (wait < 0 || wait > 60000) throw new Error('命令等待时间必须在 0 到 60000 毫秒之间')
        const started = await shell.execute(
          {
            command: args.cmd,
            description: '执行编码模式命令',
            run_in_background: true,
            ...(args.workdir === undefined ? {} : { workdir: args.workdir }),
            ...(args.sandbox_permissions === undefined
              ? {}
              : {
                  sandbox_permissions: args.sandbox_permissions,
                  justification: args.justification,
                }),
          },
          exec,
        )
        try {
          exec.signal.throwIfAborted()
          if (wait) await ctx.jobs.wait(started.jobId, wait, exec.agent, exec.signal)
          const result = ctx.jobs.read(started.jobId, exec.agent)
          return { session_id: started.jobId, status: result.snapshot.status, output: result.text }
        } catch (error) {
          if (exec.signal.aborted) {
            ctx.jobs.kill(started.jobId, exec.agent)
            await ctx.jobs.wait(started.jobId, 20000, exec.agent, AbortSignal.timeout(21000))
          }
          throw error
        }
      },
      presentCall: args => ({
        card: 'terminal',
        title: args.cmd,
        ...(args.workdir === undefined ? {} : { cwd: args.workdir }),
      }),
    }),
  )
  registerUpdatePlanTool(ctx)
  ctx.tools.register(
    defineTool({
      name: 'apply_patch',
      description:
        '通过 *** Begin Patch / *** End Patch 和 Add File / Update File 文本补丁创建或修改文件。上下文必须匹配；所有文件先检查再逐个原子写入。删除或移动使用 exec_command。',
      parameters: { patch: { type: 'string', required: true } },
      output: jsonResult,
      async execute(args, exec) {
        const operations = parsePatch(args.patch)
        const prepared = []
        for (const operation of operations) {
          exec.signal.throwIfAborted()
          let content = operation.content
          if (operation.kind === 'update') {
            await files.get('read').execute({ file_path: operation.path }, exec)
            const target = await ctx.fs.resolve(operation.path, {
              cwd: exec.agent?.session.header.cwd,
              signal: exec.signal,
            })
            content = applyPatchText(await ctx.fs.readText(target, exec.signal), operation.hunks)
          }
          prepared.push({ ...operation, content })
        }
        const changed = []
        for (const operation of prepared) {
          const result = await files
            .get('write')
            .execute({ file_path: operation.path, content: operation.content }, exec)
          changed.push({ path: result.path, operation: result.operation })
        }
        return { files: changed }
      },
      presentCall: () => ({ card: 'generic', title: '应用文件补丁', kind: 'edit' }),
    }),
  )
}
