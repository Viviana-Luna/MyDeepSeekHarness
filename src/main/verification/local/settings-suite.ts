/**
 * 设置中心全分页、归档恢复、无障碍降级、透明合成与多尺寸响应式验收套件。
 */
import {
  type LocalVerifyState,
  assertSuiteInvariants,
  ensureArchivePrerequisiteSession,
} from './state.ts'
import {
  runSettingsStep1,
  runSettingsStep2,
  runSettingsStep3,
  runSettingsStep4,
  runSettingsStep5,
  runSettingsStep6,
  runSettingsStep7,
  runSettingsStep8,
} from './settings-part-1.ts'
import {
  runSettingsStep9,
  runSettingsStep10,
  runSettingsStep11,
  runSettingsStep12,
} from './settings-part-2.ts'

/** 运行 settings 验收套件。 */
export async function runSettingsSuite(bag: LocalVerifyState): Promise<void> {
  await ensureArchivePrerequisiteSession(bag)
  await runSettingsStep1(bag)
  await runSettingsStep2(bag)
  await runSettingsStep3(bag)
  await runSettingsStep4(bag)
  await runSettingsStep5(bag)
  await runSettingsStep6(bag)
  await runSettingsStep7(bag)
  await runSettingsStep8(bag)
  await runSettingsStep9(bag)
  await runSettingsStep10(bag)
  await runSettingsStep11(bag)
  await runSettingsStep12(bag)
  assertSuiteInvariants('settings', bag)
}
