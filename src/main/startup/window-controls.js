// 启动页只有固定窗口按钮；不访问业务设置或暴露任意 IPC。
const api = window.dshDesktop?.window
const update = state => {
  const bounds = document.body.getBoundingClientRect()
  const scale = window.devicePixelRatio || 1
  const clip = state.canvasComposition === 'acrylic' ? state.canvasClip : undefined
  document.documentElement.style.setProperty(
    '--window-clip-radius',
    `${clip === undefined ? (state.canvasComposition === 'acrylic' ? state.cornerRadius : 0) : clip.radius / scale}px`,
  )
  document.documentElement.style.setProperty(
    '--window-clip-right',
    `${clip === undefined ? 0 : Math.max(0, bounds.width - clip.width / scale)}px`,
  )
  document.documentElement.style.setProperty(
    '--window-clip-bottom',
    `${clip === undefined ? 0 : Math.max(0, bounds.height - clip.height / scale)}px`,
  )
  const maximize = document.querySelector('[data-window-action="toggle-maximize"]')
  const minimize = document.querySelector('[data-window-action="minimize"]')
  if (maximize !== null) maximize.disabled = !state.maximizable
  if (minimize !== null) minimize.disabled = !state.minimizable
}
if (api !== undefined) {
  const stop = api.onChanged(update)
  void api.read().then(update, () => {})
  document.querySelectorAll('[data-window-action]').forEach(button => {
    button.addEventListener('click', () => {
      void api.act(button.dataset.windowAction).catch(() => {
        document.getElementById('window-control-error').textContent = '窗口操作失败，请重试'
      })
    })
  })
  window.addEventListener('pagehide', stop, { once: true })
}
