import type { Context } from '@deepseek-ai/cordis'
import { ChatGPTAccount } from './account.ts'
export { ChatGPTAccount, ACCOUNT_KEY } from './account.ts'
export { ChatGPTAdapter } from './adapter.ts'
export type { ChatGPTAdapterOptions } from './adapter.ts'
export { PROVIDER } from './protocol.ts'
export type { ChatGPTModel, ChatGPTCredential } from './protocol.ts'
export type { ChatGPTStatus } from '../types.d.ts'

export const name = 'llm-chatgpt'
export const inject = ['llm', 'credentials', 'authorization']
export function apply(ctx: Context): void {
  ctx.plugin(ChatGPTAccount)
}
