/** 连接凭据使用系统保护的随机密钥；此模块仅由主进程及隔离验收调用。 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

export interface CredentialBinding {
  connectionId: string
  purpose: string
}
export type SecretProtection = 'electron-safe-storage' | 'local-key-file'

export interface SecretEnvelope {
  format: string
  version: number
  protection: string
  algorithm: string
  wrappedKey: string
  nonce: string
  tag: string
  ciphertext: string
}
export interface SystemSecretStorage {
  readonly protection?: SecretProtection
  isEncryptionAvailable(): boolean
  getSelectedStorageBackend?(): string
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

const format = 'mydsh-connection-secret'
const version = 1
const defaultProtection: SecretProtection = 'electron-safe-storage'
const supportedProtections = new Set<string>(['electron-safe-storage', 'local-key-file'])
const algorithm = 'aes-256-gcm'
const fields = [
  'format',
  'version',
  'protection',
  'algorithm',
  'wrappedKey',
  'nonce',
  'tag',
  'ciphertext',
]
const purposes = new Set(['ssh-password', 'ssh-private-key', 'ssh-passphrase', 'database-password'])
const maxSecretBytes = 64 * 1024

function bindingData(
  binding: CredentialBinding,
  wrappedKey: string,
  activeProtection: SecretProtection = defaultProtection,
) {
  if (
    !binding ||
    typeof binding.connectionId !== 'string' ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(binding.connectionId) ||
    !purposes.has(binding.purpose)
  )
    throw new Error('凭据绑定信息无效。')
  if (!supportedProtections.has(activeProtection)) throw new Error('凭据保护方式不受支持。')
  // 身份来自调用者核对后的连接记录，不从密文自报的目标中读取。
  return Buffer.from(
    JSON.stringify([
      format,
      version,
      activeProtection,
      algorithm,
      binding.connectionId,
      binding.purpose,
      wrappedKey,
    ]),
  )
}

function decode(value: string, minimum: number, maximum: number) {
  if (typeof value !== 'string' || value.length > Math.ceil(maximum / 3) * 4)
    throw new Error('凭据密文编码无效。')
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length < minimum || bytes.length > maximum || bytes.toString('base64') !== value) {
    throw new Error('凭据密文编码无效。')
  }
  return bytes
}

function requireStorage(storage: SystemSecretStorage) {
  if (
    storage.isEncryptionAvailable() !== true ||
    storage.getSelectedStorageBackend?.() === 'basic_text'
  ) {
    throw new Error('系统凭据加密不可用。')
  }
}

export function sealCredential(
  secret: string,
  binding: CredentialBinding,
  storage: SystemSecretStorage,
): SecretEnvelope {
  const activeProtection: SecretProtection = storage.protection ?? defaultProtection
  bindingData(binding, '', activeProtection)
  if (
    typeof secret !== 'string' ||
    !secret.isWellFormed() ||
    Buffer.byteLength(secret) > maxSecretBytes
  ) {
    throw new Error('凭据内容无效或超过大小限制。')
  }
  let key: Buffer | undefined, plaintext: Buffer | undefined
  try {
    requireStorage(storage)
    key = randomBytes(32)
    plaintext = Buffer.from(secret)
    const protectedKey = storage.encryptString(key.toString('base64'))
    if (!Buffer.isBuffer(protectedKey)) throw new Error('系统加密结果无效。')
    const wrappedKey = protectedKey.toString('base64')
    decode(wrappedKey, 1, 4096)
    const nonce = randomBytes(12)
    const cipher = createCipheriv(algorithm, key, nonce, { authTagLength: 16 })
    cipher.setAAD(bindingData(binding, wrappedKey, activeProtection))
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
    return {
      format,
      version,
      protection: activeProtection,
      algorithm,
      wrappedKey,
      nonce: nonce.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    }
  } catch {
    // 系统异常可能包含输入，不能透传异常消息、cause 或明文回退值。
    throw new Error('凭据加密失败，未生成可保存记录。')
  } finally {
    key?.fill(0)
    plaintext?.fill(0)
    // JS 字符串和底层库的副本无法保证清零，不将 Buffer 擦除宣传为安全内存。
  }
}

export function openCredential(
  input: unknown,
  binding: CredentialBinding,
  storage: SystemSecretStorage,
): string {
  const envelope = input as SecretEnvelope
  const activeProtection: SecretProtection = storage.protection ?? defaultProtection
  bindingData(binding, '', activeProtection)
  if (
    !envelope ||
    typeof envelope !== 'object' ||
    Array.isArray(envelope) ||
    Object.keys(envelope).length !== fields.length ||
    !fields.every(field => Object.hasOwn(envelope, field)) ||
    envelope.format !== format ||
    envelope.version !== version ||
    !supportedProtections.has(envelope.protection) ||
    envelope.algorithm !== algorithm
  ) {
    throw new Error('凭据密文格式或版本不受支持。')
  }
  if (envelope.protection !== activeProtection) {
    throw new Error('凭据无法解密或校验失败；请检查系统密钥与连接身份，原记录保持不变。')
  }
  const wrappedKey = decode(envelope.wrappedKey, 1, 4096)
  const nonce = decode(envelope.nonce, 12, 12)
  const tag = decode(envelope.tag, 16, 16)
  const ciphertext = decode(envelope.ciphertext, 0, maxSecretBytes)
  let key: Buffer | undefined,
    partial: Buffer | undefined,
    final: Buffer | undefined,
    plaintext: Buffer | undefined
  try {
    requireStorage(storage)
    key = decode(storage.decryptString(wrappedKey), 32, 32)
    const decipher = createDecipheriv(algorithm, key, nonce, { authTagLength: 16 })
    decipher.setAAD(bindingData(binding, envelope.wrappedKey, activeProtection))
    decipher.setAuthTag(tag)
    partial = decipher.update(ciphertext)
    final = decipher.final()
    // GCM 验证通过前，不向调用者返回任何明文。
    plaintext = Buffer.concat([partial, final])
    return new TextDecoder('utf-8', { fatal: true }).decode(plaintext)
  } catch {
    throw new Error('凭据无法解密或校验失败；请检查系统密钥与连接身份，原记录保持不变。')
  } finally {
    key?.fill(0)
    partial?.fill(0)
    final?.fill(0)
    plaintext?.fill(0)
  }
}
