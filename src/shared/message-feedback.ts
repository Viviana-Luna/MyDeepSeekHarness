import { isRecord } from './validation.ts'
export const DESKTOP_MESSAGE_FEEDBACK_MAX_ITEMS = 8_192
export const DESKTOP_MESSAGE_FEEDBACK_ID_MAX_LENGTH = 512
export const DESKTOP_MESSAGE_FEEDBACK_VERSION_MAX_LENGTH = 512

export type DesktopMessageFeedbackRating = 'positive' | 'negative'

export interface DesktopMessageFeedbackItem {
  readonly messageId: string
  readonly rating: DesktopMessageFeedbackRating
  readonly version: string
}

export interface DesktopMessageFeedbackList {
  readonly items: readonly DesktopMessageFeedbackItem[]
}

export type DesktopMessageFeedbackMutationResult =
  | {
      readonly kind: 'committed'
      readonly item: DesktopMessageFeedbackItem | null
    }
  | {
      readonly kind: 'version-conflict'
      readonly current: DesktopMessageFeedbackItem | null
    }

function invalidMessageFeedback(subject: string): never {
  throw new Error(`DSH Host 返回了无效的${subject}`)
}

function boundedIdentifier(value: unknown, maximum: number, subject: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    value.includes('\0')
  ) {
    return invalidMessageFeedback(subject)
  }
  return value
}

/** 严格收窄 Host 返回的反馈记录，避免把备注或内部字段带入 renderer。 */
export function parseDesktopMessageFeedbackItem(input: unknown): DesktopMessageFeedbackItem {
  if (!isRecord(input) || (input.rating !== 'positive' && input.rating !== 'negative')) {
    return invalidMessageFeedback('消息反馈记录')
  }
  return {
    messageId: boundedIdentifier(
      input.messageId,
      DESKTOP_MESSAGE_FEEDBACK_ID_MAX_LENGTH,
      '消息反馈记录',
    ),
    rating: input.rating,
    version: boundedIdentifier(
      input.version,
      DESKTOP_MESSAGE_FEEDBACK_VERSION_MAX_LENGTH,
      '消息反馈记录',
    ),
  }
}

export function parseDesktopMessageFeedbackList(input: unknown): DesktopMessageFeedbackList {
  if (
    !isRecord(input) ||
    !Array.isArray(input.items) ||
    input.items.length > DESKTOP_MESSAGE_FEEDBACK_MAX_ITEMS
  ) {
    return invalidMessageFeedback('消息反馈目录')
  }
  const items = input.items.map(parseDesktopMessageFeedbackItem)
  if (new Set(items.map(item => item.messageId)).size !== items.length) {
    return invalidMessageFeedback('消息反馈目录')
  }
  return { items }
}

export function parseDesktopMessageFeedbackMutationResult(
  input: unknown,
): DesktopMessageFeedbackMutationResult {
  if (!isRecord(input)) return invalidMessageFeedback('消息反馈操作结果')
  if (input.kind === 'committed') {
    if (!Object.hasOwn(input, 'item')) return invalidMessageFeedback('消息反馈操作结果')
    return {
      kind: 'committed',
      item: input.item === null ? null : parseDesktopMessageFeedbackItem(input.item),
    }
  }
  if (input.kind === 'version-conflict') {
    if (!Object.hasOwn(input, 'current')) return invalidMessageFeedback('消息反馈操作结果')
    return {
      kind: 'version-conflict',
      current: input.current === null ? null : parseDesktopMessageFeedbackItem(input.current),
    }
  }
  return invalidMessageFeedback('消息反馈操作结果')
}
