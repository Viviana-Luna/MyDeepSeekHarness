/** 固定 node-pty 的 ConPTY DLL 关闭路径，保证无后续输出时也会结束输出工作线程。 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function patchNodePty(directory, version) {
  if (version !== '1.2.0-beta.15') throw new Error('node-pty 版本变化，需要复核 ConPTY 释放补丁')
  const path = join(directory, 'lib/windowsPtyAgent.js')
  const source = await readFile(path, 'utf8')
  const before =
    "            this._ptyNative.kill(this._pty, this._useConptyDll);\n            this._outSocket.on('data', function () {"
  const after =
    "            this._ptyNative.kill(this._pty, this._useConptyDll);\n            // MyDSH：没有尾部输出时仍然在缓冲期后关闭工作线程。\n            this._conoutSocketWorker.dispose();\n            this._outSocket.on('data', function () {"
  if (source.split(before).length !== 2) throw new Error('node-pty ConPTY 关闭补丁的源码不匹配')
  await writeFile(path, source.replace(before, after))
}
