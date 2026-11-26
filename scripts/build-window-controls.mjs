import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

if (process.platform === 'win32') await import('./build-window-background.mjs')

if (process.platform === 'darwin') {
  const root = resolve(import.meta.dirname, '..')
  const { version } = JSON.parse(
    readFileSync(join(root, 'node_modules/electron/package.json'), 'utf8'),
  )
  const headers = join(homedir(), '.electron-gyp', version, 'include', 'node')
  if (!existsSync(join(headers, 'node_api.h'))) {
    throw new Error('缺少 Electron 原生模块头文件，请先完成 pnpm install 的原生依赖重建。')
  }
  const output = join(root, 'lib', 'main', 'window-controls.node')
  mkdirSync(join(root, 'lib', 'main'), { recursive: true })
  execFileSync(
    '/usr/bin/xcrun',
    [
      'clang',
      '-bundle',
      '-fobjc-arc',
      '-O2',
      '-Wall',
      '-Wextra',
      '-Werror',
      '-arch',
      process.arch === 'x64' ? 'x86_64' : process.arch,
      '-mmacosx-version-min=12.0',
      '-undefined',
      'dynamic_lookup',
      '-framework',
      'AppKit',
      '-I',
      headers,
      join(root, 'native', 'window-controls.m'),
      '-o',
      output,
    ],
    { stdio: 'inherit' },
  )
}
