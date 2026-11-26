/* oxlint-disable no-await-in-loop -- 每次重试必须等待前一次替换失败，不得并发覆盖文件。 */
import { rename } from 'node:fs/promises'

/** Windows 的杀毒扫描或文件预览会短暂占用目标；只重试瞬态错误，失败保留原文件。 */
export async function renameWithRetry(
  source: string,
  destination: string,
  options: {
    platform?: NodeJS.Platform
    rename?: typeof rename
    wait?: (ms: number) => Promise<void>
  } = {},
): Promise<void> {
  const move = options.rename ?? rename
  const wait = options.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  for (let attempt = 0; ; attempt += 1) {
    try {
      await move(source, destination)
      return
    } catch (error) {
      if (
        (options.platform ?? process.platform) !== 'win32' ||
        attempt >= 8 ||
        !['EACCES', 'EBUSY', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')
      )
        throw error
    }
    // 重试需保留同一个临时文件，不能通过删除原目标绕过占用或权限错误。
    await wait(Math.min(20 * 2 ** attempt, 200))
  }
}
