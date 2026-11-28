/**
 * 修补 Windows `node-pty`：固定 ConPTY DLL 关闭路径（无尾部输出时仍结束工作线程），
 * 并兼容 `runtime.asar` 下 `conoutSocketWorker.js` 的解包目录定位。
 * 运行在离线核心构建进程。
 */
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * 按版本向目标 `node-pty` 目录注入 ConPTY 工作线程释放与 `runtime.asar` 解包路径补丁。
 * @param {string} directory 已复制到构建暂存区的 `node-pty` 目录。
 * @param {string} version `node-pty` 的 `package.json` 版本号。
 */
export async function patchNodePty(directory, version) {
  const conoutPath = join(directory, 'lib/windowsConoutConnection.js')
  if (existsSync(conoutPath)) {
    const conoutSource = await readFile(conoutPath, 'utf8')
    const asarTarget = "__dirname.replace('node_modules.asar', 'node_modules.asar.unpacked')"
    const asarReplacement =
      "__dirname.replace('node_modules.asar', 'node_modules.asar.unpacked').replace('runtime.asar', 'runtime.asar.unpacked')"
    if (conoutSource.includes(asarTarget) && !conoutSource.includes("'runtime.asar.unpacked'")) {
      await writeFile(conoutPath, conoutSource.replace(asarTarget, asarReplacement))
    }
  }
  if (version === '1.1.0') return
  if (version !== '1.2.0-beta.15') throw new Error('node-pty 版本变化，需要复核 ConPTY 释放补丁')
  const agentPath = join(directory, 'lib/windowsPtyAgent.js')
  const source = await readFile(agentPath, 'utf8')
  const before =
    "            this._ptyNative.kill(this._pty, this._useConptyDll);\n            this._outSocket.on('data', function () {"
  const after =
    "            this._ptyNative.kill(this._pty, this._useConptyDll);\n            // MyDSH：没有尾部输出时仍然在缓冲期后关闭工作线程。\n            this._conoutSocketWorker.dispose();\n            this._outSocket.on('data', function () {"
  if (source.split(before).length !== 2) throw new Error('node-pty ConPTY 关闭补丁的源码不匹配')
  await writeFile(agentPath, source.replace(before, after))
}
