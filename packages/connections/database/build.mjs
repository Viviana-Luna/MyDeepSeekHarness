import { cp, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { generatePluginTypert } from '../../runtime/plugin-typert.mjs'

/** 只读数据库 Remote 沿用现有 Typert 契约生成器。 */
export async function buildDatabase(toolchain) {
  const temporary = await mkdtemp(join(tmpdir(), 'mydsh-database-contract-')),
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
    if (!result.generated) throw new Error('数据库服务未生成 Remote 契约')
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}
