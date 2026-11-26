/**
 * 内置插件配置表单：为插件管理页中的内置插件提供参数编辑、Subagent 模型授权与共享凭据配置。
 * 运行在 renderer；草稿状态仅存在于当前组件实例内，后台设置刷新时保留尚未保存的用户编辑。
 */
import { Button, Checkbox, Input, InputNumber, Modal, Switch, Tooltip } from 'antd'
import { AlertTriangle, KeyRound, RotateCcw, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { isRecord } from '../../../../shared/validation.ts'
import type { SettingsPageProps } from '../../plugins/registry.ts'
import {
  namespaceOf,
  type HostSettingsNamespace,
  type HostSettingsPathOperation,
} from './settings-model.ts'
import { CapabilityNotice, StatusDot } from './SettingsPrimitives.tsx'
import './general-presets.css'

/** 随应用提供的内置插件配置清单，定义命名空间、展示文案与可编辑字段约束。 */
export const PLUGIN_CONFIGURATIONS = [
  {
    ns: 'shell',
    title: '终端',
    description: '限制 Agent 运行的每一条命令。',
    fields: [
      ['timeoutMs', '命令超时（毫秒）', '单条命令允许运行多久，超时即终止。', 1],
      ['maxOutputBytes', '单流输出上限（字节）', '超出部分会转存到临时文件。', 1],
    ],
  },
  {
    ns: 'agent-loop',
    title: 'Agent 循环',
    description: 'Agent 如何派发工具调用。',
    fields: [
      ['maxParallelToolCalls', '并行工具调用数', '同一步内最多同时运行多少个可并行的调用。', 1],
    ],
  },
  {
    ns: 'subagent',
    title: '子智能体',
    description: '设置 Subagent 的递归层级、数量和模型。',
    fields: [
      ['maxDepth', '最大递归深度', '0 表示禁用；1 表示仅主 Agent 可以创建 Subagent。', 0],
      [
        'maxActiveSubagents',
        'Subagent 并行数量上限',
        '同一主 Agent 下同时存活的 Subagent 总数。',
        1,
      ],
    ],
  },
  {
    ns: 'web-search-deepseek',
    title: '网页搜索',
    description: 'DeepSeek 搜索提供方。',
    fields: [
      ['baseURL', '接口地址', '留空则使用提供方默认地址。', 'text'],
      ['maxUses', '单次请求最多搜索次数', '一次请求在必须作答前最多可以搜索多少次。', 1],
    ],
  },
] as const

function parseAllowedModels(namespace: HostSettingsNamespace | undefined): string[] {
  if (!Array.isArray(namespace?.value.allowedModels)) return []
  return namespace.value.allowedModels
    .filter(isRecord)
    .map(row => JSON.stringify([row.provider, row.model]))
}

function ConfigField({
  namespace,
  field,
  disabled,
  mutate,
}: {
  readonly namespace: HostSettingsNamespace
  readonly field: readonly [string, string, string, number | 'text']
  readonly disabled: boolean
  readonly mutate: SettingsPageProps['mutate']
}) {
  const [key, label, help, minimum] = field
  const value = namespace.value[key]
  const savedText = value === undefined || value === null ? '' : String(value)
  const [draft, setDraft] = useState(savedText)
  const previous = useRef(savedText)

  // 后台设置事件刷新时，仅当草稿与上次已保存值一致才同步，避免覆盖用户未保存的编辑。
  useEffect(() => {
    setDraft(current => (current === previous.current ? savedText : current))
    previous.current = savedText
  }, [savedText])

  const inputId = `plugin-${namespace.ns}-${key}`
  const overridden = Object.hasOwn(namespace.user ?? {}, key)
  const hasChanges = draft !== savedText
  const isText = minimum === 'text'
  const parsedNumber = !isText && draft.trim() !== '' ? Number(draft) : null
  const isNumberValid =
    isText || parsedNumber === null || (Number.isFinite(parsedNumber) && parsedNumber >= minimum)

  const submitField = () => {
    if (disabled || !hasChanges || !isNumberValid) return
    const operation: HostSettingsPathOperation =
      draft.trim() === ''
        ? { op: 'unset', path: [key] }
        : {
            op: 'set',
            path: [key],
            value: isText ? draft.trim() : Number(draft),
          }
    void mutate(namespace.ns, [operation], `plugin:${namespace.ns}:${key}`)
  }

  return (
    <form
      className="settings-plugin-field gp-plugin-field"
      onSubmit={event => {
        event.preventDefault()
        submitField()
      }}
    >
      <label htmlFor={inputId}>
        <strong>
          <span>{label}</span>
          {overridden && <span className="gp-plugin-override-badge">已自定义</span>}
        </strong>
        <small>{help}</small>
      </label>
      <div className="settings-plugin-field__control gp-plugin-field__control">
        {isText ? (
          <Input
            id={inputId}
            type="url"
            value={draft}
            placeholder="使用默认值"
            disabled={disabled}
            allowClear={!disabled}
            onChange={event => {
              setDraft(event.target.value)
            }}
          />
        ) : (
          <InputNumber
            id={inputId}
            className="gp-plugin-number-input"
            min={minimum}
            step={1}
            precision={0}
            value={parsedNumber !== null && Number.isFinite(parsedNumber) ? parsedNumber : null}
            placeholder="使用默认值"
            disabled={disabled}
            onChange={next => {
              setDraft(next === null ? '' : String(next))
            }}
          />
        )}
        <Button
          type={hasChanges ? 'primary' : 'default'}
          htmlType="submit"
          disabled={disabled || !hasChanges || !isNumberValid}
        >
          保存
        </Button>
        {overridden && (
          <Tooltip title="恢复默认值">
            <Button
              type="text"
              className="gp-plugin-reset-btn"
              aria-label={`恢复 ${label} 默认值`}
              disabled={disabled}
              icon={<RotateCcw size={14} aria-hidden="true" />}
              onClick={() => {
                void mutate(namespace.ns, [{ op: 'unset', path: [key] }])
              }}
            />
          </Tooltip>
        )}
      </div>
    </form>
  )
}

function SubagentModels({ state, mutate }: SettingsPageProps) {
  const namespace = namespaceOf(state.document, 'subagent-model-selection')
  const [enabled, setEnabled] = useState(namespace?.value.enabled === true)
  const [allowed, setAllowed] = useState<string[]>(() => parseAllowedModels(namespace))
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    if (!dirty) {
      setEnabled(namespace?.value.enabled === true)
      setAllowed(parseAllowedModels(namespace))
    }
  }, [namespace, dirty])

  if (!namespace) {
    return (
      <CapabilityNotice title="模型授权暂不可用">
        运行核心尚未加载 Subagent 模型授权配置。
      </CapabilityNotice>
    )
  }

  const choices: { value: string; label: string; unavailable: boolean }[] = (
    state.modelCatalog?.groups ?? []
  ).flatMap(group =>
    group.models.map(model => ({
      value: JSON.stringify([group.id, model.id]),
      label: `${group.name} / ${model.name}`,
      unavailable: false,
    })),
  )
  for (const value of allowed) {
    if (!choices.some(choice => choice.value === value)) {
      choices.push({
        value,
        label: (JSON.parse(value) as string[]).join(' / '),
        unavailable: true,
      })
    }
  }

  const disabled = !state.document?.writable || state.saving !== null
  const missingSelection = enabled && allowed.length === 0

  return (
    <section className="gp-plugin-card" aria-label="Subagent 模型授权">
      <div className="gp-subagent-header">
        <div className="gp-subagent-header__copy">
          <strong>允许 Agent 为 Subagent 选择模型</strong>
          <small>
            {enabled
              ? '从授权模型中选择提供方、模型和推理强度，仅影响新会话。'
              : '使用默认模型或继承父 Agent 的模型；已选模型会保留。'}
          </small>
        </div>
        <Switch
          aria-label="允许 Agent 为 Subagent 选择模型"
          checked={enabled}
          disabled={disabled}
          onChange={checked => {
            setEnabled(checked)
            setDirty(true)
          }}
        />
      </div>

      {enabled && (
        <div className="gp-subagent-list-wrap">
          {choices.length === 0 ? (
            <p className="gp-subagent-empty">
              暂无可选择的模型，请先在「模型」设置中配置模型服务。
            </p>
          ) : (
            <div className="settings-model-permissions gp-subagent-list">
              {choices.map(choice => (
                <label className="gp-subagent-option" key={choice.value}>
                  <Checkbox
                    disabled={disabled}
                    checked={allowed.includes(choice.value)}
                    onChange={event => {
                      const nextChecked = event.target.checked
                      setAllowed(current =>
                        nextChecked
                          ? [...current, choice.value]
                          : current.filter(value => value !== choice.value),
                      )
                      setDirty(true)
                    }}
                  >
                    <span className="gp-subagent-option__label">{choice.label}</span>
                  </Checkbox>
                  {choice.unavailable && (
                    <span className="gp-plugin-override-badge">当前不可用</span>
                  )}
                </label>
              ))}
            </div>
          )}
          {missingSelection && (
            <p className="settings-inline-error" role="alert">
              请至少选择一个模型。
            </p>
          )}
        </div>
      )}

      <div className="gp-plugin-card__footer">
        <Button
          type={dirty ? 'primary' : 'default'}
          disabled={disabled || !dirty || missingSelection}
          loading={state.saving === 'subagent-models'}
          onClick={() => {
            void mutate(
              namespace.ns,
              [
                { op: 'set', path: ['enabled'], value: enabled },
                {
                  op: 'set',
                  path: ['allowedModels'],
                  value: allowed.map(value => {
                    const [provider, model] = JSON.parse(value) as string[]
                    return { provider, model }
                  }),
                },
              ],
              'subagent-models',
            ).then(ok => {
              if (ok) setDirty(false)
            })
          }}
        >
          保存模型授权
        </Button>
      </div>
    </section>
  )
}

function SearchCredential({ state, setCredential, unsetCredential }: SettingsPageProps) {
  const namespace = namespaceOf(state.document, 'web-search-deepseek')
  const reference =
    typeof namespace?.value.apiKeyEnv === 'string' ? namespace.value.apiKeyEnv : 'DEEPSEEK_API_KEY'
  const credential = state.credentials[reference]
  const [draft, setDraft] = useState('')
  const [removeOpen, setRemoveOpen] = useState(false)
  const disabled =
    !state.document?.writable || state.saving !== null || credential?.writable === false
  const configured = credential?.configured === true

  return (
    <section className="gp-plugin-card settings-search-credential" aria-label="网页搜索密钥">
      <div className="gp-credential-head">
        <div className="gp-credential-identity">
          <span className="gp-credential-icon" aria-hidden="true">
            <KeyRound size={15} />
          </span>
          <div className="gp-credential-title-group">
            <strong>API Key</strong>
            <span
              className="settings-state-label gp-credential-status"
              data-state={configured ? 'positive' : undefined}
            >
              <StatusDot state={configured ? 'positive' : 'neutral'} />
              {configured ? '已配置' : '未配置'}
            </span>
          </div>
        </div>
        {configured && (
          <Button
            type="text"
            size="small"
            danger
            icon={<Trash2 size={13} aria-hidden="true" />}
            disabled={disabled}
            onClick={() => {
              setRemoveOpen(true)
            }}
          >
            移除密钥
          </Button>
        )}
      </div>

      <form
        className="settings-plugin-field gp-plugin-field gp-plugin-field--credential"
        onSubmit={event => {
          event.preventDefault()
          if (disabled || !draft.trim()) return
          void setCredential(reference, draft.trim()).then(ok => {
            if (ok) setDraft('')
          })
        }}
      >
        <label htmlFor="web-search-api-key">
          <strong>{reference}</strong>
          <small>
            {configured ? '已保存，留空保留当前密钥。' : '配置后即可使用网页搜索。'}
            与使用同一密钥的 DeepSeek 提供方共用。
          </small>
        </label>
        <div className="settings-plugin-field__control gp-plugin-field__control">
          <Input.Password
            id="web-search-api-key"
            autoComplete="off"
            spellCheck={false}
            placeholder={configured ? '输入新密钥以替换' : '输入 DeepSeek API Key'}
            disabled={disabled}
            value={draft}
            onChange={event => {
              setDraft(event.target.value)
            }}
          />
          <Button
            type={draft.trim() ? 'primary' : 'default'}
            disabled={disabled || !draft.trim()}
            htmlType="submit"
          >
            保存
          </Button>
        </div>
      </form>

      <Modal
        open={removeOpen}
        centered
        destroyOnHidden
        width="min(440px, calc(100vw - 32px))"
        classNames={{
          container: 'mydsh-glass-dialog',
          mask: 'mydsh-glass-mask',
        }}
        focusable={{ trap: true, focusTriggerAfterClose: true }}
        title={
          <span className="gp-modal-danger-title">
            <AlertTriangle size={18} aria-hidden="true" />
            <span>移除共用密钥？</span>
          </span>
        }
        okText="确认移除"
        cancelText="取消"
        okButtonProps={{ danger: true, disabled }}
        cancelButtonProps={{ disabled: state.saving !== null }}
        confirmLoading={state.saving !== null}
        onCancel={() => {
          if (state.saving === null) setRemoveOpen(false)
        }}
        onOk={() => {
          void unsetCredential(reference).then(ok => {
            if (ok) setRemoveOpen(false)
          })
        }}
      >
        <div className="gp-danger-modal-body">
          <p>
            将移除共用的密钥（<code className="gp-inline-code">{reference}</code>
            ），使用它的 DeepSeek 模型服务和网页搜索都需要重新配置。
          </p>
        </div>
      </Modal>
    </section>
  )
}

/** 渲染单个内置插件的参数、模型授权与凭据表单；字段草稿只随当前配置页存在。 */
export function PluginConfigurationFields({ id, ...props }: SettingsPageProps & { id: string }) {
  const card = PLUGIN_CONFIGURATIONS.find(item => item.ns === id)
  if (!card) return null
  const namespace = namespaceOf(props.state.document, card.ns)
  const disabled = !props.state.document?.writable || props.state.saving !== null

  return (
    <div className="plugin-configuration-fields gp-plugin-config" data-namespace={id}>
      {!namespace ? (
        <CapabilityNotice title="配置暂不可用">运行核心尚未加载此配置。</CapabilityNotice>
      ) : (
        <>
          {props.state.document?.writable === false && (
            <CapabilityNotice title="当前配置为只读">
              运行时配置文档当前不可写入，仅可查看已有参数。
            </CapabilityNotice>
          )}
          {card.ns === 'web-search-deepseek' && <SearchCredential {...props} />}
          <section className="gp-plugin-card" aria-label={`${card.title}参数设置`}>
            {card.fields.map(field => (
              <ConfigField
                key={field[0]}
                namespace={namespace}
                field={field}
                disabled={disabled}
                mutate={props.mutate}
              />
            ))}
          </section>
          {card.ns === 'subagent' && <SubagentModels {...props} />}
        </>
      )}
    </div>
  )
}
