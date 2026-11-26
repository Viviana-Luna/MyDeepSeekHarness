/**
 * 设置中心「浏览器与桌面操控」配置页：运行在 renderer，管理内置浏览器、外置浏览器与系统桌面操控策略。
 * 通过受控桌面桥 `window.dshDesktop.automation` 读取与保存策略，并在组件卸载时释放状态订阅。
 */
import { Button } from 'antd'
import { AlertCircle, CheckCircle2, RefreshCw, ShieldAlert, Square, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  formatKillSwitchLabel,
  type AutomationDetectedBrowser,
  type AutomationRuntimeStatus,
  type AutomationSettingsPatch,
} from '../../../../shared/automation.ts'
import { EmbeddedBrowserSection, ExternalBrowserSection } from './AutomationBrowserSections.tsx'
import { ComputerUseSection } from './AutomationComputerUseSection.tsx'
import { CapabilityNotice } from './SettingsPrimitives.tsx'
import './automation-settings.css'

type AutomationBridge = NonNullable<NonNullable<typeof window.dshDesktop>['automation']>
type FeedbackState = { readonly type: 'error' | 'success'; readonly text: string } | null

const IPC_ERROR_PREFIX = /^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/u

function formatBridgeError(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback
  const cleaned = error.message.replace(IPC_ERROR_PREFIX, '').trim()
  return cleaned || fallback
}

function TakeoverAlertBanner({
  takeover,
  stopping,
  onStop,
}: {
  readonly takeover: AutomationRuntimeStatus['takeover']
  readonly stopping: boolean
  onStop(): void
}) {
  if (!takeover.active) return null
  const killLabel = formatKillSwitchLabel(takeover.killSwitchShortcut)

  return (
    <div className="automation-takeover-banner" role="alert">
      <div className="automation-takeover-banner__lead">
        <div className="automation-takeover-banner__emblem" aria-hidden="true">
          <ShieldAlert size={18} />
        </div>
        <div className="automation-takeover-banner__copy">
          <div className="automation-takeover-banner__title-row">
            <strong>Agent 正在接管：{takeover.targetLabel ?? '自动化任务'}</strong>
            <span className="automation-takeover-banner__steps">
              已执行 {takeover.stepCount} 步
            </span>
          </div>
          <p>
            <span>可随时按</span>
            <kbd className="automation-kbd">{killLabel}</kbd>
            <span>或点击右侧按钮立即停止。</span>
          </p>
        </div>
      </div>
      <Button
        className="automation-takeover-banner__action"
        danger
        type="primary"
        size="small"
        loading={stopping}
        icon={<Square size={12} aria-hidden="true" />}
        onClick={onStop}
      >
        立即停止
      </Button>
    </div>
  )
}

function FeedbackBanner({
  feedback,
  onClose,
}: {
  readonly feedback: NonNullable<FeedbackState>
  onClose(): void
}) {
  const isError = feedback.type === 'error'
  return (
    <div
      className="automation-feedback-banner"
      data-tone={feedback.type}
      role={isError ? 'alert' : 'status'}
    >
      <div className="automation-feedback-banner__content">
        {isError ? (
          <AlertCircle size={15} aria-hidden="true" />
        ) : (
          <CheckCircle2 size={15} aria-hidden="true" />
        )}
        <span>{feedback.text}</span>
      </div>
      <Button
        className="automation-feedback-banner__close"
        type="text"
        size="small"
        aria-label="关闭提示"
        icon={<X size={14} aria-hidden="true" />}
        onClick={onClose}
      />
    </div>
  )
}

function useAutomationSettingsState(bridge: AutomationBridge | undefined) {
  const [status, setStatus] = useState<AutomationRuntimeStatus | null>(null)
  const [browsers, setBrowsers] = useState<readonly AutomationDetectedBrowser[]>([])
  const [loading, setLoading] = useState(() => Boolean(bridge))
  const [saving, setSaving] = useState(false)
  const [detecting, setDetecting] = useState(false)
  const [testing, setTesting] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [feedback, setFeedback] = useState<FeedbackState>(null)
  const mountedRef = useRef(true)
  const requestIdRef = useRef(0)

  const reload = useCallback(async () => {
    if (!bridge) return
    const requestId = ++requestIdRef.current
    setLoading(true)
    try {
      const [nextStatus, detected] = await Promise.all([
        bridge.status(),
        bridge.detectBrowsers().catch(() => []),
      ])
      if (!mountedRef.current || requestId !== requestIdRef.current) return
      setStatus(nextStatus)
      setBrowsers(detected)
    } catch (error) {
      if (!mountedRef.current || requestId !== requestIdRef.current) return
      setFeedback({
        type: 'error',
        text: formatBridgeError(error, '无法读取浏览器与桌面操控设置'),
      })
    } finally {
      if (mountedRef.current && requestId === requestIdRef.current) setLoading(false)
    }
  }, [bridge])

  useEffect(() => {
    mountedRef.current = true
    void reload()
    if (!bridge) {
      return () => {
        mountedRef.current = false
      }
    }
    const offState = bridge.onStateChanged(takeover => {
      if (mountedRef.current) setStatus(current => (current ? { ...current, takeover } : current))
    })
    const offSettings = bridge.onSettingsChanged(settings => {
      if (mountedRef.current) setStatus(current => (current ? { ...current, settings } : current))
    })
    return () => {
      mountedRef.current = false
      offState()
      offSettings()
    }
  }, [bridge, reload])

  const runAction = async (
    setBusy: ((busy: boolean) => void) | null,
    fallbackError: string,
    task: () => Promise<void>,
  ) => {
    setBusy?.(true)
    setFeedback(null)
    try {
      await task()
    } catch (error) {
      if (mountedRef.current) {
        setFeedback({ type: 'error', text: formatBridgeError(error, fallbackError) })
      }
    } finally {
      if (mountedRef.current) setBusy?.(false)
    }
  }

  return {
    status,
    browsers,
    loading,
    saving,
    detecting,
    testing,
    stopping,
    feedback,
    clearFeedback: () => setFeedback(null),
    reload,
    applyPatch: (patch: AutomationSettingsPatch) =>
      runAction(setSaving, '保存设置失败', async () => {
        if (!bridge) return
        const nextSettings = await bridge.updateSettings(patch)
        if (mountedRef.current) {
          setStatus(current => (current ? { ...current, settings: nextSettings } : current))
        }
      }),
    detectBrowsers: () =>
      runAction(setDetecting, '探测本机浏览器失败', async () => {
        if (!bridge) return
        const detected = await bridge.detectBrowsers()
        if (!mountedRef.current) return
        setBrowsers(detected)
        setFeedback({
          type: 'success',
          text:
            detected.length > 0
              ? `已探测到 ${String(detected.length)} 个本机可用浏览器`
              : '未探测到常见浏览器，可手动填入可执行文件绝对路径',
        })
      }),
    testExternal: () =>
      runAction(setTesting, '外置浏览器连接测试失败', async () => {
        if (!bridge) return
        const result = await bridge.testExternalBrowser()
        if (!mountedRef.current) return
        const modeText = result.mode === 'managed' ? '托管隔离实例' : '本机调试端口'
        setFeedback({
          type: 'success',
          text: `已连接外置浏览器：${result.browser}（${modeText}，当前 ${String(result.targetCount)} 个页面）`,
        })
        await reload()
      }),
    stopTakeover: () =>
      runAction(setStopping, '停止接管失败', async () => {
        if (!bridge) return
        await bridge.stopTakeover()
      }),
    openPermission: (kind: 'accessibility' | 'screen-recording') =>
      runAction(null, '无法打开系统权限设置', async () => {
        if (!bridge) return
        const opened = await bridge.openPermissionSettings(kind)
        if (mountedRef.current && !opened) {
          setFeedback({
            type: 'error',
            text: '未能自动打开系统设置，请手动前往系统设置 -> 隐私与安全性完成授权。',
          })
        }
      }),
  }
}

/** 渲染「浏览器与桌面操控」桌面设置页。 */
export function AutomationSettings() {
  const bridge = window.dshDesktop?.automation
  const controller = useAutomationSettingsState(bridge)

  return (
    <div
      className="settings-page automation-page"
      data-automation-settings
      aria-labelledby="automation-settings-heading"
    >
      <header className="settings-page__heading">
        <h2 id="automation-settings-heading">浏览器与桌面操控</h2>
        <p>管理 Agent 使用内置浏览器、外置浏览器与系统桌面操控的授权和安全边界。</p>
      </header>

      {!bridge ? (
        <CapabilityNotice title="仅桌面客户端可用">
          浏览器与桌面操控需要本机桌面权限，当前环境不支持配置。
        </CapabilityNotice>
      ) : (
        <>
          {controller.status && (
            <TakeoverAlertBanner
              takeover={controller.status.takeover}
              stopping={controller.stopping}
              onStop={() => void controller.stopTakeover()}
            />
          )}

          {controller.status?.settings.warning && (
            <CapabilityNotice title="部分自动化设置已安全回退" tone="warning">
              {controller.status.settings.warning}
            </CapabilityNotice>
          )}

          {controller.feedback && (
            <FeedbackBanner feedback={controller.feedback} onClose={controller.clearFeedback} />
          )}

          {!controller.status && controller.loading && (
            <CapabilityNotice title="正在读取浏览器与桌面操控设置">
              设置由桌面客户端校验并保存在本机。
            </CapabilityNotice>
          )}

          {!controller.status && !controller.loading && (
            <div className="automation-retry-bar">
              <Button
                size="small"
                icon={<RefreshCw size={13} aria-hidden="true" />}
                onClick={() => void controller.reload()}
              >
                重新加载设置
              </Button>
            </div>
          )}

          {controller.status && (
            <>
              <EmbeddedBrowserSection
                settings={controller.status.settings.embeddedBrowser}
                saving={controller.saving}
                onPatch={patch => void controller.applyPatch(patch)}
              />
              <ExternalBrowserSection
                settings={controller.status.settings.externalBrowser}
                browsers={controller.browsers}
                connected={controller.status.externalConnected}
                targetLabel={controller.status.externalTargetLabel}
                saving={controller.saving}
                detecting={controller.detecting}
                testing={controller.testing}
                onPatch={patch => void controller.applyPatch(patch)}
                onDetect={() => void controller.detectBrowsers()}
                onTest={() => void controller.testExternal()}
              />
              <ComputerUseSection
                settings={controller.status.settings.computerUse}
                permissions={controller.status.permissions}
                saving={controller.saving}
                refreshing={controller.loading}
                onPatch={patch => void controller.applyPatch(patch)}
                onRefreshPermissions={() => void controller.reload()}
                onOpenPermission={kind => void controller.openPermission(kind)}
              />
            </>
          )}
        </>
      )}
    </div>
  )
}
