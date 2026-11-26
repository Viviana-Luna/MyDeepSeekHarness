/**
 * ChatGPT 订阅设置页：管理 OpenAI 官方账号授权、连接状态、可用模型目录和用量入口。
 * 运行在 renderer；轮询和触发操作依赖后台 `chatgpt/*` Remote 契约，组件卸载时中止未完成请求。
 */
import { Button, Modal } from 'antd'
import {
  AlertCircle,
  ArrowUpRight,
  CheckCircle2,
  Clock,
  Cpu,
  ExternalLink,
  LoaderCircle,
  RotateCw,
  ShieldCheck,
  Sparkles,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ChatGPTStatus } from '../../../../../packages/llm/llm-chatgpt/types.d.ts'
import { callRemote } from '../../plugins/sdk.ts'
import { SettingsSection, StatusDot } from './SettingsPrimitives.tsx'

const USAGE_URL = 'https://chatgpt.com/settings/usage'
const PRIVACY_URL = 'https://openai.com/policies/privacy-policy/'
const TERMS_URL = 'https://openai.com/policies/sign-in-with-chatgpt-terms/'

type ChatGPTAction = 'connect' | 'refresh' | 'disconnect' | 'forget' | 'acknowledgePlanUse'

interface ConnectionVisualState {
  readonly dot: 'positive' | 'warning' | 'neutral'
  readonly badge: string
  readonly title: string
  readonly summary: string
  readonly tone: 'connected' | 'pending' | 'idle'
}

function describeConnectionState(
  status: ChatGPTStatus | null,
  waiting: boolean,
): ConnectionVisualState {
  if (status === null) {
    return {
      dot: 'neutral',
      badge: '读取中',
      title: '正在核对连接状态…',
      summary: '正在从本机私有凭据与订阅服务读取当前授权情况。',
      tone: 'idle',
    }
  }
  if (waiting) {
    return {
      dot: 'warning',
      badge: '等待授权',
      title: status.account ? `等待授权 · ${status.account}` : '请在浏览器中完成授权',
      summary: '请在打开的 OpenAI 登录页面确认授权应用为 MyDSH，完成后会自动回到本机。',
      tone: 'pending',
    }
  }
  if (status.connected) {
    return {
      dot: 'positive',
      badge: '已连接',
      title: status.account ? `已连接 · ${status.account}` : '已连接 ChatGPT 订阅',
      summary: '访问令牌安全保存在本机 MyDSH 私有凭据文件中，可在模型选择器中切换订阅模型。',
      tone: 'connected',
    }
  }
  if (status.registered) {
    const title =
      status.account === null ? '应用注册已保存，登录待完成' : `已保存账号注册 · ${status.account}`
    return {
      dot: 'warning',
      badge: status.account !== null && !status.planEnabled ? '待授权订阅' : '待完成登录',
      title,
      summary: '访问令牌保存在本机 MyDSH 私有凭据文件中。关闭此页会取消尚未完成的授权。',
      tone: 'pending',
    }
  }
  return {
    dot: 'neutral',
    badge: '未连接',
    title: '尚未连接 ChatGPT 订阅',
    summary: '通过 OpenAI 官方登录流程授权 MyDSH 使用你的 ChatGPT 订阅额度。',
    tone: 'idle',
  }
}

function ChatGPTPlanNoticeModal({
  open,
  busy,
  onAcknowledge,
}: {
  readonly open: boolean
  readonly busy: boolean
  onAcknowledge(): void
}) {
  return (
    <Modal
      open={open}
      centered
      classNames={{
        container: 'mydsh-glass-dialog',
        mask: 'mydsh-glass-mask',
      }}
      title="正在使用 ChatGPT 订阅"
      okText="知道了"
      cancelButtonProps={{ style: { display: 'none' } }}
      confirmLoading={busy}
      onOk={onAcknowledge}
      onCancel={onAcknowledge}
    >
      <div className="chatgpt-notice-modal">
        <p>
          MyDSH 中符合条件的模型请求会使用你的 ChatGPT
          订阅额度。对话中的工具结果和摘要请求也可能计入用量。
        </p>
        <p>你可以在 ChatGPT 中查看 MyDSH 的用量、调整应用限额或撤销访问。</p>
        <a className="chatgpt-link-pill" href={USAGE_URL} target="_blank" rel="noreferrer">
          <span>管理 ChatGPT 用量</span>
          <ArrowUpRight size={13} aria-hidden="true" />
        </a>
      </div>
    </Modal>
  )
}

function ChatGPTConnectionCard({
  status,
  busy,
  waiting,
  error,
  onAct,
  onCancel,
}: {
  readonly status: ChatGPTStatus | null
  readonly busy: boolean
  readonly waiting: boolean
  readonly error: string | null
  onAct(method: ChatGPTAction): void
  onCancel(): void
}) {
  const visual = describeConnectionState(status, waiting)
  const needsPlanAuthorization =
    status !== null && status.registered && status.account !== null && !status.planEnabled
  const primaryLabel = needsPlanAuthorization ? '授权订阅用量' : '继续使用 ChatGPT'
  const showAuthLink = Boolean(
    status?.authorizationUrl?.startsWith('https://auth.openai.com/api/accounts/authorize?'),
  )
  const errorText = error ?? status?.message ?? null

  return (
    <SettingsSection
      title="账号连接"
      description="通过 OpenAI 官方登录流程，授权 MyDSH 使用你的 ChatGPT 订阅。"
    >
      <div className="chatgpt-hero-card" data-tone={visual.tone}>
        <div className="chatgpt-status-header">
          <div className="chatgpt-status-emblem" data-tone={visual.tone} aria-hidden="true">
            {visual.tone === 'connected' ? (
              <CheckCircle2 size={20} />
            ) : visual.tone === 'pending' ? (
              <Clock size={20} />
            ) : (
              <Sparkles size={20} />
            )}
          </div>
          <div className="chatgpt-status-copy">
            <div className="chatgpt-status-title-row">
              <strong>{visual.title}</strong>
              <span
                className="settings-state-label"
                data-state={
                  visual.dot === 'positive'
                    ? 'positive'
                    : visual.dot === 'warning'
                      ? 'warning'
                      : undefined
                }
              >
                <StatusDot state={visual.dot} />
                {visual.badge}
              </span>
            </div>
            <p>{visual.summary}</p>
          </div>
          {status !== null && (
            <div className="chatgpt-status-actions">
              <Button
                type="primary"
                disabled={busy || waiting}
                loading={busy && !waiting}
                onClick={() => {
                  onAct('connect')
                }}
              >
                {primaryLabel}
              </Button>
              {status.registered && !status.connected && (
                <Button
                  disabled={busy || waiting}
                  onClick={() => {
                    onAct('forget')
                  }}
                >
                  移除本机账号注册
                </Button>
              )}
              {status.connected && (
                <Button
                  disabled={busy || waiting}
                  onClick={() => {
                    onAct('disconnect')
                  }}
                >
                  断开连接
                </Button>
              )}
            </div>
          )}
        </div>

        {waiting && (
          <div className="chatgpt-banner" data-tone="neutral" role="status">
            <div className="chatgpt-banner__head">
              <LoaderCircle size={15} className="spin" aria-hidden="true" />
              <strong>在浏览器中完成授权</strong>
            </div>
            <p>请确认授权的应用是 MyDSH。完成后会自动返回本机，等待超过 10 分钟需重新连接。</p>
            <div className="chatgpt-banner__actions">
              {showAuthLink && status?.authorizationUrl && (
                <a
                  className="chatgpt-link-pill chatgpt-link-pill--accent"
                  href={status.authorizationUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  <span>打开 ChatGPT 授权页面</span>
                  <ExternalLink size={13} aria-hidden="true" />
                </a>
              )}
              <Button size="small" onClick={onCancel}>
                取消授权
              </Button>
            </div>
          </div>
        )}

        {needsPlanAuthorization && (
          <div className="chatgpt-banner" data-tone="warning" role="status">
            <div className="chatgpt-banner__head">
              <Clock size={15} aria-hidden="true" />
              <strong>尚未授权使用订阅</strong>
            </div>
            <p>
              账号身份已保存。点击“授权订阅用量”，在浏览器中允许 MyDSH 使用你的 ChatGPT
              订阅后才能调用模型。
            </p>
          </div>
        )}

        {errorText !== null && (
          <div className="chatgpt-banner" data-tone="error" role="alert">
            <div className="chatgpt-banner__head">
              <AlertCircle size={15} aria-hidden="true" />
              <strong>连接提示</strong>
            </div>
            <p>{errorText}</p>
          </div>
        )}

        <div className="chatgpt-privacy-footer">
          <div className="chatgpt-privacy-copy">
            <ShieldCheck size={15} aria-hidden="true" />
            <p>
              登录后，MyDSH
              在本机保存账号标识和授权令牌，用于连接与续期。你发送的内容，以及当前任务需要的项目指令、历史和工具结果，会随请求发送给
              OpenAI。MyDSH 不上传授权令牌到自己的服务器；登录本身不会启动模型任务。
            </p>
          </div>
          <div className="chatgpt-policy-links">
            <a className="chatgpt-link-pill" href={PRIVACY_URL} target="_blank" rel="noreferrer">
              <span>OpenAI 隐私政策</span>
              <ArrowUpRight size={12} aria-hidden="true" />
            </a>
            <a className="chatgpt-link-pill" href={TERMS_URL} target="_blank" rel="noreferrer">
              <span>订阅接入条款</span>
              <ArrowUpRight size={12} aria-hidden="true" />
            </a>
          </div>
        </div>
      </div>
    </SettingsSection>
  )
}

function ChatGPTModelsSection({
  models,
  busy,
  waiting,
  onRefresh,
}: {
  readonly models: ChatGPTStatus['models']
  readonly busy: boolean
  readonly waiting: boolean
  onRefresh(): void
}) {
  return (
    <section className="settings-section">
      <header className="settings-section__header-row">
        <div className="settings-section__header">
          <h3>账号模型</h3>
          <p>
            目录来自当前账号；连接后可在通用模型选择器中选择。支持文本与工具调用；图片输入仅对目录明确支持图片的模型开放。
          </p>
        </div>
        <Button
          size="small"
          icon={<RotateCw size={13} aria-hidden="true" />}
          disabled={busy || waiting}
          onClick={onRefresh}
        >
          刷新模型目录
        </Button>
      </header>
      <div className="chatgpt-model-card">
        {models.length === 0 ? (
          <div className="chatgpt-model-empty" role="status">
            <Cpu size={18} aria-hidden="true" />
            <span>暂无可用模型</span>
          </div>
        ) : (
          <ul className="chatgpt-model-list" aria-label="ChatGPT 可用模型目录">
            {models.map(model => (
              <li key={model.id} className="chatgpt-model-row">
                <div className="chatgpt-model-identity">
                  <strong>{model.name}</strong>
                  <code>{model.id}</code>
                </div>
                <div className="chatgpt-model-badges">
                  <span className="chatgpt-meta-chip">
                    上下文 {model.contextWindow.toLocaleString()} Token
                  </span>
                  <span className="chatgpt-meta-chip">
                    {model.reasoningEfforts.length > 0
                      ? model.reasoningEfforts.join(' / ')
                      : '模型默认推理'}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}

/**
 * ChatGPT 订阅账号连接、授权、可用模型与用量管理页面。
 * 支持独立展示或以 `embedded` 模式嵌入插件管理详情页（隐藏重复标题并去除外层留白）。
 */
export function ChatGPTSettings({ embedded = false }: { readonly embedded?: boolean } = {}) {
  const [status, setStatus] = useState<ChatGPTStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const lifetime = useRef<AbortController | null>(null)
  const connecting = useRef<AbortController | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    let timer: ReturnType<typeof setTimeout>
    const read = async () => {
      try {
        const value = (await callRemote('chatgpt/status', {}, controller.signal)) as ChatGPTStatus
        if (!controller.signal.aborted) setStatus(value)
      } catch {
        if (!controller.signal.aborted) setError('无法读取 ChatGPT 连接状态，请重新打开设置')
      } finally {
        if (!controller.signal.aborted) {
          timer = setTimeout(() => {
            void read()
          }, 1000)
        }
      }
    }
    void read()
    return () => {
      controller.abort()
      connecting.current?.abort()
      clearTimeout(timer)
    }
  }, [])

  const act = async (method: ChatGPTAction) => {
    const signal = lifetime.current?.signal
    if (!signal || signal.aborted) return
    const controller = new AbortController()
    if (method === 'connect') connecting.current = controller
    setBusy(true)
    setError(null)
    try {
      const value = (await callRemote(
        `chatgpt/${method}`,
        {},
        AbortSignal.any([signal, controller.signal]),
      )) as ChatGPTStatus
      if (!signal.aborted) setStatus(value)
    } catch {
      if (!signal.aborted && !controller.signal.aborted)
        setError('ChatGPT 操作未完成，请检查连接后重试')
    } finally {
      if (connecting.current === controller) connecting.current = null
      if (!signal.aborted) setBusy(false)
    }
  }

  const cancel = () => {
    connecting.current?.abort()
    void callRemote('chatgpt/cancel', {}, lifetime.current?.signal).catch(() => undefined)
  }

  const waiting = Boolean(status?.connecting) || connecting.current !== null

  return (
    <div
      className={embedded ? 'settings-page chatgpt-settings--embedded' : 'settings-page'}
      data-chatgpt-settings
    >
      <ChatGPTPlanNoticeModal
        open={status?.needsPlanNotice === true && !waiting}
        busy={busy}
        onAcknowledge={() => {
          void act('acknowledgePlanUse')
        }}
      />

      {!embedded && (
        <header className="settings-page__heading">
          <h2>ChatGPT 订阅</h2>
          <p>连接 ChatGPT 账号，使用订阅可用的 GPT 模型。</p>
        </header>
      )}

      <ChatGPTConnectionCard
        status={status}
        busy={busy}
        waiting={waiting}
        error={error}
        onAct={method => {
          void act(method)
        }}
        onCancel={cancel}
      />

      {status?.connected && (
        <ChatGPTModelsSection
          models={status.models}
          busy={busy}
          waiting={waiting}
          onRefresh={() => {
            void act('refresh')
          }}
        />
      )}

      <SettingsSection
        title="订阅用量"
        description="用量和应用限额由 ChatGPT 管理。断开连接会撤销当前登录并清除本机令牌，保留注册信息以便下次登录。"
      >
        <div className="chatgpt-usage-card">
          <div className="chatgpt-usage-copy">
            <strong>ChatGPT 用量与授权管理</strong>
            <small>在 OpenAI 账号页查看应用限额、使用记录，或随时撤销 MyDSH 的访问授权。</small>
          </div>
          <a
            className="chatgpt-link-pill chatgpt-link-pill--button"
            href={USAGE_URL}
            target="_blank"
            rel="noreferrer"
          >
            <span>管理 ChatGPT 用量与 MyDSH 访问权限</span>
            <ArrowUpRight size={13} aria-hidden="true" />
          </a>
        </div>
      </SettingsSection>
    </div>
  )
}
