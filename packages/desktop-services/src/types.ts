/** Remote 客户端只引用此纯类型子路径，不加载 Cordis 后台服务与 Node 实现。 */
export type * from '../../../src/runtime/workspace/contracts.ts'
export type * from '../../../src/runtime/workspace/project-service.ts'
export type * from '../../../src/runtime/workspace/workspace-index-service.ts'
export type { GitAiAnalysis, GitAiExecution } from '../../../src/shared/git-ai.ts'
export type { GitAiAnalysisRequest } from './git-ai-model.ts'
export type { GitAiPlan, GitAiPlanBatch } from '../../../src/runtime/workspace/git-ai-plan.ts'
export type {
  GitAiScope,
  GitAiChange,
  GitAiChanges,
  GitAiExcludedChange,
} from '../../../src/runtime/workspace/git-ai-changes.ts'
export type { DesktopFileReferenceCandidate } from '../../../src/shared/file-references.ts'
export type { DesktopProjectEvent } from '../../../src/shared/project-events.ts'
export type {
  DesktopTerminalCreateRequest,
  DesktopTerminalDescriptor,
  DesktopTerminalEvent,
  DesktopTerminalKind,
} from '../../../src/shared/terminal.ts'
export type { ProjectTaskLaunch } from '../../../src/shared/project-tasks.ts'
