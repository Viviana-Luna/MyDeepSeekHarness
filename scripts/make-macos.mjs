import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PRODUCT_NAME } from '../lib/shared/product.js'
import { createMacosDmg } from './macos-hdiutil.mjs'

const root = resolve(import.meta.dirname, '..')
const packageManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const arch = process.env.MYDSH_ARCH ?? process.arch
if (arch !== 'arm64') throw new Error('当前安装包只支持 Apple Silicon arm64。')
const applicationPath = join(root, 'out', `${PRODUCT_NAME}-darwin-${arch}`, `${PRODUCT_NAME}.app`)
if (!existsSync(applicationPath))
  throw new Error('找不到已打包的 MyDSH.app，请先运行 package:mac。')

const dmgPath = join(root, 'out', 'make', `mydsh-macOS-${arch}-${packageManifest.version}.dmg`)
await createMacosDmg({
  applicationPath,
  dmgPath,
  volumeName: PRODUCT_NAME,
})
console.log(`make-macos: ${dmgPath}`)
