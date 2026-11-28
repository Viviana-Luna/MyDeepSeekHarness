/**
 * 文件树、代码编辑器、全文搜索、项目任务、Git 与终端验收套件。
 */
import {
  verifyFileTreeAndEditorConflict,
  verifyHostRecoveryAndUnsavedGuards,
  verifyProjectSearchTasksAndEditorLayout,
} from './file-editor-verifier.ts'
import {
  verifyDiffReviewAndBounds,
  verifySourceControlStagingAndCommit,
  verifyUserTerminalWorkspace,
} from './scm-terminal-verifier.ts'
import { assertSuiteInvariants, type LocalVerifyState } from './state.ts'

/** 运行 files-scm 验收套件。 */
export async function runFilesScmSuite(state: LocalVerifyState): Promise<void> {
  await verifyFileTreeAndEditorConflict(state)
  await verifyHostRecoveryAndUnsavedGuards(state)
  await verifyProjectSearchTasksAndEditorLayout(state)
  await verifySourceControlStagingAndCommit(state)
  await verifyDiffReviewAndBounds(state)
  await verifyUserTerminalWorkspace(state)
  assertSuiteInvariants('files-scm', state)
}
