import { useEffect, useRef, useState } from 'react'
import { getDesktopBridge } from '../services/desktop.ts'
import { FrontendPluginLoader } from './loader.ts'
import { useUiRuntime } from './react.tsx'

/** 后台清单变更驱动界面装卸；插件错误不会阻止内置工作台进入。 */
export function PluginLoader() {
  const runtime = useUiRuntime()
  const busyQueue = useRef(Promise.resolve())
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const bridge = getDesktopBridge()
    const send = (reasons: readonly string[]) => {
      busyQueue.current = busyQueue.current
        .then(() => bridge.setPluginBusyReasons([...reasons]))
        .catch(reason => {
          setError(reason instanceof Error ? reason.message : '无法同步插件占用状态')
        })
    }
    const unsubscribe = runtime.slots.subscribeBusy(() => {
      send(runtime.slots.busyReasons)
    })
    send(runtime.slots.busyReasons)
    return () => {
      unsubscribe()
      send([])
    }
  }, [runtime])
  useEffect(() => {
    let loader: FrontendPluginLoader
    try {
      loader = new FrontendPluginLoader(
        runtime,
        getDesktopBridge(),
        setError,
        () => busyQueue.current,
      )
      loader.start()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '界面插件加载失败')
      return
    }
    return () => {
      void loader.dispose()
    }
  }, [runtime])
  return error === null ? null : (
    <div className="project-workspace-alert">
      <div role="alert" className="app-alert">
        界面扩展加载失败：{error}
      </div>
    </div>
  )
}
