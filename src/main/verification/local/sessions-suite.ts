/**
 * 项目分组、会话操作、会话搜索与液态标签栏动效验收套件。
 */
import { type LocalVerifyState, assertSuiteInvariants, ensureInitialShellSampled } from './state.ts'
import {
  runSessionsStep1,
  runSessionsStep2,
  runSessionsStep3,
  runSessionsStep4,
  runSessionsStep5,
  runSessionsStep6,
  runSessionsStep7,
  runSessionsStep8,
  runSessionsStep9,
} from './sessions-part-1.ts'
import {
  runSessionsStep10,
  runSessionsStep11,
  runSessionsStep12,
  runSessionsStep13,
  runSessionsStep14,
} from './sessions-part-2.ts'

/** 运行 sessions 验收套件。 */
export async function runSessionsSuite(bag: LocalVerifyState): Promise<void> {
  await ensureInitialShellSampled(bag)
  await runSessionsStep1(bag)
  await runSessionsStep2(bag)
  await runSessionsStep3(bag)
  await runSessionsStep4(bag)
  await runSessionsStep5(bag)
  await runSessionsStep6(bag)
  await runSessionsStep7(bag)
  await runSessionsStep8(bag)
  await runSessionsStep9(bag)
  await runSessionsStep10(bag)
  await runSessionsStep11(bag)
  await runSessionsStep12(bag)
  await runSessionsStep13(bag)
  await runSessionsStep14(bag)
  assertSuiteInvariants('sessions', bag)
}
