/** 渲染进程中的消息与代码块共用剪贴板写入。 */
/** 写入系统剪贴板；浏览器接口不可用时尝试同步复制并恢复焦点。 */
export async function writeClipboard(text: string): Promise<boolean> {
  const browserClipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
  if (typeof browserClipboard?.writeText === 'function') {
    try {
      await browserClipboard.writeText(text)
      return true
    } catch {
      // DSH Web 会继续尝试同步 copy 命令，sandboxed Electron 也需要这条回退。
    }
  }

  if (
    typeof document === 'undefined' ||
    typeof document.execCommand !== 'function' ||
    document.body === null
  ) {
    return false
  }
  const activeElement = document.activeElement
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.left = '-9999px'
  document.body.appendChild(textarea)
  textarea.select()
  try {
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    textarea.remove()
    if (activeElement instanceof HTMLElement) activeElement.focus({ preventScroll: true })
  }
}
