/**
 * SSH 连接「Agent 权限」配置标签页：运行在 renderer，提供模型开放开关、三档权限、sudo 策略与路径白名单编辑。
 * 纯受控配置表单组件，不接触凭据密文或网络连接。
 */
import { Alert, Button, Input, Switch } from 'antd'
import { Plus, ShieldCheck, Trash2 } from 'lucide-react'
import type {
  SshAgentAccess,
  SshAgentAccessMode,
} from '../../../../../packages/connections/ssh/types.d.ts'

const MODE_OPTIONS: readonly {
  mode: SshAgentAccessMode
  label: string
  short: string
  description: string
}[] = [
  {
    mode: 'readonly',
    label: '只读',
    short: '只读',
    description: '允许浏览目录、读取文本与只读巡检命令，禁止写入和变更。',
  },
  {
    mode: 'standard',
    label: '常规运维',
    short: '运维',
    description: '允许编辑远端文件与常见运维命令，非只读操作需经确认卡批准。',
  },
  {
    mode: 'full',
    label: '完整访问',
    short: '完整',
    description: '允许系统级管理命令；高危操作、删除与 sudo 仍强制每次单次确认。',
  },
]

/** 生成默认 SSH 模型访问策略：默认关闭，开启后默认只读且禁止 sudo。 */
export function createDefaultSshAgentAccess(): SshAgentAccess {
  return {
    enabled: false,
    mode: 'readonly',
    allowSudo: false,
    allowedPaths: [],
  }
}

/** 深拷贝已有 SSH 模型访问策略；旧连接缺失时回退为默认关闭策略。 */
export function cloneSshAgentAccess(source?: SshAgentAccess): SshAgentAccess {
  if (!source) return createDefaultSshAgentAccess()
  return {
    enabled: source.enabled,
    mode: source.mode,
    allowSudo: source.allowSudo,
    allowedPaths: [...source.allowedPaths],
  }
}

function hasControlChar(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code < 32 || code === 127) return true
  }
  return false
}

/** 保存前校验路径白名单格式与重复项，返回中文错误提示或 null。 */
export function validateSshAgentAccessDraft(access: SshAgentAccess): string | null {
  if (access.allowedPaths.length > 50) return '允许访问路径最多配置 50 条'
  const seen = new Set<string>()
  for (const [index, raw] of access.allowedPaths.entries()) {
    const path = raw.trim()
    if (!path) return `第 ${index + 1} 条允许访问路径不能为空`
    if (!path.startsWith('/'))
      return `第 ${index + 1} 条路径「${path}」必须是以 / 开头的 POSIX 绝对路径`
    if (path.length > 512 || hasControlChar(path))
      return `第 ${index + 1} 条路径格式无效或超过 512 字符上限`
    const normalized = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
    if (seen.has(normalized)) return `允许访问路径存在重复项：${normalized}`
    seen.add(normalized)
  }
  return null
}

/** 清理路径前后空白并去尾斜杠，供保存提交前规范化使用。 */
export function sanitizeSshAgentAccess(access: SshAgentAccess): SshAgentAccess {
  return {
    enabled: access.enabled,
    mode: access.mode,
    allowSudo: access.allowSudo,
    allowedPaths: access.allowedPaths.map(raw => {
      const trimmed = raw.trim()
      return trimmed.length > 1 && trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed
    }),
  }
}

/** 生成用于提示与标题悬停的完整模型权限摘要文案。 */
export function formatSshAgentAccessSummary(access?: SshAgentAccess): string {
  if (!access?.enabled) return '模型访问已关闭'
  const mode = MODE_OPTIONS.find(item => item.mode === access.mode)?.label ?? '只读'
  const extras: string[] = []
  if (access.allowSudo) extras.push('允许 sudo')
  if (access.allowedPaths.length > 0) extras.push(`路径限制 ${access.allowedPaths.length} 条`)
  return extras.length > 0 ? `模型已开放 · ${mode} · ${extras.join(' · ')}` : `模型已开放 · ${mode}`
}

/** 生成用于主机卡片与终端头部的紧凑权限徽标文案；未开放时返回 null。 */
export function formatSshAgentBadge(access?: SshAgentAccess): string | null {
  if (!access?.enabled) return null
  const short = MODE_OPTIONS.find(item => item.mode === access.mode)?.short ?? '只读'
  return `AI · ${short}`
}

/** 「Agent 权限」标签页组件的参数契约。 */
export interface SshAgentAccessTabProps {
  value: SshAgentAccess
  fingerprint: string | null
  onChange(next: SshAgentAccess): void
}

/** 渲染 SSH 连接的模型访问权限、sudo 策略与远端目录白名单配置区。 */
export function SshAgentAccessTab({ value, fingerprint, onChange }: SshAgentAccessTabProps) {
  const addPath = () => {
    if (value.allowedPaths.length >= 50) return
    onChange({ ...value, allowedPaths: [...value.allowedPaths, ''] })
  }

  const updatePath = (index: number, nextPath: string) => {
    onChange({
      ...value,
      allowedPaths: value.allowedPaths.map((item, idx) => (idx === index ? nextPath : item)),
    })
  }

  const removePath = (index: number) => {
    onChange({
      ...value,
      allowedPaths: value.allowedPaths.filter((_, idx) => idx !== index),
    })
  }

  return (
    <div className="database-agent-tab ssh-agent-tab">
      <div className="database-agent-switch-row">
        <div>
          <div className="database-agent-title">
            <ShieldCheck size={15} aria-hidden="true" />
            <span>向模型开放此连接</span>
          </div>
          <p className="database-agent-hint">
            关闭后模型不会发现或访问该主机。开启后，纯只读巡检自动放行，写入文件与变更命令均会弹出确认卡。
          </p>
        </div>
        <Switch
          aria-label="向模型开放此连接"
          checked={value.enabled}
          onChange={enabled => onChange({ ...value, enabled })}
        />
      </div>

      {value.enabled && !fingerprint && (
        <Alert
          type="warning"
          showIcon
          title="尚未确认主机指纹"
          description="保存后请先手动测试或打开一次终端以核对 SSH 主机指纹；完成指纹信任后模型才能接入该主机。"
        />
      )}

      {value.enabled && (
        <>
          <section className="database-agent-section" aria-label="SSH Agent 权限档位">
            <div className="database-agent-section-head">
              <div>
                <strong>连接权限档位</strong>
                <p className="database-agent-hint">
                  档位决定默认操作范围；超出档位时模型只能经确认卡申请临时提权，毁灭性系统破坏命令始终硬拦截。
                </p>
              </div>
            </div>
            <div className="database-agent-mode-grid" role="group" aria-label="SSH Agent 权限档位">
              {MODE_OPTIONS.map(option => (
                <button
                  key={option.mode}
                  type="button"
                  aria-pressed={value.mode === option.mode}
                  data-ssh-agent-mode={option.mode}
                  className="database-agent-mode"
                  onClick={() => onChange({ ...value, mode: option.mode })}
                >
                  <strong>{option.label}</strong>
                  <span>{option.description}</span>
                </button>
              ))}
            </div>
            {value.mode === 'full' && (
              <p className="database-agent-warning">
                完整访问允许模型申请执行防火墙、账号或系统级管理命令，建议为 Agent
                配置最小权限专用账号。
              </p>
            )}
          </section>

          <div className="database-agent-switch-row">
            <div>
              <div className="database-agent-title">
                <span>允许 sudo 提权命令</span>
              </div>
              <p className="database-agent-hint">
                默认关闭。即使开启，每条包含 sudo 的命令也强制单次人工确认，不会记住会话放行。
              </p>
            </div>
            <Switch
              aria-label="允许 sudo 提权命令"
              checked={value.allowSudo}
              onChange={allowSudo => onChange({ ...value, allowSudo })}
            />
          </div>

          <section className="database-agent-section" aria-label="允许访问路径">
            <div className="database-agent-section-head">
              <div>
                <strong>允许访问路径（{value.allowedPaths.length}/50）</strong>
                <p className="database-agent-hint">
                  限制 SFTP 文件浏览、读写与命令工作目录的远端绝对路径（如
                  /srv/app）。留空则沿用登录用户自身权限。
                </p>
              </div>
              <Button
                size="small"
                icon={<Plus size={14} />}
                disabled={value.allowedPaths.length >= 50}
                onClick={addPath}
              >
                添加路径
              </Button>
            </div>
            {value.allowedPaths.length === 0 ? (
              <div className="database-agent-empty">
                未配置路径白名单，遵循该 SSH 账号的系统目录权限。
              </div>
            ) : (
              <div className="database-agent-rule-list">
                {value.allowedPaths.map((pathValue, index) => (
                  <div
                    key={index}
                    className="ssh-agent-path-row"
                    role="group"
                    aria-label={`允许路径 ${index + 1}`}
                  >
                    <Input
                      size="small"
                      value={pathValue}
                      maxLength={512}
                      placeholder="/srv/app"
                      aria-label={`允许访问路径 ${index + 1}`}
                      spellCheck={false}
                      onChange={event => updatePath(index, event.target.value)}
                    />
                    <Button
                      size="small"
                      type="text"
                      danger
                      aria-label={`删除允许路径 ${index + 1}`}
                      icon={<Trash2 size={14} />}
                      onClick={() => removePath(index)}
                    />
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  )
}
