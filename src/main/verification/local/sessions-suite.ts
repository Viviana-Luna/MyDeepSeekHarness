/**
 * 项目分组、会话操作、会话搜索与液态标签栏动效验收套件。
 */
import {
  verifyPeerTabFocusAndViewIsolation,
  verifyProjectGroupingAndPinning,
  verifySessionSearchDialog,
  verifyWorkspaceGroupsAndPreparePeerTab,
} from './session-list-verifier.ts'
import {
  verifyLiquidTabMotionAndPress,
  verifySessionTabAccessibilityMedia,
  verifySessionTabOverflowAndClose,
  verifySessionTabReorderAndFill,
  verifySessionTabResponsiveSizes,
} from './session-tabs-verifier.ts'
import { assertSuiteInvariants, ensureInitialShellSampled, type LocalVerifyState } from './state.ts'

/** 运行 sessions 验收套件。 */
export async function runSessionsSuite(state: LocalVerifyState): Promise<void> {
  await ensureInitialShellSampled(state)
  await verifyProjectGroupingAndPinning(state)
  await verifySessionSearchDialog(state)
  await verifyWorkspaceGroupsAndPreparePeerTab(state)
  await verifyPeerTabFocusAndViewIsolation(state)
  await verifyLiquidTabMotionAndPress(state)
  await verifySessionTabResponsiveSizes(state)
  await verifySessionTabAccessibilityMedia(state)
  await verifySessionTabReorderAndFill(state)
  await verifySessionTabOverflowAndClose(state)
  assertSuiteInvariants('sessions', state)
}
