/**
 * 设置中心「系统桌面操控」分区：运行在 renderer，展示桌面操控总开关、结构化系统权限检查清单与安全边界选项。
 * 所有权限读取、系统设置跳转与策略保存均经父组件回调转交受控桌面桥处理。
 */
import { Button, Select, Switch } from 'antd'
import { Cpu, ExternalLink, Hand, Monitor, RefreshCw } from 'lucide-react'
import {
  formatKillSwitchLabel,
  resolveKillSwitchShortcut,
  type AutomationPermissionStatus,
  type AutomationSettings as AutomationSettingsModel,
  type AutomationSettingsPatch,
} from '../../../../shared/automation.ts'
import { SettingRow, SettingsSection, StatusDot } from './SettingsPrimitives.tsx'

/** 系统权限检查面板所需的属性。 */
interface PermissionChecklistBlockProps {
  readonly permissions: AutomationPermissionStatus
  readonly refreshing: boolean
  onRefreshPermissions(): void
  onOpenPermission(kind: 'accessibility' | 'screen-recording'): void
}

function defaultPermissionNote(platform: AutomationPermissionStatus['platform']): string {
  if (platform === 'darwin') {
    return 'macOS 开启权限后若状态未刷新，请完全退出并重启 MyDSH 使授权生效。'
  }
  return 'Windows 无需单独授予屏幕录制权限；普通权限无法操控以管理员身份运行的窗口。'
}

function PermissionChecklistBlock({
  permissions,
  refreshing,
  onRefreshPermissions,
  onOpenPermission,
}: PermissionChecklistBlockProps) {
  const isMac = permissions.platform === 'darwin'
  const noteText = permissions.note ?? defaultPermissionNote(permissions.platform)

  return (
    <div className="automation-block-row">
      <div className="automation-block-header">
        <div className="automation-block-header__copy">
          <div className="automation-block-header__title-row">
            <strong>系统权限</strong>
          </div>
          <small>检查桌面操控所需的原生驱动与系统授权状态。</small>
        </div>
        <Button
          size="small"
          icon={
            <RefreshCw size={13} className={refreshing ? 'spin' : undefined} aria-hidden="true" />
          }
          disabled={refreshing}
          onClick={onRefreshPermissions}
        >
          刷新状态
        </Button>
      </div>

      <ul className="automation-permission-list" aria-label="系统权限状态清单">
        <li className="automation-permission-item">
          <span className="automation-permission-item__name">
            <Cpu size={14} aria-hidden="true" />
            <span>原生驱动</span>
          </span>
          <div className="automation-permission-item__state">
            <span
              className="automation-status-pill"
              data-state={permissions.nativeLoaded ? 'positive' : undefined}
            >
              <StatusDot state={permissions.nativeLoaded ? 'positive' : 'neutral'} />
              <span>{permissions.nativeLoaded ? '已就绪' : '未加载'}</span>
            </span>
          </div>
        </li>

        <li className="automation-permission-item">
          <span className="automation-permission-item__name">
            <Monitor size={14} aria-hidden="true" />
            <span>屏幕录制</span>
          </span>
          <div className="automation-permission-item__state">
            <span
              className="automation-status-pill"
              data-state={permissions.screenRecording ? 'positive' : 'warning'}
            >
              <StatusDot state={permissions.screenRecording ? 'positive' : 'warning'} />
              <span>{permissions.screenRecording ? '已授权' : '未授权'}</span>
            </span>
            {isMac && !permissions.screenRecording && (
              <Button
                size="small"
                aria-label="打开屏幕录制系统设置"
                icon={<ExternalLink size={12} aria-hidden="true" />}
                onClick={() => onOpenPermission('screen-recording')}
              >
                打开系统设置
              </Button>
            )}
          </div>
        </li>

        <li className="automation-permission-item">
          <span className="automation-permission-item__name">
            <Hand size={14} aria-hidden="true" />
            <span>辅助功能</span>
          </span>
          <div className="automation-permission-item__state">
            <span
              className="automation-status-pill"
              data-state={permissions.accessibility ? 'positive' : 'warning'}
            >
              <StatusDot state={permissions.accessibility ? 'positive' : 'warning'} />
              <span>{permissions.accessibility ? '已授权' : '未授权'}</span>
            </span>
            {isMac && !permissions.accessibility && (
              <Button
                size="small"
                aria-label="打开辅助功能系统设置"
                icon={<ExternalLink size={12} aria-hidden="true" />}
                onClick={() => onOpenPermission('accessibility')}
              >
                打开系统设置
              </Button>
            )}
          </div>
        </li>
      </ul>

      <p className="automation-permission-note">{noteText}</p>
    </div>
  )
}

/** 系统桌面操控配置分区属性。 */
export interface ComputerUseSectionProps {
  readonly settings: AutomationSettingsModel['computerUse']
  readonly permissions: AutomationPermissionStatus
  readonly saving: boolean
  readonly refreshing: boolean
  onPatch(patch: AutomationSettingsPatch): void
  onRefreshPermissions(): void
  onOpenPermission(kind: 'accessibility' | 'screen-recording'): void
}

/** 渲染系统桌面操控总开关、权限清单与安全边界配置分区。 */
export function ComputerUseSection({
  settings,
  permissions,
  saving,
  refreshing,
  onPatch,
  onRefreshPermissions,
  onOpenPermission,
}: ComputerUseSectionProps) {
  const killSwitchLabel = formatKillSwitchLabel(resolveKillSwitchShortcut(permissions.platform))

  return (
    <SettingsSection
      title="系统桌面操控"
      description={`允许 Agent 截屏、前置窗口并发送系统级鼠标与键盘操作。默认关闭，可随时按 ${killSwitchLabel} 急停。`}
    >
      <SettingRow
        title="启用桌面操控"
        description="自动屏蔽钥匙串、密码管理器、系统授权框与 MyDSH 自身窗口。"
      >
        <Switch
          aria-label="启用桌面操控"
          checked={settings.enabled}
          disabled={saving || !permissions.supported}
          onChange={enabled => onPatch({ computerUse: { enabled } })}
        />
      </SettingRow>

      <PermissionChecklistBlock
        permissions={permissions}
        refreshing={refreshing}
        onRefreshPermissions={onRefreshPermissions}
        onOpenPermission={onOpenPermission}
      />

      {settings.enabled && (
        <>
          <SettingRow
            title="操控范围"
            description="推荐限定在已授权的目标窗口内操作；完整显示器允许跨窗口操作整个屏幕。"
          >
            <Select
              className="automation-scope-select"
              aria-label="桌面操控范围"
              value={settings.scope}
              disabled={saving}
              options={[
                { value: 'window', label: '限定目标窗口（推荐）' },
                { value: 'display', label: '完整显示器' },
              ]}
              onChange={scope => onPatch({ computerUse: { scope } })}
            />
          </SettingRow>

          <SettingRow
            title="每步操作单独确认"
            description="关闭时按目标应用会话级授权；开启后每次点击、输入与快捷键均需确认。"
          >
            <Switch
              aria-label="每步操作单独确认"
              checked={settings.confirmEveryAction}
              disabled={saving}
              onChange={confirmEveryAction => onPatch({ computerUse: { confirmEveryAction } })}
            />
          </SettingRow>
        </>
      )}
    </SettingsSection>
  )
}
