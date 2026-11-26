import { describe, expect, it } from 'vitest'

import {
  parseModelSelectionProjection,
  parsePermissionCatalog,
  parsePermissionCurrent,
  parseSelectedModelResponse,
  parseSessionModels,
  permissionCommandError,
  permissionPresetDescription,
  permissionPresetLabel,
  permissionSelectionFrom,
} from '../src/renderer/src/domain/session-controls.ts'

describe('renderer 会话模型目录边界', () => {
  it('组合 Host 目录与 Session 模型投影，并允许 current 位于目录之外', () => {
    const projection = parseModelSelectionProjection({
      asOfSeq: 7,
      values: {
        modelSelection: {
          lastUsed: { provider: '官方', model: '默认模型' },
          next: { provider: '旧路由', model: '仍可使用的模型' },
        },
      },
    })
    const parsed = parseSessionModels(
      {
        default: { provider: '官方', model: '默认模型' },
        routableProviders: ['官方', '旧路由'],
        groups: [
          {
            id: '提供方-1',
            name: '提供方一',
            models: [
              {
                id: '模型-1',
                name: '模型一',
                description: '测试模型',
                reasoning: {
                  efforts: [
                    { id: 'low', name: '低' },
                    { id: 'max', name: '最大' },
                  ],
                  defaultEffort: 'low',
                },
              },
            ],
          },
        ],
        failures: [{ id: '故障提供方', name: '故障提供方', message: '目录暂不可用' }],
      },
      projection?.next,
    )

    expect(parsed).toMatchObject({
      default: { provider: '官方', model: '默认模型' },
      current: { provider: '旧路由', model: '仍可使用的模型' },
      routable: true,
    })
    expect(parsed?.groups[0]?.models[0]?.reasoning?.efforts.map(item => item.id)).toEqual([
      'low',
      'max',
    ])
    expect(parsed?.failures).toHaveLength(1)
  })

  it('拒绝结构不完整的目录，未选择时回退 Host 默认模型', () => {
    expect(
      parseSessionModels({ default: {}, routableProviders: [], groups: [], failures: [] }),
    ).toBeNull()
    expect(
      parseSessionModels({
        default: { provider: 'p', model: 'm' },
        routableProviders: ['p', ''],
        groups: [{ id: 'p', name: 'P', models: [{ id: 'm' }] }],
        failures: [],
      }),
    ).toBeNull()
    expect(
      parseSessionModels({
        default: { provider: 'p', model: 'm' },
        routableProviders: [],
        groups: [],
        failures: [],
      }),
    ).toMatchObject({
      current: { provider: 'p', model: 'm' },
      routable: false,
    })
    expect(
      parseSelectedModelResponse({
        selected: { provider: 'p', model: 'm', reasoningEffort: 'max' },
      }),
    ).toEqual({ provider: 'p', model: 'm', reasoningEffort: 'max' })
  })
})

describe('renderer 权限投影边界', () => {
  const catalog = {
    options: [
      { value: 'workspace-write', name: 'Workspace Write' },
      { value: 'danger-full-access', name: 'Full access', description: '不限制文件访问。' },
    ],
  }

  it('当前值取自会话投影，可选预设取自进程级目录', () => {
    expect(
      parsePermissionCurrent({ values: { permissions: { currentValue: 'workspace-write' } } }),
    ).toBe('workspace-write')
    expect(
      parsePermissionCurrent({
        projections: { values: { permissions: { currentValue: 'custom' } } },
      }),
    ).toBe('custom')
    // 运行核心的投影只发布当前值，没有 currentValue 的帧按缺失处理。
    expect(parsePermissionCurrent({ values: { permissions: {} } })).toBeNull()
    expect(parsePermissionCurrent(undefined)).toBeNull()

    const options = parsePermissionCatalog(catalog)
    expect(options).toEqual([
      { value: 'workspace-write', name: 'Workspace Write', selectable: true },
      {
        value: 'danger-full-access',
        name: 'Full access',
        description: '不限制文件访问。',
        selectable: true,
      },
    ])
    // 空目录与不完整项都拒绝，避免把半份列表当成可选范围。
    expect(parsePermissionCatalog({ options: [] })).toBeNull()
    expect(parsePermissionCatalog({ options: [{ value: 'a' }] })).toBeNull()
    expect(parsePermissionCatalog(null)).toBeNull()
  })

  it('只发布目录里的选项，当前值可以不在目录里', () => {
    const options = parsePermissionCatalog(catalog)
    const selection = permissionSelectionFrom('custom', options)
    expect(selection?.currentValue).toBe('custom')
    // 不额外造行：custom 不在目录里，就没有可切换的目标。
    expect(selection?.options).toEqual(options)

    const stale = permissionSelectionFrom('legacy-preset', options)
    expect(stale?.options).toEqual(options)

    // 只差其一（目录或当前值）时不合成，控件保持不渲染。
    expect(permissionSelectionFrom(null, options)).toBeNull()
    expect(permissionSelectionFrom('workspace-write', null)).toBeNull()
  })

  it('内置预设用产品文案，自定义名称原样转标题式', () => {
    expect(permissionPresetLabel('read-only', 'read-only')).toBe('仅可查看')
    expect(permissionPresetLabel('workspace-write', 'workspace-write')).toBe('工作区内修改')
    expect(permissionPresetLabel('danger-full-access', 'danger-full-access')).toBe('完全权限')
    // 运行核心给了自己的名字时保留它，不被内置文案顶掉。
    expect(permissionPresetLabel('workspace-write', 'Workspace Write')).toBe('Workspace Write')
    expect(permissionPresetLabel('team-readonly', 'team-readonly')).toBe('Team Readonly')
    expect(permissionPresetLabel('自定义', '自定义')).toBe('自定义')
    expect(
      permissionPresetDescription({ value: 'read-only', name: 'read-only', selectable: true }),
    ).toContain('只能查看')
  })

  it('目录已公布的值可以直接切换，并区分命令业务失败', () => {
    const selection = permissionSelectionFrom('workspace-write', parsePermissionCatalog(catalog))
    expect(
      selection?.options.some(option => option.value === 'danger-full-access' && option.selectable),
    ).toBe(true)
    expect(permissionCommandError({ commandId: 'c', result: { kind: 'success' } })).toBeNull()
    expect(
      permissionCommandError({ commandId: 'c', result: { kind: 'error', text: '拒绝切换' } }),
    ).toBe('拒绝切换')
    expect(permissionCommandError(undefined)).toBe('权限切换暂不可用')
  })
})
