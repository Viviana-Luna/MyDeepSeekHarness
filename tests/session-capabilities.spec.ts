import { describe, expect, it } from 'vitest'

import {
  DESKTOP_COMMAND_DIRECTORY_MAX_ITEMS,
  DESKTOP_COMMAND_LINE_MAX_BYTES,
  parseDesktopCommandExecutionResult,
  parseDesktopCommandList,
  parseDesktopSkillList,
  parseDesktopSlashCommandLine,
  parseDesktopSlashInvocation,
} from '../src/shared/session-capabilities.ts'

describe('桌面命令与 Skill 目录安全解析', () => {
  it('只保留命令描述字段，并把 false 图片能力归一为缺失', () => {
    expect(
      parseDesktopCommandList([
        {
          name: 'compact',
          description: '压缩当前上下文',
          input: { hint: '[focus]', images: false, internal: '不外发' },
          handler: '不外发',
        },
        {
          name: 'image_task',
          description: '处理图片',
          input: { hint: '<说明>', images: true },
        },
      ]),
    ).toEqual([
      {
        name: 'compact',
        description: '压缩当前上下文',
        input: { hint: '[focus]' },
      },
      {
        name: 'image_task',
        description: '处理图片',
        input: { hint: '<说明>', images: true },
      },
    ])
  })

  it('只从 skills/list value 投影可展示字段', () => {
    expect(
      parseDesktopSkillList({
        skills: [
          {
            name: 'review-code',
            description: '审查代码',
            whenToUse: '需要结构化检查时',
            modelInvocable: false,
            source: '/Users/luna/不得外发',
            invocation: { userInvocable: true },
          },
        ],
        internal: '不外发',
      }),
    ).toEqual([
      {
        name: 'review-code',
        description: '审查代码',
        whenToUse: '需要结构化检查时',
        modelInvocable: false,
      },
    ])
  })

  it('拒绝非法名称、重复名称、无效字段类型和超大目录', () => {
    expect(() => parseDesktopCommandList([{ name: 'Compact', description: '非法大写' }])).toThrow(
      '无效的命令名称',
    )
    expect(() =>
      parseDesktopCommandList([
        { name: 'compact', description: '一' },
        { name: 'compact', description: '二' },
      ]),
    ).toThrow('无效的命令目录')
    expect(() =>
      parseDesktopCommandList([
        { name: 'compact', description: '压缩', input: { hint: '目标', images: '是' } },
      ]),
    ).toThrow('无效的命令图片输入标记')
    expect(() =>
      parseDesktopSkillList({
        skills: Array.from({ length: DESKTOP_COMMAND_DIRECTORY_MAX_ITEMS + 1 }, () => ({
          name: 'same',
          description: '过多',
          modelInvocable: true,
        })),
      }),
    ).toThrow('无效的 Skill 目录')
  })
})

describe('桌面命令执行安全解析', () => {
  it('区分未匹配、成功和错误，并丢弃未知字段', () => {
    expect(parseDesktopCommandExecutionResult(undefined)).toBeUndefined()
    expect(
      parseDesktopCommandExecutionResult({
        commandId: 'command-1',
        result: {
          kind: 'success',
          text: '完成',
          sourceEventSeq: 8,
          secret: '不外发',
        },
        attachment: '不外发',
      }),
    ).toEqual({
      commandId: 'command-1',
      result: { kind: 'success', text: '完成', sourceEventSeq: 8 },
    })
    expect(
      parseDesktopCommandExecutionResult({
        commandId: 'command-2',
        result: { kind: 'error', text: '参数无效', stack: '不外发' },
      }),
    ).toEqual({
      commandId: 'command-2',
      result: { kind: 'error', text: '参数无效' },
    })
  })

  it('拒绝错误结果缺少文本、负 sourceEventSeq 和未知 kind', () => {
    expect(() =>
      parseDesktopCommandExecutionResult({
        commandId: 'command-1',
        result: { kind: 'error' },
      }),
    ).toThrow('无效的命令错误文本')
    expect(() =>
      parseDesktopCommandExecutionResult({
        commandId: 'command-1',
        result: { kind: 'success', sourceEventSeq: -1 },
      }),
    ).toThrow('无效的命令源事件序号')
    expect(() =>
      parseDesktopCommandExecutionResult({
        commandId: 'command-1',
        result: { kind: 'future' },
      }),
    ).toThrow('无效的命令执行结果')
  })

  it('按 UTF-8 字节限制完整 slash command，并校验命令名', () => {
    expect(parseDesktopSlashCommandLine('/compact  保留原始空白')).toBe('/compact  保留原始空白')
    expect(parseDesktopSlashCommandLine('compact')).toBeNull()
    expect(parseDesktopSlashCommandLine('/Compact')).toBeNull()
    expect(parseDesktopSlashCommandLine('/compact\n下一行')).toBe('/compact\n下一行')
    expect(parseDesktopSlashCommandLine(`/${'a'.repeat(161)}`)).toBeNull()
    expect(
      parseDesktopSlashCommandLine(`/x ${'😀'.repeat(DESKTOP_COMMAND_LINE_MAX_BYTES / 4)}`),
    ).toBeNull()
  })

  it('统一提取命令或 Skill 名称，并保留提交行的原始参数空白', () => {
    expect(parseDesktopSlashInvocation('/compact  保留原始空白')).toEqual({
      name: 'compact',
      line: '/compact  保留原始空白',
    })
    expect(parseDesktopSlashInvocation('/1-review\n下一行')).toEqual({
      name: '1-review',
      line: '/1-review\n下一行',
    })
    expect(parseDesktopSlashInvocation(' /compact')).toBeNull()
    expect(parseDesktopSlashInvocation('/')).toBeNull()
    expect(parseDesktopSlashInvocation('/Compact')).toBeNull()
  })
})
