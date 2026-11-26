/**
 * 桌面 Computer Use 交互确认卡协商：构造 `mydsh-automation-consent:` 问题载荷并与 `AutomationConsentPanel` 联动。
 * 支持「按应用会话授权」与「每步强制确认」两种策略，结构化内嵌可信元数据防止窗体标题注入并明示急停快捷键。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions'
import {
  sanitizeUntrustedText,
  type ComputerSessionGrantStore,
  type ComputerUseStatusPayload,
} from './policy.ts'

const CONSENT_ID_PREFIX = 'mydsh-automation-consent:'
const PREVIEW_MARKER = 'MYDSH_AUTOMATION_PREVIEW_V1:'

function buildDetail(
  metaLines: readonly string[],
  title: string,
  content: string,
  risks: readonly string[],
): string {
  const safeMeta = metaLines.map(line => sanitizeUntrustedText(line, 240, true))
  const encoded = Buffer.from(
    JSON.stringify({ kind: 'computer-use', title, content, risks, meta: safeMeta }),
    'utf8',
  ).toString('base64url')
  return [
    ...safeMeta.map(line => `- ${line}`),
    ...(risks.length > 0 ? [`- 风险提示：${risks.join('；')}`] : []),
    '',
    '```text',
    content.replaceAll('```', '` ` `'),
    '```',
    '',
    `${PREVIEW_MARKER}${encoded}`,
  ].join('\n')
}

function selectedOf(answer: AskUserQuestionAnswer, id: string): readonly string[] {
  return answer.answers.find(item => item.id === id)?.selected ?? []
}

function normalizeQuestionError(error: unknown, targetLabel: string): Error {
  const code = (error as { code?: unknown } | null)?.code
  if (code === 'ASK_CANCELLED') {
    return new Error(`USER_REJECTED：用户取消了在「${targetLabel}」执行桌面操控的授权确认`)
  }
  if (code === 'ASK_ABORTED') {
    return new Error(`AUTOMATION_ABORTED：桌面操控授权确认已中止（目标：${targetLabel}）`)
  }
  return error instanceof Error ? error : new Error(String(error))
}

/** 在执行桌面操控动作前协商用户授权；若用户开启「每步确认」或首次操控新目标应用则弹出确认卡。 */
export async function ensureComputerActionConsent(
  ctx: Context,
  exec: ToolRunContext,
  grants: ComputerSessionGrantStore,
  input: {
    status: ComputerUseStatusPayload
    scopeKey: string
    targetLabel: string
    actionSummary: string
    forcePerCall?: boolean
  },
): Promise<'session-reused' | 'approved-once' | 'approved-session'> {
  const agent = ctx.mydshConnectionAccess.assertMainAgent(exec.agent)
  const safeTarget = sanitizeUntrustedText(input.targetLabel, 140, true)
  const mustPromptEachTime = input.status.confirmEveryAction || input.forcePerCall === true
  if (!mustPromptEachTime && grants.hasTargetGrant(agent.id, input.scopeKey)) {
    return 'session-reused'
  }

  const allowOnce = '允许本次操作'
  const allowSession = '本次会话允许操控该目标'
  const questionId = `${CONSENT_ID_PREFIX}computer:${encodeURIComponent(input.scopeKey)}`
  const scopeText = input.status.scope === 'window' ? '仅已授权单窗口' : '显示器区域'
  const detail = buildDetail(
    [
      `操控目标：${safeTarget}`,
      `操控范围：${scopeText}`,
      '全局急停：macOS ⌘⇧Esc / Windows Ctrl+Shift+F12',
    ],
    '即将执行的桌面操作',
    input.actionSummary,
    ['系统级桌面操控会真实驱动键鼠；操作中可随时按急停快捷键或直接移动鼠标中止。'],
  )
  const options = mustPromptEachTime
    ? [
        { label: allowOnce, description: '仅放行本次桌面操控步骤。' },
        { label: '拒绝', description: '不执行本次操作并通知 AI 停止。' },
      ]
    : [
        { label: allowOnce, description: '仅放行本次桌面操控步骤。' },
        { label: allowSession, description: '本会话内允许操控该目标应用/区域；关闭会话自动撤销。' },
        { label: '拒绝', description: '不执行本次操作并通知 AI 停止。' },
      ]

  let answer: AskUserQuestionAnswer
  try {
    answer = await ctx.userQuestions.ask({
      questions: [
        {
          id: questionId,
          header: '桌面操控授权确认',
          question: `允许 AI 在「${safeTarget}」执行：${sanitizeUntrustedText(input.actionSummary, 160, true)}？`,
          detail,
          options,
        },
      ],
      agent,
      signal: exec.signal,
    })
  } catch (error) {
    throw normalizeQuestionError(error, safeTarget)
  }
  const picked = selectedOf(answer, questionId)
  if (!mustPromptEachTime && picked.includes(allowSession)) {
    grants.grantTarget(agent.id, input.scopeKey)
    return 'approved-session'
  }
  if (picked.includes(allowOnce)) return 'approved-once'
  throw new Error(`USER_REJECTED：用户拒绝在「${safeTarget}」执行桌面操控`)
}
