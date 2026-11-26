/**
 * lint 豁免清单门禁：保证 .oxlintrc.json 中的“待整理”豁免只减不增。
 *
 * 规模类规则（文件行数、函数行数、嵌套深度等）对尚未整理的旧文件逐条豁免，
 * 每条豁免是一个只关闭单条规则、列出具体文件路径的 override。
 * 本脚本临时去掉这些豁免重新检查清单中的文件：某个文件已不再违反对应规则，
 * 或文件已被删除时报告失败，要求同步删除该条目，防止清单长期残留。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const CONFIG_FILE = '.oxlintrc.json'
/**
 * 临时配置必须放在仓库根目录：oxlint 按配置文件所在目录解析 overrides 的路径模式，
 * 放到其他目录会让 `**\/*.tsx` 等规则失效，得到与正式检查不同的结果。
 */
const TEMPORARY_CONFIG_FILE = '.oxlintrc.verify-lint-debt.tmp.json'
const UNIX_REPORT_LINE = /^(.+?):\d+:\d+: .*\[(?:Error|Warning)\/eslint\(([^)]+)\)\]$/u

/**
 * 判断一个 override 是否是待整理豁免：只关闭规则，且列出的是具体文件而非路径模式。
 * `tests/**` 这类按目录放宽的规则属于长期策略，不计入清单。
 * @param {{ files: string[], rules: Record<string, unknown> }} override
 */
function isDebtOverride(override) {
  const onlyDisables = Object.values(override.rules).every(level => level === 'off')
  const listsFiles = override.files.every(pattern => !/[*?[\]{}]/u.test(pattern))
  return onlyDisables && listsFiles
}

/**
 * 用不含豁免的临时配置检查指定文件，返回每个文件实际违反的规则。
 * @param {object} config 去掉豁免后的完整配置。
 * @param {string[]} files 需要重新检查的文件。
 * @returns {Map<string, Set<string>>} 文件路径到规则名集合的映射。
 */
function lintWithoutDebt(config, files) {
  const configPath = join(root, TEMPORARY_CONFIG_FILE)
  writeFileSync(configPath, JSON.stringify(config))
  try {
    const oxlint = join(root, 'node_modules', '.bin', 'oxlint')
    const result = spawnSync(oxlint, ['-c', configPath, '--format', 'unix', ...files], {
      cwd: root,
      encoding: 'utf8',
      // Windows 上 node_modules/.bin 中是 .cmd 包装脚本，需要经由 shell 启动。
      shell: process.platform === 'win32',
    })
    if (result.error !== undefined) throw result.error
    const violations = new Map()
    for (const line of result.stdout.split('\n')) {
      const match = UNIX_REPORT_LINE.exec(line.trim())
      if (match === null) continue
      const [, file, rule] = match
      if (!violations.has(file)) violations.set(file, new Set())
      violations.get(file).add(rule)
    }
    return violations
  } finally {
    rmSync(configPath, { force: true })
  }
}

const config = JSON.parse(readFileSync(join(root, CONFIG_FILE), 'utf8'))
const debtOverrides = config.overrides.filter(isDebtOverride)
const strictConfig = {
  ...config,
  overrides: config.overrides.filter(override => !isDebtOverride(override)),
}
delete strictConfig.$schema

const failures = []
const debtFiles = [...new Set(debtOverrides.flatMap(override => override.files))]
const missingFiles = debtFiles.filter(file => !existsSync(join(root, file)))
for (const file of missingFiles) failures.push(`${file} 已不存在，请从 ${CONFIG_FILE} 的豁免中删除`)

const violations = lintWithoutDebt(
  strictConfig,
  debtFiles.filter(file => !missingFiles.includes(file)),
)
let entryCount = 0
for (const override of debtOverrides) {
  for (const rule of Object.keys(override.rules)) {
    for (const file of override.files) {
      entryCount += 1
      if (missingFiles.includes(file) || violations.get(file)?.has(rule)) continue
      failures.push(`${file} 已满足 ${rule}，请从 ${CONFIG_FILE} 的 ${rule} 豁免中删除`)
    }
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`verify-lint-debt: ${failure}`)
  process.exitCode = 1
} else {
  console.log(`verify-lint-debt: ${String(entryCount)} 条待整理豁免均仍有必要。`)
}
