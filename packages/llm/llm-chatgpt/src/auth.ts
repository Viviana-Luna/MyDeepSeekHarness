import { setTimeout as delay } from 'node:timers/promises'
import { createHash, randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { createLocalJWKSet, jwtVerify } from 'jose'
import { attributionHeaders, LlmError } from '@deepseek-ai/dsh-llm'
import type { AuthorizationSession } from '@deepseek-ai/dsh-authorization'
import type { CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { record } from './protocol.ts'
import { receiveAuthorization } from './oauth-callback.ts'

const { version } = createRequire(import.meta.url)('../package.json') as { version: string }
export const REQUEST_HEADERS = {
  ...attributionHeaders({
    product: 'mydsh-chatgpt',
    version,
    url: 'https://github.com/Viviana-Luna/MyDeepSeekHarness',
  }),
  originator: 'mydsh',
}
export const AUTH_ORIGIN = 'https://auth.openai.com'
export const RESOURCE = 'https://api.openai.com/v1'
export const MODELS_URL = `${RESOURCE}/models`
const TOKEN_URL = `${AUTH_ORIGIN}/api/accounts/oauth/token`
const DIRECT_SCOPE = 'chatgpt.tokens.use.direct'
const SCOPES = `openid profile email offline_access resource.invoke ${DIRECT_SCOPE}`
export interface AccountGrant {
  kind: 'mydsh-siwc'
  clientId: string
  subject: string
  accountId: string
  scopes: string[]
  planNoticeAcknowledged?: boolean
  tokens?: { accessToken: string; refreshToken: string; idToken: string; expiresAt: number }
}
function text(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length < 65_536 && !/[\r\n]/u.test(value)
  )
}
/** 待完成注册没有身份或令牌，不能用于模型调用。 */
export function pendingRegistration(value: CredentialRecord | undefined): string | undefined {
  const p = value?.kind === 'grant' ? value.payload : undefined
  return record(p) &&
    p.kind === 'mydsh-siwc-pending' &&
    typeof p.clientId === 'string' &&
    /^[A-Za-z0-9._:-]{1,512}$/u.test(p.clientId) &&
    p.clientId !== 'dynamic_agent_client'
    ? p.clientId
    : undefined
}
function accountIdentity(clientId: string, subject: string): string {
  return createHash('sha256')
    .update(JSON.stringify([AUTH_ORIGIN, clientId, subject]))
    .digest('hex')
}
export function planEnabled(grant: AccountGrant): boolean {
  return grant.scopes.includes(DIRECT_SCOPE) && grant.scopes.includes('resource.invoke')
}
export function storedGrant(value: CredentialRecord | undefined): AccountGrant | undefined {
  const p = value?.kind === 'grant' ? value.payload : undefined
  if (
    !record(p) ||
    p.kind !== 'mydsh-siwc' ||
    !text(p.clientId) ||
    p.clientId === 'dynamic_agent_client' ||
    !text(p.subject) ||
    p.accountId !== accountIdentity(p.clientId, p.subject) ||
    !Array.isArray(p.scopes) ||
    !p.scopes.every(text)
  )
    return undefined
  const tokens = p.tokens
  if (
    tokens !== undefined &&
    (!record(tokens) ||
      !text(tokens.accessToken) ||
      !text(tokens.refreshToken) ||
      !text(tokens.idToken) ||
      typeof tokens.expiresAt !== 'number' ||
      !Number.isFinite(tokens.expiresAt))
  )
    return undefined
  return {
    kind: 'mydsh-siwc',
    clientId: p.clientId,
    subject: p.subject,
    accountId: p.accountId as string,
    scopes: [...p.scopes],
    ...(p.planNoticeAcknowledged === true ? { planNoticeAcknowledged: true } : {}),
    ...(tokens === undefined ? {} : { tokens: tokens as AccountGrant['tokens'] & {} }),
  }
}
export function withoutTokens(grant: AccountGrant): AccountGrant {
  const { tokens: _tokens, ...registration } = grant
  return registration
}

/** 固定 HTTPS 端点，不跟随重定向，不把服务端原文或令牌带入错误信息。 */
export async function request(
  url: string,
  signal: AbortSignal,
  init: RequestInit = {},
): Promise<Response> {
  try {
    return await fetch(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      headers: { ...REQUEST_HEADERS, ...init.headers },
    })
  } catch {
    signal.throwIfAborted()
    throw new LlmError('ChatGPT 连接未完成，请检查网络后重试', 'NETWORK')
  }
}
export async function json(response: Response): Promise<Record<string, unknown>> {
  if (!response.body) throw new LlmError('ChatGPT 返回了空响应', 'INVALID_RESPONSE')
  const reader = response.body.getReader()
  const parts: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      // 逐块累计并限制认证及目录响应，不接受无限正文。
      // oxlint-disable-next-line no-await-in-loop
      const part = await reader.read()
      if (part.done) break
      bytes += part.value.byteLength
      if (bytes > 1024 * 1024) throw new LlmError('ChatGPT 响应超过大小限制', 'INVALID_RESPONSE')
      parts.push(part.value)
    }
    const value: unknown = JSON.parse(Buffer.concat(parts).toString('utf8'))
    if (record(value)) return value
  } catch (error) {
    if (error instanceof LlmError) throw error
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  throw new LlmError('ChatGPT 响应格式无效', 'INVALID_RESPONSE')
}
/** OIDC 文档只允许返回同一认证站点的 HTTPS 地址。 */
async function discovery(signal: AbortSignal): Promise<{ jwks: string; revoke: string }> {
  const response = await request(`${AUTH_ORIGIN}/.well-known/openid-configuration`, signal)
  if (!response.ok) {
    await response.body?.cancel()
    throw new LlmError('无法读取 ChatGPT 身份验证配置', 'NETWORK')
  }
  const data = await json(response)
  const endpoint = (value: unknown): string => {
    if (!text(value)) throw new LlmError('ChatGPT 身份验证地址无效', 'INVALID_RESPONSE')
    const url = new URL(value)
    if (url.origin !== AUTH_ORIGIN || url.username || url.password || url.hash)
      throw new LlmError('ChatGPT 身份验证站点不匹配', 'INVALID_RESPONSE')
    return url.href
  }
  if (data.issuer !== AUTH_ORIGIN)
    throw new LlmError('ChatGPT 身份签发方不匹配', 'INVALID_RESPONSE')
  return { jwks: endpoint(data.jwks_uri), revoke: endpoint(data.revocation_endpoint) }
}
async function identity(
  idToken: string,
  clientId: string,
  signal: AbortSignal,
  nonce?: string,
): Promise<string> {
  const config = await discovery(signal)
  const response = await request(config.jwks, signal)
  if (!response.ok) {
    await response.body?.cancel()
    throw new LlmError('无法读取 ChatGPT 身份验证公钥', 'NETWORK')
  }
  const keys = await json(response)
  if (!Array.isArray(keys.keys))
    throw new LlmError('ChatGPT 身份验证公钥格式无效', 'INVALID_RESPONSE')
  try {
    const { payload } = await jwtVerify(idToken, createLocalJWKSet({ keys: keys.keys }), {
      issuer: AUTH_ORIGIN,
      audience: clientId,
      algorithms: ['RS256'],
      requiredClaims: ['sub', 'exp', 'iat'],
      clockTolerance: 5,
    })
    if (
      !text(payload.sub) ||
      (payload.azp !== undefined && payload.azp !== clientId) ||
      (nonce !== undefined && payload.nonce !== nonce)
    )
      throw new Error('身份不匹配')
    return payload.sub
  } catch {
    throw new LlmError('ChatGPT 身份签名或授权上下文校验失败，请重新连接', 'AUTH_REQUIRED')
  }
}
async function token(
  body: URLSearchParams,
  signal: AbortSignal,
  clientId: string,
  previous?: AccountGrant,
  nonce?: string,
): Promise<AccountGrant> {
  const response = await request(TOKEN_URL, signal, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  const data = await json(response).catch(error => {
    if (response.ok) throw error
    return {} as Record<string, unknown>
  })
  if (!response.ok) {
    const code =
      typeof data.error === 'string' ? data.error : record(data.error) ? data.error.code : undefined
    const permanent =
      response.status === 401 ||
      [
        'invalid_grant',
        'invalid_refresh_token',
        'token_expired',
        'refresh_token_expired',
        'refresh_token_reused',
        'refresh_token_invalidated',
      ].includes(String(code))
    throw new LlmError(
      permanent
        ? 'ChatGPT 授权已失效，请重新连接'
        : `ChatGPT 授权请求未完成（HTTP ${response.status}），请重试`,
      permanent ? 'AUTH_REQUIRED' : 'NETWORK',
    )
  }
  const idToken = data.id_token ?? (nonce === undefined ? previous?.tokens?.idToken : undefined)
  if (!text(idToken)) throw new LlmError('ChatGPT 未返回身份令牌', 'AUTH_REQUIRED')
  const subject =
    data.id_token === undefined && nonce === undefined && previous
      ? previous.subject
      : await identity(idToken, clientId, signal, nonce)
  if (previous && (previous.subject !== subject || previous.clientId !== clientId))
    throw new LlmError('返回的 ChatGPT 账号与所选注册不匹配', 'AUTH_REQUIRED')
  const scopes =
    typeof data.scope === 'string'
      ? data.scope.split(/\s+/u).filter(Boolean)
      : nonce === undefined
        ? previous?.scopes
        : undefined
  if (!scopes) throw new LlmError('ChatGPT 未返回授权范围', 'AUTH_REQUIRED')
  const grant: AccountGrant = {
    kind: 'mydsh-siwc',
    clientId,
    subject,
    accountId: accountIdentity(clientId, subject),
    scopes,
    ...(previous?.planNoticeAcknowledged === true ? { planNoticeAcknowledged: true } : {}),
  }
  // 只授予身份权限时保留注册，不能转为模型调用或其他计费方式。
  if (!planEnabled(grant)) return grant
  if (
    !text(data.access_token) ||
    !text(data.refresh_token) ||
    typeof data.token_type !== 'string' ||
    data.token_type.toLowerCase() !== 'bearer' ||
    typeof data.expires_in !== 'number' ||
    !Number.isFinite(data.expires_in) ||
    data.expires_in <= 0
  ) {
    throw new LlmError('ChatGPT 订阅令牌响应不完整，请重新连接', 'AUTH_REQUIRED')
  }
  grant.tokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    idToken,
    expiresAt: Date.now() + data.expires_in * 1000,
  }
  return grant
}
export function refreshGrant(previous: AccountGrant, signal: AbortSignal): Promise<AccountGrant> {
  if (!previous.tokens) throw new LlmError('请重新连接 ChatGPT 订阅', 'AUTH_REQUIRED')
  return token(
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: previous.clientId,
      refresh_token: previous.tokens.refreshToken,
      resource: RESOURCE,
    }),
    signal,
    previous.clientId,
    previous,
  )
}
export async function revokeGrant(grant: AccountGrant, signal: AbortSignal): Promise<void> {
  if (!grant.tokens) return
  const config = await discovery(signal)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // 撤销可重复提交；只对网络失败和 5xx 做一次有界重试。
      // oxlint-disable-next-line no-await-in-loop
      const response = await request(config.revoke, signal, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          token: grant.tokens.refreshToken,
          token_type_hint: 'refresh_token',
          client_id: grant.clientId,
        }).toString(),
      })
      // oxlint-disable-next-line no-await-in-loop
      await response.body?.cancel()
      if (response.status === 200) return
      if (response.status < 500) throw new LlmError('尚未确认远端授权已撤销', 'REVOCATION_FAILED')
    } catch (error) {
      if (signal.aborted || attempt > 0 || !(error instanceof LlmError) || error.code !== 'NETWORK')
        throw error
    }
    // oxlint-disable-next-line no-await-in-loop
    if (attempt === 0) await delay(250, undefined, { signal })
  }
  throw new LlmError('尚未确认远端授权已撤销', 'NETWORK')
}
export async function authorize(
  session: AuthorizationSession,
  hostId: string,
  previous: AccountGrant | undefined,
  pendingClientId: string | undefined,
  saveRegistration: (clientId: string) => Promise<void>,
): Promise<AccountGrant> {
  const deadline = AbortSignal.timeout(10 * 60_000)
  const signal = AbortSignal.any([session.signal, deadline])
  const state = randomBytes(32).toString('base64url'),
    nonce = randomBytes(32).toString('base64url'),
    verifier = randomBytes(64).toString('base64url')
  try {
    const clientId = previous?.clientId ?? pendingClientId
    const callback = await receiveAuthorization(signal, state, clientId, redirectUri => {
      const url = new URL(`${AUTH_ORIGIN}/api/accounts/authorize`)
      url.search = new URLSearchParams({
        client_id: clientId ?? 'dynamic_agent_client',
        ext_agent_host_id: hostId,
        ...(clientId ? {} : { agent_name_hint: 'MyDSH' }),
        response_type: 'code',
        redirect_uri: redirectUri,
        scope: SCOPES,
        resource: RESOURCE,
        state,
        nonce,
        code_challenge_method: 'S256',
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        ...(previous && !planEnabled(previous) ? { prompt: 'consent' } : {}),
      }).toString()
      // 不携带 id_token_hint，授权链接可安全交给受信任界面；返回登录仍核对已保存身份。
      session.notify({ message: '请在系统浏览器中授权 MyDSH 使用 ChatGPT 订阅。', url: url.href })
    })
    // 回调签发的注册先落盘；交换失败或取消后继续复用，身份验证完成前不激活。
    if (!clientId) await saveRegistration(callback.clientId)
    signal.throwIfAborted()
    return await token(
      new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: callback.clientId,
        redirect_uri: callback.redirectUri,
        code: callback.code,
        code_verifier: verifier,
        resource: RESOURCE,
      }),
      signal,
      callback.clientId,
      previous,
      nonce,
    )
  } catch (error) {
    if (deadline.aborted && !session.signal.aborted)
      throw new LlmError('ChatGPT 授权已超时，请重新连接', 'AUTH_TIMEOUT')
    if (signal.aborted || error instanceof LlmError) throw error
    throw new LlmError('ChatGPT 授权未完成，请重新连接', 'AUTH_REQUIRED')
  }
}
