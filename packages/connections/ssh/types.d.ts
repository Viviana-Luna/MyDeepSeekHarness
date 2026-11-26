/** 连接页公开事实与模型访问策略；不包含密文、私钥或密码。 */

/** SSH 连接向 Agent 开放的最高权限档位。 */
export type SshAgentAccessMode = 'readonly' | 'standard' | 'full'

/** SSH 连接保存的模型访问策略；旧记录缺失时默认关闭。 */
export interface SshAgentAccess {
  enabled: boolean
  mode: SshAgentAccessMode
  allowSudo: boolean
  allowedPaths: string[]
}

/** 已保存 SSH 连接的公开摘要，不含任何凭据密文。 */
export interface SshProfile {
  id: string
  revision: number
  name: string
  host: string
  port: number
  username: string
  auth: 'password' | 'key'
  environment: string
  projectId: string | null
  disabled: boolean
  fingerprint: string | null
  credentialConfigured: boolean
  agentAccess: SshAgentAccess
}

/** 新增或编辑 SSH 连接的保存请求契约。 */
export interface SaveSshProfile {
  id: string | null
  revision: number | null
  name: string
  host: string
  port: number
  username: string
  auth: 'password' | 'key'
  environment: string
  projectId: string | null
  disabled: boolean
  password?: string
  passphrase?: string
  agentAccess?: SshAgentAccess
}

/** 活动交互式 SSH 终端的公开状态。 */
export interface SshTerminal {
  id: string
  connectionId: string
  name: string
  status: 'connected' | 'disconnected'
  message: string | null
}

/** SSH 桌面工作区状态快照。 */
export interface SshStatus {
  supported: boolean
  connections: SshProfile[]
  terminals: SshTerminal[]
}

/** 手动连接或测试 SSH 主机的返回结果。 */
export type SshConnectResult =
  | { kind: 'confirm-host'; connectionId: string; revision: number; fingerprint: string }
  | { kind: 'tested' }
  | { kind: 'terminal'; terminal: SshTerminal }

/** 交互式 SSH 终端流式事件。 */
export type SshTerminalEvent =
  | { type: 'snapshot'; data: string; terminal: SshTerminal }
  | { type: 'data'; data: string }
  | { type: 'status'; terminal: SshTerminal }
