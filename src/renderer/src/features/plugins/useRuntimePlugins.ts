import { useCallback, useEffect, useRef, useState } from 'react'
import type { MydshPluginInfo } from '../../../../shared/plugins.ts'
import { getDesktopBridge } from '../../services/desktop.ts'

export type PluginOperation = 'install' | 'enable' | 'disable' | 'rollback' | 'uninstall'
const messageOf = (error: unknown) =>
  error instanceof Error
    ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
    : '插件操作失败'

/** 操作串行且由安装清单确认状态；订阅和迟到的读取随页面释放。 */
export function useRuntimePlugins() {
  const [plugins, setPlugins] = useState<readonly MydshPluginInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const mounted = useRef(false)
  const generation = useRef(0)
  const operating = useRef(false)
  const load = useCallback(async () => {
    const current = ++generation.current
    setLoading(true)
    try {
      const result = await getDesktopBridge().host.call('mydshPlugins.list', {})
      if (!Array.isArray(result)) throw new Error('插件清单格式无效')
      if (mounted.current && current === generation.current) {
        setPlugins(result as MydshPluginInfo[])
        setError(null)
      }
    } catch (reason) {
      if (mounted.current && current === generation.current) setError(messageOf(reason))
    } finally {
      if (mounted.current && current === generation.current) setLoading(false)
    }
  }, [])
  useEffect(() => {
    mounted.current = true
    void load()
    const release = getDesktopBridge().onFrontendPluginsChanged(() => {
      if (!operating.current) void load()
    })
    return () => {
      mounted.current = false
      generation.current++
      release()
    }
  }, [load])
  const operate = async (
    operation: PluginOperation,
    payload: { id: string } | { path: string },
  ): Promise<boolean> => {
    if (operating.current) return false
    operating.current = true
    setBusy('id' in payload ? payload.id : 'install')
    setError(null)
    setNotice('')
    try {
      await getDesktopBridge().host.call(`mydshPlugins.${operation}`, payload)
      if (mounted.current) {
        await load()
        setNotice('插件清单已更新。')
      }
      return true
    } catch (reason) {
      if (mounted.current) setError(messageOf(reason))
      return false
    } finally {
      operating.current = false
      if (mounted.current) setBusy(null)
    }
  }
  return {
    plugins,
    loading,
    error,
    busy,
    notice,
    load,
    operate,
    clearError: () => {
      setError(null)
    },
  }
}
