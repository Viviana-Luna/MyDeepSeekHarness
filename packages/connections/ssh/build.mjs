import { cp, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { generatePluginTypert } from '../../runtime/plugin-typert.mjs'

/** 沿用既有 Typert 生成器，临时分析目录随构建结束清理。 */
export async function buildSsh(toolchain) {
  const temporary = await mkdtemp(join(tmpdir(), 'mydsh-ssh-contract-')),
    source = join(temporary, 'source')
  try {
    await cp(import.meta.dirname, source, {
      recursive: true,
      filter: path =>
        !['node_modules', 'lib'].some(name => path === join(import.meta.dirname, name)),
    })
    await symlink(
      join(toolchain, 'node_modules'),
      join(source, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    await writeFile(
      join(source, 'tsconfig.json'),
      JSON.stringify({
        extends: resolve(import.meta.dirname, '../../../tsconfig.json'),
        compilerOptions: { rootDir: 'src', noEmit: true },
        include: ['src'],
      }),
    )
    const result = await generatePluginTypert(source, import.meta.dirname, toolchain)
    if (!result.generated) throw new Error('SSH 服务未生成 Remote 契约')
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}
