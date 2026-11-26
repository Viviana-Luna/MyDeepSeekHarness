/**
 * 设置中心「内置浏览器」与「外置浏览器」分组面板。
 * 运行在 renderer，负责网站白名单/黑名单、托管浏览器路径与本机调试端口草稿缓冲，统一通过回调提交局部配置补丁。
 */
import { Button, Input, InputNumber, Segmented, Select, Switch } from 'antd'
import { AlertCircle, PlugZap, RefreshCw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type {
  AutomationDetectedBrowser,
  AutomationSettings as AutomationSettingsModel,
  AutomationSettingsPatch,
} from '../../../../shared/automation.ts'
import { AutomationOriginList } from './AutomationOriginList.tsx'
import { SettingRow, SettingsSection, StatusDot } from './SettingsPrimitives.tsx'

function isValidAttachPort(value: number | null): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1024 && value <= 65535
}

interface ExternalBrowserConnectionBlockProps {
  readonly settings: AutomationSettingsModel['externalBrowser']
  readonly browsers: readonly AutomationDetectedBrowser[]
  readonly saving: boolean
  readonly detecting: boolean
  onPatch(patch: AutomationSettingsPatch): void
  onDetect(): void
}

function ManagedBrowserBlock({
  settings,
  browsers,
  saving,
  detecting,
  onPatch,
  onDetect,
}: ExternalBrowserConnectionBlockProps) {
  const savedExecutablePath = settings.executablePath ?? ''
  const [pathDraft, setPathDraft] = useState(savedExecutablePath)

  useEffect(() => {
    setPathDraft(savedExecutablePath)
  }, [savedExecutablePath])

  const normalizedDraft = pathDraft.trim() || null
  const isPathDirty = normalizedDraft !== settings.executablePath

  const commitExecutablePath = () => {
    if (isPathDirty) {
      onPatch({ externalBrowser: { executablePath: normalizedDraft } })
    }
  }

  return (
    <div className="automation-block-row">
      <div className="automation-block-header">
        <div className="automation-block-header__copy">
          <div className="automation-block-header__title-row">
            <strong>目标浏览器</strong>
          </div>
          <small>
            留空时自动选择本机已安装的 Chrome、Edge、Brave 或 Chromium，也可手动指定可执行文件路径。
          </small>
        </div>
      </div>

      <div className="automation-connection-stack">
        <div className="automation-control-row">
          <Select
            allowClear
            aria-label="选择本机浏览器"
            placeholder="自动选择本机已安装浏览器"
            value={settings.executablePath ?? undefined}
            disabled={saving}
            options={browsers.map(item => ({
              value: item.executablePath,
              label: item.name,
            }))}
            onChange={value => onPatch({ externalBrowser: { executablePath: value ?? null } })}
          />
          <Button
            icon={<RefreshCw size={13} aria-hidden="true" />}
            loading={detecting}
            disabled={saving}
            onClick={onDetect}
          >
            重新探测
          </Button>
        </div>

        <div className="automation-control-row">
          <Input
            allowClear
            aria-label="自定义浏览器可执行路径"
            placeholder="自定义可执行文件绝对路径（选填）"
            value={pathDraft}
            disabled={saving}
            onChange={event => setPathDraft(event.target.value)}
            onPressEnter={commitExecutablePath}
          />
          <Button disabled={saving || !isPathDirty} onClick={commitExecutablePath}>
            应用路径
          </Button>
        </div>
      </div>
    </div>
  )
}

function AttachedPortBlock({
  settings,
  saving,
  onPatch,
}: {
  readonly settings: AutomationSettingsModel['externalBrowser']
  readonly saving: boolean
  onPatch(patch: AutomationSettingsPatch): void
}) {
  const savedPort = settings.attachPort ?? 9222
  const [portDraft, setPortDraft] = useState<number | null>(savedPort)
  const [hasInputError, setHasInputError] = useState(false)
  const committedPortRef = useRef(savedPort)
  const rawTextRef = useRef(String(savedPort))

  useEffect(() => {
    committedPortRef.current = savedPort
    rawTextRef.current = String(savedPort)
    setPortDraft(savedPort)
    setHasInputError(false)
  }, [savedPort])

  const isValid = isValidAttachPort(portDraft)
  const isDirty = isValid && portDraft !== savedPort

  const handlePortInput = (text: string) => {
    const trimmed = text.trim()
    rawTextRef.current = trimmed
    if (!trimmed) {
      setPortDraft(null)
      setHasInputError(false)
      return
    }
    if (!/^\d+$/u.test(trimmed)) {
      setPortDraft(null)
      setHasInputError(true)
      return
    }
    const parsed = Number(trimmed)
    setPortDraft(parsed)
    setHasInputError(!isValidAttachPort(parsed))
  }

  const handlePortChange = (value: number | string | null) => {
    if (typeof value === 'number') {
      rawTextRef.current = String(value)
      setPortDraft(value)
      setHasInputError(!isValidAttachPort(value))
      return
    }
    // 键入越界中间值（如正在输入 8080 时的 80）时 InputNumber 会回调 null，保留输入态以免清空或抹掉校验提示。
    if (rawTextRef.current === '') {
      setPortDraft(null)
      setHasInputError(false)
    }
  }

  const commitPort = () => {
    if (!isValidAttachPort(portDraft)) {
      rawTextRef.current = String(savedPort)
      setPortDraft(savedPort)
      setHasInputError(false)
      return
    }
    if (portDraft !== committedPortRef.current) {
      committedPortRef.current = portDraft
      rawTextRef.current = String(portDraft)
      setHasInputError(false)
      onPatch({ externalBrowser: { attachPort: portDraft } })
    }
  }

  return (
    <div className="automation-block-row">
      <div className="automation-block-header">
        <div className="automation-block-header__copy">
          <div className="automation-block-header__title-row">
            <strong>本机调试端口</strong>
          </div>
          <small>仅允许连接本机环回地址（1024–65535），修改后按回车、失焦或点击保存生效。</small>
        </div>
      </div>

      <div className="automation-port-row">
        <div className="automation-port-group">
          <span className="automation-port-prefix" aria-hidden="true">
            127.0.0.1:
          </span>
          <InputNumber
            className="automation-port-input"
            aria-label="外置浏览器调试端口"
            min={1024}
            max={65535}
            precision={0}
            changeOnBlur={false}
            value={portDraft}
            disabled={saving}
            onInput={handlePortInput}
            onChange={handlePortChange}
            onBlur={commitPort}
            onPressEnter={commitPort}
          />
        </div>
        <Button disabled={saving || !isDirty} onClick={commitPort}>
          保存端口
        </Button>
      </div>

      {hasInputError && (
        <p className="automation-inline-error" role="alert">
          <AlertCircle size={13} aria-hidden="true" />
          <span>端口号需为 1024 至 65535 之间的整数</span>
        </p>
      )}
    </div>
  )
}

/** 渲染内置隔离浏览器授权与网站规则配置分区。 */
export function EmbeddedBrowserSection({
  settings,
  saving,
  onPatch,
}: {
  readonly settings: AutomationSettingsModel['embeddedBrowser']
  readonly saving: boolean
  onPatch(patch: AutomationSettingsPatch): void
}) {
  return (
    <SettingsSection
      title="内置浏览器"
      description="直接操控 MyDSH 内置隔离浏览器，无需系统辅助功能权限。默认关闭。"
    >
      <SettingRow
        title="允许 Agent 操控内置浏览器"
        description="开启后，Agent 可在内置浏览器中打开页面、读取结构、截图、点击与填表。"
      >
        <Switch
          aria-label="允许 Agent 操控内置浏览器"
          checked={settings.enabled}
          disabled={saving}
          onChange={enabled => onPatch({ embeddedBrowser: { enabled } })}
        />
      </SettingRow>

      {settings.enabled && (
        <>
          <SettingRow
            title="本地开发地址免确认"
            description="访问 http://localhost 或 127.0.0.1 时直接放行；公网站点首次访问仍弹确认。"
          >
            <Switch
              aria-label="本地开发地址免确认"
              checked={settings.allowLocalhostWithoutConfirm}
              disabled={saving}
              onChange={allowLocalhostWithoutConfirm =>
                onPatch({ embeddedBrowser: { allowLocalhostWithoutConfirm } })
              }
            />
          </SettingRow>

          <AutomationOriginList
            title="信任网站白名单"
            description="命中白名单的网站免重复弹出确认，支持输入完整地址或批量粘贴。"
            inputAriaLabel="内置浏览器信任网站地址"
            addButtonAriaLabel="添加到内置浏览器信任白名单"
            placeholder="输入网站地址，例如 https://docs.example.com"
            emptyText="尚未添加信任网站，首次访问公网站点时将弹出确认。"
            origins={settings.allowedOrigins}
            saving={saving}
            onSave={allowedOrigins => onPatch({ embeddedBrowser: { allowedOrigins } })}
          />

          <AutomationOriginList
            title="禁止访问黑名单"
            badge="全局优先"
            tone="danger"
            description="优先级高于白名单，对内置与外置浏览器同时生效，命中后拒绝访问与操控。"
            inputAriaLabel="禁止访问网站地址"
            addButtonAriaLabel="添加到禁止访问黑名单"
            placeholder="输入禁止访问的网站地址，例如 https://bank.example.com"
            emptyText="尚未配置禁止访问的网站。"
            origins={settings.blockedOrigins}
            saving={saving}
            onSave={blockedOrigins => onPatch({ embeddedBrowser: { blockedOrigins } })}
          />
        </>
      )}
    </SettingsSection>
  )
}

/** 渲染外置浏览器授权、连接方式与网站白名单配置分区。 */
export function ExternalBrowserSection({
  settings,
  browsers,
  connected,
  targetLabel,
  saving,
  detecting,
  testing,
  onPatch,
  onDetect,
  onTest,
}: {
  readonly settings: AutomationSettingsModel['externalBrowser']
  readonly browsers: readonly AutomationDetectedBrowser[]
  readonly connected: boolean
  readonly targetLabel: string | null
  readonly saving: boolean
  readonly detecting: boolean
  readonly testing: boolean
  onPatch(patch: AutomationSettingsPatch): void
  onDetect(): void
  onTest(): void
}) {
  const connectedLabel = `已连接 · ${targetLabel ?? '外置浏览器'}`

  return (
    <SettingsSection
      title="外置浏览器"
      description="可拉起独立隔离的 Chrome / Edge 实例，或连接已开启调试端口的本机浏览器，无需安装浏览器扩展。"
    >
      <SettingRow
        title="允许 Agent 操控外置浏览器"
        description={
          connected
            ? '当前连接已就绪，关闭后将立即断开并释放托管实例。'
            : '关闭后立即释放托管实例，不连接外部调试端口。'
        }
      >
        <div className="automation-row-inline">
          {connected && (
            <span className="automation-status-pill" data-state="positive" title={connectedLabel}>
              <StatusDot state="positive" />
              <span className="automation-status-pill__text">{connectedLabel}</span>
            </span>
          )}
          <Switch
            aria-label="允许 Agent 操控外置浏览器"
            checked={settings.enabled}
            disabled={saving}
            onChange={enabled => onPatch({ externalBrowser: { enabled } })}
          />
        </div>
      </SettingRow>

      {settings.enabled && (
        <>
          <SettingRow
            title="连接方式"
            description="托管隔离实例使用独立配置并在退出时自动回收；调试端口模式连接本机已开启调试的浏览器。"
          >
            <Segmented<'managed' | 'attached'>
              className="automation-mode-segmented"
              aria-label="外置浏览器连接方式"
              disabled={saving}
              value={settings.mode}
              options={[
                { value: 'managed', label: '托管隔离实例（推荐）' },
                { value: 'attached', label: '连接本机调试端口' },
              ]}
              onChange={mode => onPatch({ externalBrowser: { mode } })}
            />
          </SettingRow>

          {settings.mode === 'managed' ? (
            <ManagedBrowserBlock
              settings={settings}
              browsers={browsers}
              saving={saving}
              detecting={detecting}
              onPatch={onPatch}
              onDetect={onDetect}
            />
          ) : (
            <AttachedPortBlock settings={settings} saving={saving} onPatch={onPatch} />
          )}

          <AutomationOriginList
            title="外置浏览器已信任网站"
            description="命中后外置浏览器访问该网站免重复确认；仍受禁止访问黑名单约束。"
            inputAriaLabel="外置浏览器信任网站地址"
            addButtonAriaLabel="添加到外置浏览器信任白名单"
            placeholder="输入网站地址，例如 https://app.example.com"
            emptyText="尚未添加外置浏览器信任网站。"
            origins={settings.allowedOrigins}
            saving={saving}
            onSave={allowedOrigins => onPatch({ externalBrowser: { allowedOrigins } })}
          />

          <SettingRow title="连通性检测" description="验证当前配置是否能正常连接外置浏览器。">
            <Button
              icon={<PlugZap size={13} aria-hidden="true" />}
              loading={testing}
              disabled={saving}
              onClick={onTest}
            >
              测试连接
            </Button>
          </SettingRow>
        </>
      )}
    </SettingsSection>
  )
}
