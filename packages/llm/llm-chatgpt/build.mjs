/** 为独立订阅服务生成现有 Typert 契约；中间工作区只存在于系统临时目录。 */
import { cp, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { generatePluginTypert } from '../../runtime/plugin-typert.mjs'
export async function buildChatGPT(toolchain) {
  const temporary = await mkdtemp(join(tmpdir(), 'mydsh-chatgpt-contract-'))
  const source = join(temporary, 'source')
  const directory = import.meta.dirname
  try {
    await cp(directory, source, {
      recursive: true,
      filter: path => !['node_modules', 'lib'].some(name => path === join(directory, name)),
    })
    await symlink(
      join(toolchain, 'node_modules'),
      join(source, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    await writeFile(
      join(source, 'tsconfig.json'),
      JSON.stringify({
        extends: resolve(directory, '../../../tsconfig.json'),
        compilerOptions: { rootDir: 'src', noEmit: true },
        include: ['src'],
      }),
    )
    const result = await generatePluginTypert(source, directory, toolchain)
    if (!result.generated) throw new Error('ChatGPT 订阅服务未生成 Remote 契约')
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}
