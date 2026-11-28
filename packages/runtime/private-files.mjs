/**
 * MyDSH 私有配置目录读写隔离保护：拦截模型文件工具与受管派生进程对 `config/` 凭据与设置的访问。
 * 运行在后台 Runtime。
 */
import { basename, dirname, isAbsolute, relative, sep } from 'node:path'
import { canonicalRuntimePath as canonical } from './canonical-path.mjs'

function within(root, path) {
  const part = relative(root, path)
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`))
}

/**
 * 创建拒绝访问指定私有配置目录及其子项的路径守卫函数。
 * @param {string} directory 受保护的私有目录路径。
 * @returns {(path: string) => void} 越界访问时抛出中文错误的校验函数。
 */
export function privatePathGuard(directory) {
  const root = canonical(directory)
  return path => {
    if (within(root, canonical(path)))
      throw new Error('MyDSH 私有配置不对文件工具开放，请通过设置管理凭据。')
  }
}

/** 复用原文件后端；重新检查目标，避免直接传入 FsTarget 绕过 resolve。 */
export function privateFileSystem(Base, directory) {
  const check = privatePathGuard(directory)
  return class MydshFileSystem extends Base {
    async resolve(path, options) {
      const target = await super.resolve(path, options)
      check(target.targetKey)
      return target
    }
    async readText(target, ...args) {
      check(target.targetKey)
      return super.readText(target, ...args)
    }
    async streamText(target, ...args) {
      check(target.targetKey)
      return super.streamText(target, ...args)
    }
    async readBytes(target, ...args) {
      check(target.targetKey)
      return super.readBytes(target, ...args)
    }
    async readByteRange(target, ...args) {
      check(target.targetKey)
      return super.readByteRange(target, ...args)
    }
    async listDir(target, ...args) {
      check(target.targetKey)
      return super.listDir(target, ...args)
    }
    async writeText(target, ...args) {
      check(target.targetKey)
      return super.writeText(target, ...args)
    }
    async editText(target, ...args) {
      check(target.targetKey)
      return super.editText(target, ...args)
    }
  }
}

/** 所有 MyDSH 派生进程共用此限制，完全访问模式也不解除凭据保护。 */
export function privateProcessSpec(spec, directory) {
  if (process.platform !== 'darwin') return spec
  const root = canonical(directory)
  const parents = []
  for (let path = dirname(root); path !== dirname(path); path = dirname(path)) parents.push(path)
  const deny =
    ` (deny file-read* file-write* (subpath ${JSON.stringify(root)}))` +
    ` (deny file-write-unlink ${parents.map(path => `(literal ${JSON.stringify(path)})`).join(' ')})` +
    ' (deny appleevent-send)'
  // Seatbelt 不允许嵌套启动；把保护合入已有的写入沙箱，保留它的原始约束。
  if (basename(spec.argv[0]) === 'sandbox-exec' && spec.argv[1] === '-p' && spec.argv[3] === '--') {
    return { ...spec, argv: [spec.argv[0], '-p', spec.argv[2] + deny, ...spec.argv.slice(3)] }
  }
  return {
    ...spec,
    argv: ['/usr/bin/sandbox-exec', '-p', '(version 1) (allow default)' + deny, '--', ...spec.argv],
  }
}
