/** 连接授权的公开范围；只描述会话写入同意与连接版本，不承载凭据或活动连接。 */

/** 授权所绑定的连接身份；SSH 依赖额外绑定已确认的主机指纹。 */
export interface ConnectionIdentity {
  kind: 'database' | 'ssh'
  id: string
  revision: number
  fingerprint?: string
}

/** 供后台和审计使用的会话写入同意摘要，不能用作模型参数凭证。 */
export interface ConnectionConsentView {
  id: string
  sessionId: string
  connection: ConnectionIdentity
  dependencies: ConnectionIdentity[]
  name: string
}
