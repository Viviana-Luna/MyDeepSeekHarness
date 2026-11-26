import { createHash } from 'node:crypto'
import { Client } from 'ssh2'
import type { ConnectConfig } from 'ssh2'
import type { SshProfile } from '../types.d.ts'

type Target = Pick<SshProfile, 'host' | 'port' | 'username'>
const closedClients = new WeakSet<Client>()
export const fingerprintOf = (key: Buffer): string =>
  `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/u, '')}`

/** 先取主机身份再申请凭据；探测连接始终拒绝认证。 */
export async function probeHost(target: Target, signal: AbortSignal): Promise<string> {
  let fingerprint: string | undefined
  try {
    const client = await connectSsh(target, {}, signal, key => {
      fingerprint = fingerprintOf(key)
      return false
    })
    await closeClient(client)
  } catch (error) {
    signal.throwIfAborted()
    if (!fingerprint) throw error
  }
  if (!fingerprint) throw new Error('SSH 服务没有返回主机指纹')
  return fingerprint
}

/** 不继承用户 SSH 配置、Agent 或转发能力，认证前必须核对主机指纹。 */
export function connectSsh(
  target: Target,
  auth: Pick<ConnectConfig, 'password' | 'privateKey' | 'passphrase'>,
  signal: AbortSignal,
  verify: (key: Buffer) => boolean,
): Promise<Client> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const client = new Client()
    let settled = false,
      rejectedIdentity = false
    const abort = () => {
      client.destroy()
      finish(signal.reason ?? new Error('SSH 连接已取消'))
    }
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', abort)
      if (error) {
        client.destroy()
        reject(error)
      } else resolve(client)
    }
    client.on('error', error =>
      finish(
        rejectedIdentity ? new Error('SSH 主机指纹不匹配，已阻止连接；请核对服务器身份') : error,
      ),
    )
    client.once('close', () => {
      closedClients.add(client)
      finish(new Error('SSH 连接在认证完成前关闭'))
    })
    client.once('ready', () => finish())
    signal.addEventListener('abort', abort, { once: true })
    try {
      client.connect({
        ...target,
        ...auth,
        readyTimeout: 20_000,
        keepaliveInterval: 15_000,
        keepaliveCountMax: 3,
        tryKeyboard: false,
        agentForward: false,
        hostVerifier: (key: Buffer) => {
          const accepted = verify(key)
          rejectedIdentity = !accepted
          return accepted
        },
      })
    } catch (error) {
      finish(error instanceof Error ? error : new Error('SSH 连接参数无效'))
    }
  })
}

/** 等待本地 socket 关闭；不把通道关闭宣称为远端后台进程已经终止。 */
export function closeClient(client: Client): Promise<void> {
  if (closedClients.has(client)) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.destroy()
      reject(new Error('SSH 本地连接关闭超时，远端状态未知'))
    }, 3000)
    client.once('close', () => {
      clearTimeout(timer)
      resolve()
    })
    client.destroy()
  })
}
