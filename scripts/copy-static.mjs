import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { createStartupScreenDocument } from '../lib/main/startup/startup-screen.js'

mkdirSync(new URL('../lib/preload/', import.meta.url), { recursive: true })

for (const [source, target] of [
  ['../src/preload/index.cjs', '../lib/preload/index.cjs'],
  ['../src/main/startup/window-controls.js', '../lib/startup-window-controls.js'],
  ['../src/renderer/src/styles/window-controls.css', '../lib/window-controls.css'],
  ['../assets/app-icon.png', '../lib/app-icon.png'],
  // 启动页使用定稿插画，构建时沿用启动页读取的文件名。
  ['../assets/startup-light-soft.png', '../lib/startup-light.png'],
  ['../assets/startup-dark-soft.png', '../lib/startup-dark.png'],
]) {
  copyFileSync(new URL(source, import.meta.url), new URL(target, import.meta.url))
}

writeFileSync(
  new URL('../lib/startup.html', import.meta.url),
  createStartupScreenDocument(
    {
      light: 'startup-light.png',
      dark: 'startup-dark.png',
    },
    'system',
    process.platform,
  ),
)
