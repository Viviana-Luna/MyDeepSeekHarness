import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PRODUCT_NAME } from '../lib/shared/product.js'

const root = resolve(import.meta.dirname, '..')
const packageManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const arch = process.env.MYDSH_ARCH ?? process.arch
if (arch !== 'arm64') throw new Error('当前安装包只支持 Apple Silicon arm64。')
const applicationPath = join(root, 'out', `${PRODUCT_NAME}-darwin-${arch}`, `${PRODUCT_NAME}.app`)
if (!existsSync(applicationPath))
  throw new Error('找不到已打包的 MyDSH.app，请先运行 package:mac。')

const makeDirectory = join(root, 'out', 'make')
mkdirSync(makeDirectory, { recursive: true })
const dmgPath = join(makeDirectory, `mydsh-macOS-${arch}-${packageManifest.version}.dmg`)
const temporaryDirectory = mkdtempSync(join(tmpdir(), 'mydsh-dmg-'))
// 最终重命名必须处于同一文件系统；这属于正式安装包的构建暂存，不是诊断产物。
const candidateDmg = join(makeDirectory, `.mydsh-${randomUUID()}.dmg`)

try {
  const volumeRoot = join(temporaryDirectory, PRODUCT_NAME)
  mkdirSync(volumeRoot, { recursive: true })
  execFileSync('/usr/bin/ditto', [applicationPath, join(volumeRoot, `${PRODUCT_NAME}.app`)], {
    stdio: 'inherit',
  })
  symlinkSync('/Applications', join(volumeRoot, 'Applications'))
  execFileSync(
    '/usr/bin/hdiutil',
    ['create', '-volname', PRODUCT_NAME, '-srcfolder', volumeRoot, '-format', 'UDZO', candidateDmg],
    { stdio: 'inherit' },
  )
  // 镜像完整生成后才替换同版本产物，hdiutil 失败不会破坏上次可用的 DMG。
  renameSync(candidateDmg, dmgPath)
  console.log(`make-macos: ${dmgPath}`)
} finally {
  rmSync(candidateDmg, { force: true })
  rmSync(temporaryDirectory, { recursive: true, force: true })
}
