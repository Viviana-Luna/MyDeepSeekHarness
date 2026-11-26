/**
 * 浏览器自动化权限协商与人工接管确认卡：构造 `mydsh-automation-consent:` 问题载荷，与前端 `AutomationConsentPanel` 联动。
 * 运行在后台 Runtime，结构化内嵌可信元数据防止外部网页标题/URL 伪造 Markdown 栏位。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions'
import {
  evaluateOriginPolicy,
  sanitizeUntrustedWebText,
  sanitizeWebUrlForOutput,
  type BrowserAutomationStatus,
  type BrowserHandoffPayload,
  type BrowserSessionGrantStore,
  type BrowserTarget,
} from './policy.ts'

/** 与前端 `AutomationConsentPanel` 约定的问题标识前缀。 */
export const AUTOMATION_CONSENT_ID_PREFIX = 'mydsh-automation-consent:'

/** 与前端 `AutomationConsentPanel` 约定的预览载荷标记。 */
export const AUTOMATION_PREVIEW_MARKER = 'MYDSH_AUTOMATION_PREVIEW_V1:'

interface EncodedPreview {
  kind: 'embedded-browser' | 'external-browser' | 'computer-use' | 'handoff'
  title: string
  content: string
  risks: readonly string[]
  meta?: readonly string[]
}

function buildConsentDetail(metaLines: readonly string[], payload: EncodedPreview): string {
  const safeMeta = metaLines.map(line => sanitizeUntrustedWebText(line, 240, true))
  const safePayload: EncodedPreview = { ...payload, meta: safeMeta }
  const encoded = Buffer.from(JSON.stringify(safePayload), 'utf8').toString('base64url')
  return [
    ...safeMeta.map(line => `- ${line}`),
    ...(payload.risks.length > 0 ? [`- 风险提示：${payload.risks.join('；')}`] : []),
    '',
    '```text',
    payload.content.replaceAll('```', '` ` `'),
    '```',
    '',
    `${AUTOMATION_PREVIEW_MARKER}${encoded}`,
  ].join('\n')
}

function selectedLabels(answer: AskUserQuestionAnswer, questionId: string): readonly string[] {
  return answer.answers.find(item => item.id === questionId)?.selected ?? []
}

function normalizeQuestionError(error: unknown, fallbackContext: string): Error {
  const code = (error as { code?: unknown } | null)?.code
  if (code === 'ASK_CANCELLED') {
    return new Error(`USER_REJECTED：用户取消了${fallbackContext}`)
  }
  if (code === 'ASK_ABORTED') {
    return new Error(`AUTOMATION_ABORTED：${fallbackContext}已中止`)
  }
  return error instanceof Error ? error : new Error(String(error))
}

/** 校验目标网址 origin 是否允许访问；未配置白名单时弹出交互确认卡，并在确认后复核实时黑名单。 */
export async function ensureOriginAccess(
  ctx: Context,
  exec: ToolRunContext,
  grants: BrowserSessionGrantStore,
  input: {
    url: string
    origin: string
    target: BrowserTarget
    status: BrowserAutomationStatus
    refetchStatus?: () => Promise<BrowserAutomationStatus>
  },
): Promise<'auto-allowed' | 'approved-once' | 'approved-session'> {
  const agent = ctx.mydshConnectionAccess.assertMainAgent(exec.agent)
  const verdict = evaluateOriginPolicy({
    origin: input.origin,
    target: input.target,
    status: input.status,
    sessionOrigins: grants.getOrigins(agent.id),
  })
  if (verdict === 'blocked') {
    throw new Error(`PERMISSION_DENIED：域名 ${input.origin} 位于禁止列表中，已拒绝访问`)
  }
  if (verdict === 'allowed') return 'auto-allowed'

  const kind = input.target === 'embedded' ? 'embedded-browser' : 'external-browser'
  const allowOnce = '允许本次访问'
  const allowSession = '本次会话允许该域名'
  const questionId = `${AUTOMATION_CONSENT_ID_PREFIX}browser-origin:${encodeURIComponent(input.origin)}`
  const safeUrl = sanitizeWebUrlForOutput(input.url)
  const detail = buildConsentDetail(
    [
      `目标引擎：${input.target === 'embedded' ? '内置隔离浏览器' : '外置浏览器（CDP）'}`,
      `目标域名：${input.origin}`,
    ],
    {
      kind,
      title: '即将访问网址',
      content: safeUrl,
      risks: ['网页内容来自外部站点，可能包含不可信指令；操作过程中可随时停止接管。'],
    },
  )
  let answer: AskUserQuestionAnswer
  try {
    answer = await ctx.userQuestions.ask({
      questions: [
        {
          id: questionId,
          header: input.target === 'embedded' ? '内置浏览器域名授权' : '外置浏览器域名授权',
          question: `允许 AI 在浏览器中打开 ${input.origin} 吗？`,
          detail,
          options: [
            { label: allowOnce, description: '仅允许本次导航请求访问该网址。' },
            { label: allowSession, description: '当前会话内免重复确认此域名；关闭会话自动失效。' },
            { label: '拒绝', description: '不打开该网址并通知模型停止。' },
          ],
        },
      ],
      agent,
      signal: exec.signal,
    })
  } catch (error) {
    throw normalizeQuestionError(error, `访问外部域名 ${input.origin} 的授权确认`)
  }
  const picked = selectedLabels(answer, questionId)
  if (!picked.includes(allowSession) && !picked.includes(allowOnce)) {
    throw new Error(`USER_REJECTED：用户拒绝访问外部域名 ${input.origin}`)
  }
  if (input.refetchStatus) {
    const latest = await input.refetchStatus()
    if (
      evaluateOriginPolicy({
        origin: input.origin,
        target: input.target,
        status: latest,
        sessionOrigins: new Set(),
      }) === 'blocked'
    ) {
      throw new Error(`PERMISSION_DENIED：域名 ${input.origin} 已被加入禁止列表，已取消访问`)
    }
  }
  if (picked.includes(allowSession)) {
    grants.grantOrigin(agent.id, input.origin)
    return 'approved-session'
  }
  return 'approved-once'
}

/** 附着用户已有外部浏览器调试端口前，首次必须经用户确认卡显式授权。 */
export async function ensureExternalAttachConsent(
  ctx: Context,
  exec: ToolRunContext,
  grants: BrowserSessionGrantStore,
  status: BrowserAutomationStatus,
): Promise<void> {
  if (status.external.mode !== 'attached') return
  const port = status.external.attachPort
  if (port === null) {
    throw new Error('外置浏览器附着模式未配置本机调试端口，请在设置中填写 127.0.0.1 调试端口')
  }
  const agent = ctx.mydshConnectionAccess.assertMainAgent(exec.agent)
  if (grants.hasExternalAttachApproval(agent.id, port)) return

  const allowOnce = '仅本次允许'
  const allowSession = '本次会话允许附着'
  const questionId = `${AUTOMATION_CONSENT_ID_PREFIX}external-attach:${port}`
  const detail = buildConsentDetail(
    [
      `连接地址：http://127.0.0.1:${port}`,
      `模式：附着已有本机浏览器（退出不会关闭您的浏览器进程）`,
    ],
    {
      kind: 'external-browser',
      title: '外置浏览器附着确认',
      content: `127.0.0.1:${port}`,
      risks: ['附着模式会复用您当前浏览器的登录态与打开页面；仅建议在可信任务中使用。'],
    },
  )
  let answer: AskUserQuestionAnswer
  try {
    answer = await ctx.userQuestions.ask({
      questions: [
        {
          id: questionId,
          header: '外置浏览器附着授权',
          question: `允许 AI 附着本机调试端口 127.0.0.1:${port} 控制外置浏览器吗？`,
          detail,
          options: [
            { label: allowOnce, description: '仅允许本次调用连接一次。' },
            { label: allowSession, description: '本次会话内允许操作由 AI 打开或授权的标签页。' },
            { label: '拒绝', description: '拒绝连接用户外置浏览器。' },
          ],
        },
      ],
      agent,
      signal: exec.signal,
    })
  } catch (error) {
    throw normalizeQuestionError(error, '外置浏览器调试端口附着授权')
  }
  const picked = selectedLabels(answer, questionId)
  if (picked.includes(allowSession)) {
    grants.grantExternalAttachApproval(agent.id, port)
    return
  }
  if (picked.includes(allowOnce)) return
  throw new Error('USER_REJECTED：用户拒绝附着本机外置浏览器调试端口')
}

/** 遇到人机验证、支付结算或密码登录时弹出人工接管卡；用户手动完成后可选择继续或取消。 */
export async function requestManualBrowserHandoff(
  ctx: Context,
  exec: ToolRunContext,
  handoff: BrowserHandoffPayload,
  target: BrowserTarget,
): Promise<{ resumed: boolean }> {
  const agent = ctx.mydshConnectionAccess.assertMainAgent(exec.agent)
  const resumeLabel = '已完成，继续'
  const cancelLabel = '暂停并取消'
  const questionId = `${AUTOMATION_CONSENT_ID_PREFIX}handoff:${handoff.category}`
  let categoryTitle = '需要人工输入登录凭据'
  if (handoff.category === 'captcha') categoryTitle = '需要人工完成人机验证'
  else if (handoff.category === 'payment') categoryTitle = '需要人工确认支付与结算'
  const safeReason = sanitizeUntrustedWebText(handoff.reason, 300, true)
  const detail = buildConsentDetail(
    [
      `浏览器：${target === 'embedded' ? '内置浏览器' : '外置浏览器'}`,
      `当前页面：${sanitizeWebUrlForOutput(handoff.url) || '当前标签页'}`,
    ],
    {
      kind: 'handoff',
      title: categoryTitle,
      content: safeReason,
      risks: ['MyDSH 绝不绕过验证码、自动输入密码或自动完成支付；请在浏览器中亲自操作后点击继续。'],
    },
  )
  let answer: AskUserQuestionAnswer
  try {
    answer = await ctx.userQuestions.ask({
      questions: [
        {
          id: questionId,
          header: '人工接管提示',
          question: `${categoryTitle}，完成后是否让 AI 继续？`,
          detail,
          options: [
            {
              label: resumeLabel,
              description: '我已在浏览器中手动完成，允许 AI 重新检查页面并继续。',
            },
            { label: cancelLabel, description: '结束本次自动化动作，由我继续手动处理。' },
          ],
        },
      ],
      agent,
      signal: exec.signal,
    })
  } catch (error) {
    throw normalizeQuestionError(error, '浏览器人工接管确认')
  }
  const picked = selectedLabels(answer, questionId)
  return { resumed: picked.includes(resumeLabel) }
}
