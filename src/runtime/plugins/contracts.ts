import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'

import type { MydshPluginInfo } from '../../shared/plugins.ts'
export type { MydshPluginManifest, MydshPluginInfo } from '../../shared/plugins.ts'

export interface MydshPluginServicesConfig {
  home: string
  nodeExecutable: string
  toolchainDirectory: string
  /** 转换命令归属 Runtime 的统一子进程监督器。 */
  subprocess?: Pick<SubprocessRuntime, 'spawn'>
  /** 宿主报告任务或未保存内容占用；插件管理器不猜测业务状态。 */
  isBusy?: (id: string) => string | undefined | Promise<string | undefined>
  onChange?: () => void
  builtin?: Array<Omit<MydshPluginInfo, 'running'> & { running?: boolean }>
}

export type ConversionSource =
  | { kind: 'local'; path: string }
  | { kind: 'git'; url: string; ref: string }
  | { kind: 'npm'; name: string; version: string }

export interface ConversionRecord {
  id: string
  source: ConversionSource
  revision: string
  directory: string
  status: 'prepared' | 'validating' | 'validated' | 'failed' | 'installed'
  createdAt: string
  error?: string
  artifact?: string
  digest?: string
}

export const MYDSH_PLUGIN_ID = /^[a-z0-9][a-z0-9._-]*$/
export const MYDSH_PLUGIN_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

export function requirePluginId(value: string, allowCoreReference = false): string {
  if (!MYDSH_PLUGIN_ID.test(value) || value.length > 120)
    throw new Error('插件标识只能包含小写字母、数字、点、下划线和连字符。')
  if (!allowCoreReference && value.startsWith('mydsh.'))
    throw new Error('mydsh.* 是核心插件的保留标识，用户扩展不能使用。')
  return value
}
