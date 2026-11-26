/**
 * 离线 Agent 调度评测套件的类型声明文件，供 TypeScript 测试严格检查评测输出结构。
 */

/** 单个预设的工具暴露面与 Token 预算评测指标。 */
export interface PresetSurfaceMetrics {
  readonly presetId: string
  readonly toolCount: number
  readonly toolNames: readonly string[]
  readonly schemaBytes: number
  readonly estimatedSchemaTokens: number
  readonly legacySchemaBytesWithPeripherals: number
  readonly schemaReductionRatio: number
}

/** 离线调度评测完整汇总结果。 */
export interface OfflineHarnessEvalReport {
  readonly platform: NodeJS.Platform
  readonly isolatedPeripheralCount: number
  readonly isolatedPeripheralBytes: number
  readonly presets: readonly PresetSurfaceMetrics[]
  readonly cliRoundtripPassed: boolean
  readonly securityBoundariesPassed: boolean
  readonly retiredAliasPassed: boolean
}

/** 运行完整离线 Agent 调度评测。 */
export function runOfflineHarnessEvaluation(): Promise<OfflineHarnessEvalReport>

/** 装载真实 `roster.json` 启动隔离评测 Runtime 上下文。 */
export function bootRealRosterForEval(
  tempHome: string,
  options?: {
    readonly settingsPath?: string
    readonly credentialsPath?: string
    readonly includeUserRoot?: boolean
    readonly mountFixtures?: boolean
  },
): Promise<{ readonly ctx: unknown; readonly queries: unknown[]; readonly installedIds: string[] }>
