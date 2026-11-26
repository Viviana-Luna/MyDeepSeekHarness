/** 仅包含连接页可以显示的事实；不含任何访问令牌、刷新令牌或完整账号标识。 */
export interface ChatGPTStatus {
  connected: boolean
  registered: boolean
  planEnabled: boolean
  connecting: boolean
  needsPlanNotice: boolean
  account: string | null
  authorizationUrl: string | null
  message: string | null
  models: { id: string; name: string; contextWindow: number; reasoningEfforts: string[] }[]
}
