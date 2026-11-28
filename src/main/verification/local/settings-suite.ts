/**
 * 设置中心全分页、归档恢复、无障碍降级、透明合成与多尺寸响应式验收套件。
 */
import {
  verifyAppearanceModelsAndPresetsPages,
  verifyArchivedSessionsAndDeletion,
  verifyAutomationAndBuiltinPluginSettings,
  verifyLegacyEditorAndIslandGapInvariants,
} from './settings-pages-verifier.ts'
import {
  verifyAccessibilityAndThemeCaptures,
  verifyCanvasMaterialAndWindowComposition,
  verifyMultiSizeResponsiveAndRightTabs,
} from './settings-visual-verifier.ts'
import {
  assertSuiteInvariants,
  ensureArchivePrerequisiteSession,
  type LocalVerifyState,
} from './state.ts'

/** 运行 settings 验收套件。 */
export async function runSettingsSuite(state: LocalVerifyState): Promise<void> {
  await ensureArchivePrerequisiteSession(state)
  await verifyAppearanceModelsAndPresetsPages(state)
  await verifyArchivedSessionsAndDeletion(state)
  await verifyAutomationAndBuiltinPluginSettings(state)
  await verifyLegacyEditorAndIslandGapInvariants(state)
  await verifyAccessibilityAndThemeCaptures(state)
  await verifyCanvasMaterialAndWindowComposition(state)
  await verifyMultiSizeResponsiveAndRightTabs(state)
  assertSuiteInvariants('settings', state)
}
