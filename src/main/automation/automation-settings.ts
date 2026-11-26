/**
 * 主进程自动化设置持久化仓库：运行在 Electron 主进程，原子读写 `~/.mydsh/config/automation.json`。
 * 仅保存经边界校验的公开策略，不保存凭据；损坏配置自动降级并保留原文件以供排查。
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import {
  cloneAutomationSettings,
  createDefaultAutomationSettings,
  normalizeAutomationSettings,
  type AutomationSettings,
  type AutomationSettingsPatch,
} from '../../shared/automation.ts'

/** 自动化设置持久化控制器。 */
export interface AutomationSettingsStore {
  read(): AutomationSettings
  update(patch: AutomationSettingsPatch): AutomationSettings
}

function renameAtomic(source: string, destination: string): void {
  const retryable = new Set(['EPERM', 'EBUSY', 'EACCES'])
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      renameSync(source, destination)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (process.platform !== 'win32' || !code || !retryable.has(code) || attempt === 4) {
        throw error
      }
    }
  }
}

function writeAtomicJson(filePath: string, value: AutomationSettings): void {
  const dir = dirname(filePath)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tempPath = join(dir, `.automation-${randomUUID()}.tmp`)
  const payload = `${JSON.stringify(value, null, 2)}\n`
  try {
    writeFileSync(tempPath, payload, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    renameAtomic(tempPath, filePath)
    if (process.platform !== 'win32') {
      chmodSync(filePath, 0o600)
    }
  } finally {
    rmSync(tempPath, { force: true })
  }
}

function loadInitialSettings(filePath: string): AutomationSettings {
  if (!existsSync(filePath)) return createDefaultAutomationSettings()
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'))
    return normalizeAutomationSettings(parsed)
  } catch (error) {
    const fallback = createDefaultAutomationSettings()
    fallback.warning =
      error instanceof Error
        ? `自动化配置文件损坏，已暂时回退为默认关闭状态：${error.message}`
        : '自动化配置文件损坏，已暂时回退为默认关闭状态。'
    return fallback
  }
}

/** 创建基于指定配置文件路径的自动化设置存储。 */
export function createAutomationSettingsStore(filePath: string): AutomationSettingsStore {
  let current = loadInitialSettings(filePath)
  return {
    read(): AutomationSettings {
      return cloneAutomationSettings(current)
    },
    update(patch: AutomationSettingsPatch): AutomationSettings {
      const next = normalizeAutomationSettings(patch, current)
      writeAtomicJson(filePath, next)
      current = next
      return cloneAutomationSettings(current)
    },
  }
}
