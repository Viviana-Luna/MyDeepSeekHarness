/** 后台区分可公开的 AI 提交校验错误与不可信的 Git、文件系统和模型异常，不保存原始正文。 */

/** 仅接受 MyDSH 自有提示及可信元数据（如提交标识和恢复路径），不包装原始异常链。 */
export class GitAiError extends Error {}

/** 分阶段保留可信提示，其他异常只显示固定文案，避免统一兜底掩盖失败阶段。 */
export async function gitAiAnalysisStep<T>(
  message: string,
  action: () => T | Promise<T>,
): Promise<T> {
  try {
    return await action()
  } catch (error) {
    if (error instanceof GitAiError) throw error
    throw new GitAiError(message)
  }
}
