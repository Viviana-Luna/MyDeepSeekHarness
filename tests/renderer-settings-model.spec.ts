import { describe, expect, it } from 'vitest'

import {
  buildValidatedModelDraft,
  formatReasoningSummary,
  parseInitialReasoning,
  resolveProviderBrand,
  validateReasoningEfforts,
} from '../src/renderer/src/features/settings/model-provider-meta.ts'
import {
  enumStringsAtField,
  namespaceOf,
  parseAgentPresetRoster,
  parseCredentialStates,
  parseHostModelCatalog,
  parseHostModelProviders,
  parseHostSettingsDocument,
  parseModelSelection,
  preferenceOf,
  valueAtPath,
} from '../src/renderer/src/features/settings/settings-model.ts'

describe('renderer 设置中心 Host 投影', () => {
  it('解析 settings/describe 文档并安全读取命名空间和值路径', () => {
    const document = parseHostSettingsDocument({
      writable: true,
      hasDocument: true,
      namespaces: [
        {
          ns: 'ui-conversation',
          schema: {
            type: 'object',
            properties: {
              busyEnter: {
                type: 'union',
                list: [
                  { type: 'const', value: 'queue' },
                  { type: 'const', value: 'steer' },
                ],
              },
            },
          },
          value: { busyEnter: 'queue', nested: { enabled: true } },
          base: { busyEnter: 'queue' },
          user: {},
          applies: 'live',
          secrets: [{ path: ['provider', 'apiKey'], set: true }],
          revision: 12,
        },
      ],
    })

    expect(document).not.toBeNull()
    expect(namespaceOf(document, 'ui-theme', 'ui-conversation')).toMatchObject({
      ns: 'ui-conversation',
      revision: 12,
    })
    expect(preferenceOf(document, 'ui-conversation', 'busyEnter')).toBe('queue')
    expect(
      valueAtPath(namespaceOf(document, 'ui-conversation')?.value, ['nested', 'enabled']),
    ).toBe(true)
    expect(
      valueAtPath(namespaceOf(document, 'ui-conversation')?.value, ['nested', 'missing']),
    ).toBeUndefined()
    expect(
      enumStringsAtField(namespaceOf(document, 'ui-conversation')?.schema, 'busyEnter'),
    ).toEqual(['queue', 'steer'])
  })

  it('从真实 Schemastery { uid, refs } 引用图中解析字段枚举并防御循环引用与共享节点', () => {
    const piAiSchema = {
      uid: 100,
      refs: {
        '100': { type: 'object', dict: { providers: 101 } },
        '101': { type: 'dict', inner: 102 },
        '102': {
          type: 'object',
          dict: {
            fallbackApi: 153,
            api: 151,
            nestedSelf: 102,
          },
          meta: { default: { api: 'ignored-meta' } },
        },
        '151': { type: 'union', list: [153, 155, 157, 159] },
        '153': { type: 'const', value: 'openai-completions' },
        '155': { type: 'const', value: 'openai-responses' },
        '157': { type: 'const', value: 'anthropic-messages' },
        '159': { type: 'const', value: 'google-generative-ai' },
      },
    }
    expect(enumStringsAtField(piAiSchema, 'api')).toEqual([
      'openai-completions',
      'openai-responses',
      'anthropic-messages',
      'google-generative-ai',
    ])

    const permissionSchema = {
      uid: 'root',
      refs: {
        root: { type: 'object', dict: { defaultPreset: 'presetUnion' } },
        presetUnion: { type: 'union', list: ['p1', 'p2'] },
        p1: { type: 'const', value: 'workspace-write' },
        p2: { type: 'const', value: 'read-only' },
      },
    }
    expect(enumStringsAtField(permissionSchema, 'defaultPreset')).toEqual([
      'workspace-write',
      'read-only',
    ])
  })

  it('拒绝越界 revision、非法密钥路径和不完整文档', () => {
    expect(
      parseHostSettingsDocument({ writable: true, hasDocument: true, namespaces: [] }),
    ).toEqual({ writable: true, hasDocument: true, namespaces: [] })
    expect(parseHostSettingsDocument({ writable: true, namespaces: [] })).toBeNull()
    expect(
      parseHostSettingsDocument({
        writable: true,
        hasDocument: false,
        namespaces: [
          {
            ns: 'locale',
            schema: {},
            value: {},
            applies: 'live',
            secrets: [],
            revision: -1,
          },
        ],
      }),
    ).toBeNull()
    expect(
      parseHostSettingsDocument({
        writable: true,
        hasDocument: false,
        namespaces: [
          {
            ns: 'locale',
            schema: {},
            value: {},
            applies: 'live',
            secrets: [{ path: [''], set: false }],
            revision: 0,
          },
        ],
      }),
    ).toBeNull()
  })

  it('解析模型目录、推理档位、提供方和默认模型选择', () => {
    expect(
      parseHostModelCatalog({
        groups: [
          {
            id: 'deepseek',
            name: 'DeepSeek',
            models: [
              {
                id: 'deepseek-chat',
                name: 'DeepSeek Chat',
                description: '通用对话模型',
                reasoning: {
                  efforts: [
                    { id: 'high', name: '高' },
                    { id: 'max', name: '最高', description: '最充分推理' },
                  ],
                  defaultEffort: 'high',
                },
              },
            ],
          },
        ],
        failures: [{ id: 'custom', name: '自定义提供方', message: '未配置凭据' }],
      }),
    ).toEqual({
      groups: [
        {
          id: 'deepseek',
          name: 'DeepSeek',
          models: [
            {
              id: 'deepseek-chat',
              name: 'DeepSeek Chat',
              description: '通用对话模型',
              reasoning: {
                efforts: [
                  { id: 'high', name: '高' },
                  { id: 'max', name: '最高', description: '最充分推理' },
                ],
                defaultEffort: 'high',
              },
            },
          ],
        },
      ],
      failures: [{ id: 'custom', name: '自定义提供方', message: '未配置凭据' }],
    })
    expect(
      parseHostModelProviders({
        providers: [
          {
            provider: 'deepseek',
            displayName: 'DeepSeek',
            settingsNs: 'llm-deepseek',
            settingsPath: ['profiles', 'default'],
            active: true,
            declared: true,
          },
        ],
      }),
    ).toEqual([
      {
        provider: 'deepseek',
        displayName: 'DeepSeek',
        settingsNs: 'llm-deepseek',
        settingsPath: ['profiles', 'default'],
        active: true,
        declared: true,
      },
    ])
    expect(
      parseModelSelection({
        provider: 'deepseek',
        model: 'deepseek-chat',
        reasoningEffort: 'high',
      }),
    ).toEqual({ provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' })
    expect(
      parseHostModelCatalog({
        groups: [{ id: 'deepseek', name: 'DeepSeek', models: [{}] }],
        failures: [],
      }),
    ).toBeNull()
    expect(
      parseHostModelProviders({
        providers: [{ provider: 'deepseek', active: true, settingsPath: [] }],
      }),
    ).toBeNull()
    expect(
      parseHostModelProviders({
        providers: [
          {
            provider: 'route-only',
            displayName: '路由展示',
            settingsNs: '',
            settingsPath: [],
            active: false,
          },
        ],
      }),
    ).toEqual([
      {
        provider: 'route-only',
        displayName: '路由展示',
        settingsNs: '',
        settingsPath: [],
        active: false,
      },
    ])
  })

  it('解析 Agent 预设与凭据状态信封', () => {
    expect(
      parseAgentPresetRoster({
        authorable: true,
        hasDocument: true,
        presets: [
          { id: 'standard', trust: 'system', isDefault: true, name: '标准模式' },
          { id: 'review', trust: 'user', isDefault: false, description: '只读审查' },
        ],
      }),
    ).toEqual({
      authorable: true,
      hasDocument: true,
      presets: [
        { id: 'standard', trust: 'system', isDefault: true, name: '标准模式' },
        { id: 'review', trust: 'user', isDefault: false, description: '只读审查' },
      ],
    })
    expect(
      parseCredentialStates({
        credentials: {
          DEEPSEEK_API_KEY: { configured: true, source: 'keychain', writable: true },
          CUSTOM_API_KEY: { configured: false, writable: false },
        },
      }),
    ).toEqual({
      DEEPSEEK_API_KEY: { configured: true, source: 'keychain', writable: true },
      CUSTOM_API_KEY: { configured: false, writable: false },
    })
  })

  it('拒绝伪造的预设与凭据引用', () => {
    expect(
      parseAgentPresetRoster({
        authorable: true,
        hasDocument: true,
        presets: [{ id: 'custom', trust: 'remote', isDefault: false }],
      }),
    ).toBeNull()
    expect(
      parseCredentialStates({
        credentials: { 'bad-reference': { configured: true, writable: true } },
      }),
    ).toBeNull()
  })

  it('综合 ID、名称与自定义地址识别模型厂商官方品牌键', () => {
    expect(resolveProviderBrand('deepseek-official', 'DeepSeek').key).toBe('deepseek')
    expect(resolveProviderBrand('google-gemini', 'Gemini').key).toBe('google')
    expect(
      resolveProviderBrand('my-gateway', '自建网关', 'https://open.bigmodel.cn/api/paas/v4').key,
    ).toBe('zhipu')
    expect(resolveProviderBrand('private-llm', '内部模型', 'https://llm.internal/v1')).toEqual({
      key: 'custom',
      label: '内部模型',
    })
  })

  it('严格校验与构建 llm-pi-ai 模型的思考程度（reasoningEfforts）三态配置', () => {
    expect(validateReasoningEfforts(undefined)).toBeNull()
    expect(validateReasoningEfforts(false)).toBeNull()
    expect(validateReasoningEfforts({ off: null, low: 'low', high: 'high' })).toBeNull()
    expect(validateReasoningEfforts({})).toContain('至少勾选一个非关闭')
    expect(validateReasoningEfforts({ off: null })).toContain('至少勾选一个非关闭')
    expect(validateReasoningEfforts({ low: '  ' })).toContain('参数映射值不能为空')
    expect(validateReasoningEfforts({ turbo: 'turbo' })).toContain('不支持的思考档位')

    expect(formatReasoningSummary(false)).toBe('不启用思考')
    expect(formatReasoningSummary({ low: 'low', medium: 'medium', high: 'high' })).toBe(
      '思考：低 / 中 / 高',
    )
    expect(formatReasoningSummary(undefined)).toBeNull()

    expect(
      parseInitialReasoning({
        id: 'glm-5',
        reasoningEfforts: { off: null, low: 'minimal', high: 'deep' },
        compat: { thinkingFormat: 'zai' },
      }),
    ).toEqual({
      mode: 'custom',
      levels: ['off', 'low', 'high'],
      wireValues: { off: '', low: 'minimal', high: 'deep' },
      thinkingFormat: 'zai',
    })

    const customBuilt = buildValidatedModelDraft({
      baseModel: { id: 'glm-5', extraFlag: true, compat: { supportsDeveloperRole: false } },
      id: 'glm-5',
      name: 'GLM-5',
      contextText: '128K',
      maxTokensText: '8K',
      modalities: ['text', 'image'],
      reasoningMode: 'custom',
      reasoningLevels: ['off', 'low', 'high'],
      wireValues: { off: '', low: 'low', high: 'high' },
      thinkingFormat: 'zai',
      existingIds: [],
      inputField: 'input',
    })
    expect('draft' in customBuilt && customBuilt.draft).toEqual({
      id: 'glm-5',
      name: 'GLM-5',
      contextWindow: 128000,
      maxTokens: 8000,
      input: ['text', 'image'],
      extraFlag: true,
      reasoningEfforts: { off: null, low: 'low', high: 'high' },
      compat: { supportsDeveloperRole: false, thinkingFormat: 'zai' },
    })

    const disabledBuilt = buildValidatedModelDraft({
      baseModel: { id: 'fast-1', reasoningEfforts: { low: 'low' } },
      id: 'fast-1',
      name: '',
      contextText: '',
      maxTokensText: '',
      modalities: undefined,
      reasoningMode: 'disabled',
      reasoningLevels: [],
      wireValues: {},
      thinkingFormat: null,
      existingIds: [],
      inputField: 'input',
    })
    expect('draft' in disabledBuilt && disabledBuilt.draft.reasoningEfforts).toBe(false)

    const deepseekBuilt = buildValidatedModelDraft({
      baseModel: { id: 'deepseek-chat' },
      id: 'deepseek-chat',
      name: '',
      contextText: '',
      maxTokensText: '',
      modalities: undefined,
      reasoningMode: 'custom',
      reasoningLevels: [],
      wireValues: {},
      thinkingFormat: 'deepseek',
      existingIds: [],
      inputField: 'inputModalities',
    })
    expect('draft' in deepseekBuilt && 'reasoningEfforts' in deepseekBuilt.draft).toBe(false)
  })
})
