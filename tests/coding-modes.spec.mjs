import { describe, it, expect, vi } from 'vitest'
import { apply, replaceTextEdits } from '../packages/preset/agent-presets/coding-tools.js'
import { parsePatch, applyPatchText } from '../packages/preset/agent-presets/patch-format.js'

function fixture(flavor, extra = {}) {
  const definitions = new Map(),
    content = new Map([['code.txt', 'one\r\ntwo\r\nthree\r\n']])
  const writes = []
  const ctx = {
    tools: {
      register: definition => {
        definitions.set(definition.name, definition)
      },
      restrict: vi.fn(),
    },
    systemPrompt: { getSectionOrder: () => 0, section: vi.fn() },
    shell: {},
    shellEnv: {},
    sessionProjections: { register: vi.fn() },
    get: () => undefined,
    emit: vi.fn(),
    waterfall: async (_event, _target, _exec, next) => next(),
    fs: {
      resolve: async path => ({ targetKey: path, displayPath: path }),
      stat: async target => ({
        type: 'file',
        size: Buffer.byteLength(content.get(target.targetKey)),
        version: 'v1',
      }),
      readText: async target => content.get(target.targetKey),
      writeText: async (target, after, _intent, signal) => {
        signal.throwIfAborted()
        const before = content.get(target.targetKey) ?? null
        writes.push(target.targetKey)
        content.set(target.targetKey, after)
        return { before, after, operation: before === null ? 'create' : 'update', version: 'v2' }
      },
    },
  }
  apply(ctx, { flavor, ...extra })
  return { ctx, definitions, content, writes }
}

describe('MyDSH 编码模式的工具契约', () => {
  it('极简模式只有四种基础工具，使用 pi 的路径与批量编辑字段，不屏蔽预设自己的工具', () => {
    const { ctx, definitions } = fixture('pi')
    expect([...definitions.keys()].toSorted()).toEqual(
      ['read', 'edit', 'write', process.platform === 'win32' ? 'powershell' : 'bash'].toSorted(),
    )
    expect(ctx.tools.restrict).not.toHaveBeenCalled()
    expect(definitions.get('read').parameters.required).toEqual(['path'])
    expect(definitions.get('edit').parameters.required).toEqual(['path', 'edits'])
    expect(definitions.get('write').parameters.required).toEqual(['path', 'content'])
    expect(
      definitions.get(process.platform === 'win32' ? 'powershell' : 'bash').parameters.properties
        .timeout.description,
    ).toContain('秒')
  })

  it('标准模式编码底座在四工具之上支持后台 Shell 与 update_plan，且不暴露 apply_patch', () => {
    const { definitions } = fixture('pi', { enableRunInBackground: true, includePlan: true })
    const shellTool = definitions.get(process.platform === 'win32' ? 'powershell' : 'bash')
    expect(shellTool.parameters.properties.run_in_background).toBeDefined()
    expect(definitions.has('update_plan')).toBe(true)
    expect(definitions.has('apply_patch')).toBe(false)
  })

  it('ChatGPT 模式提供命令、补丁与计划工具，不暴露 write/edit，计划复用 Session 待办日志', async () => {
    const { definitions } = fixture('codex')
    for (const name of ['exec_command', 'apply_patch', 'update_plan'])
      expect(definitions.has(name)).toBe(true)
    expect(definitions.has('edit')).toBe(false)
    expect(definitions.has('write')).toBe(false)
    const append = vi.fn()
    const signal = new AbortController().signal
    await definitions
      .get('update_plan')
      .execute(
        { plan: [{ step: '完成验收', status: 'in_progress' }] },
        { agent: { session: { append } }, signal },
      )
    expect(append).toHaveBeenCalledWith('todo/write', {
      todos: [{ content: '完成验收', status: 'in_progress' }],
    })
  })

  it('补丁上下文不匹配时不写入前面的新文件，正确补丁保留 CRLF，取消拒绝写入', async () => {
    const { definitions, content, writes } = fixture('codex')
    const patch = definitions.get('apply_patch')
    const signal = new AbortController().signal
    const exec = { signal }
    await expect(
      patch.execute(
        {
          patch:
            '*** Begin Patch\n*** Add File: new.txt\n+new\n*** Update File: code.txt\n@@\n-missing\n+fixed\n*** End Patch',
        },
        exec,
      ),
    ).rejects.toThrow('上下文')
    expect(writes).toEqual([])
    await patch.execute(
      {
        patch:
          '*** Begin Patch\n*** Update File: code.txt\n@@\n one\n-two\n+changed\n three\n*** End Patch',
      },
      exec,
    )
    expect(content.get('code.txt')).toBe('one\r\nchanged\r\nthree\r\n')
    const aborted = new AbortController()
    aborted.abort()
    await expect(
      patch.execute(
        { patch: '*** Begin Patch\n*** Add File: cancelled.txt\n+new\n*** End Patch' },
        { signal: aborted.signal },
      ),
    ).rejects.toThrow()
    expect(content.has('cancelled.txt')).toBe(false)
  })

  it('批量替换相对于原文定位，拒绝歧义和重叠', () => {
    expect(
      replaceTextEdits('aaa bbb ccc', [
        { oldText: 'aaa', newText: 'bbb' },
        { oldText: 'bbb', newText: 'ddd' },
      ]),
    ).toBe('bbb ddd ccc')
    expect(() => replaceTextEdits('x x', [{ oldText: 'x', newText: 'y' }])).toThrow('一次')
    expect(() =>
      replaceTextEdits('abcd', [
        { oldText: 'abc', newText: 'x' },
        { oldText: 'bcd', newText: 'y' },
      ]),
    ).toThrow('重叠')
    expect(() => parsePatch('*** Begin Patch\n*** Delete File: code.txt\n*** End Patch')).toThrow(
      '删除',
    )
    expect(applyPatchText('a\nb', [{ before: ['b'], after: ['c'], context: '', end: true }])).toBe(
      'a\nc',
    )
  })
})
