/**
 * 文件树、代码编辑器、全文搜索、项目任务、Git 与终端验收套件。
 */
import { type LocalVerifyState, assertSuiteInvariants } from './state.ts'
import {
  runFilesScmStep1,
  runFilesScmStep2,
  runFilesScmStep3,
  runFilesScmStep4,
  runFilesScmStep5,
  runFilesScmStep6,
  runFilesScmStep7,
  runFilesScmStep8,
} from './files-scm-part-1.ts'
import { runFilesScmStep9 } from './files-scm-part-2.ts'

/** 运行 files-scm 验收套件。 */
export async function runFilesScmSuite(bag: LocalVerifyState): Promise<void> {
  await runFilesScmStep1(bag)
  await runFilesScmStep2(bag)
  await runFilesScmStep3(bag)
  await runFilesScmStep4(bag)
  await runFilesScmStep5(bag)
  await runFilesScmStep6(bag)
  await runFilesScmStep7(bag)
  await runFilesScmStep8(bag)
  await runFilesScmStep9(bag)
  assertSuiteInvariants('files-scm', bag)
}
