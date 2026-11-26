import { Checkbox, Modal } from 'antd'
import {
  AlertTriangle,
  Check,
  ChevronUp,
  Eye,
  LoaderCircle,
  ListChecks,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useWorkspaceSnapshot, useWorkspaceStore } from '../../hooks/useWorkspace.ts'
import {
  PERMISSION_RISK_PRESETS,
  permissionPresetDescription,
  permissionPresetLabel,
  type PermissionPresetOption,
} from '../../domain/session-controls.ts'
import { AnchoredMenu } from '../../shared/ui/AnchoredMenu.tsx'
import { ElasticPress } from '../../shared/ui/ElasticPress.tsx'
import styles from './ComposerControls.module.css'

/** 模式切换使用运行时现有命令，正文草稿和附件不参与提交。 */
export function ModeSelector({ disabled = false }: { readonly disabled?: boolean }) {
  const store = useWorkspaceStore()
  const snapshot = useWorkspaceSnapshot()
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const dismiss = useCallback(() => {
    setOpen(false)
  }, [])
  const plan = snapshot.sessions.find(item => item.sessionId === snapshot.selectedSessionId)
    ?.projections?.values?.plan
  const active =
    typeof plan === 'object' && plan !== null && 'active' in plan && plan.active === true
  const pending =
    typeof plan === 'object' && plan !== null && 'pending' in plan && plan.pending === true
  const selected = pending ? !active : active
  const directory = snapshot.sessionCommandDirectory
  const available = directory?.value?.commands.some(command => command.name === 'plan') === true
  const loading = directory === undefined || ['idle', 'stale', 'loading'].includes(directory.status)
  const executing = ['submitting', 'running'].includes(
    snapshot.sessionCommandExecution?.phase ?? '',
  )

  useEffect(() => {
    setOpen(false)
  }, [snapshot.selectedSessionId, disabled])
  useEffect(() => {
    if (open) {
      void store.loadSessionCommandDirectory(snapshot.selectedSessionId, true)
    }
  }, [open, snapshot.selectedSessionId, store])

  const select = async (next: boolean) => {
    if (next === selected) {
      dismiss()
      return
    }
    const sessionId = snapshot.selectedSessionId
    if (sessionId === null || !available || executing) return
    if (await store.executeSessionCommand(next ? '/plan' : '/plan off', sessionId)) {
      dismiss()
      triggerRef.current?.focus()
    }
  }

  return (
    <div className={styles.control}>
      {selected ? (
        <ElasticPress>
          <button
            ref={triggerRef}
            type="button"
            className={styles.planChip}
            aria-label="退出 Plan 模式"
            title={pending ? 'Plan 模式将在下一步生效，点击退出' : '退出 Plan 模式'}
            disabled={disabled || executing || !available}
            data-plan-active="true"
            onClick={() => {
              void select(false)
            }}
          >
            <span>Plan</span>
            <X size={12} aria-hidden="true" />
          </button>
        </ElasticPress>
      ) : (
        <ElasticPress>
          <button
            ref={triggerRef}
            type="button"
            className={styles.trigger}
            aria-label="切换工作模式"
            title={
              pending
                ? `${selected ? 'Plan' : '普通模式'}将在下一步生效`
                : selected
                  ? 'Plan 模式'
                  : '普通模式'
            }
            aria-haspopup="menu"
            aria-expanded={open}
            disabled={disabled}
            data-plan-active={selected}
            onClick={() => {
              setOpen(value => !value)
            }}
          >
            {executing && snapshot.sessionCommandExecution?.name === 'plan' ? (
              <LoaderCircle className="spin" size={16} aria-hidden="true" />
            ) : (
              <ListChecks size={16} aria-hidden="true" />
            )}
            <span>{selected ? 'Plan' : '普通'}</span>
            <ChevronUp size={12} aria-hidden="true" />
          </button>
        </ElasticPress>
      )}
      <AnchoredMenu
        open={open}
        anchorRef={triggerRef}
        motion="morph"
        onDismiss={dismiss}
        label="工作模式"
        className={`${styles.menu} ${styles.modelMenu}`}
      >
        {loading ? (
          <p className={styles.empty} role="status">
            正在加载工作模式…
          </p>
        ) : !available ? (
          <p className={styles.menuError} role="status">
            {directory?.commandError ?? directory?.error ?? '当前预设未提供 Plan 模式'}
          </p>
        ) : (
          <>
            {[false, true].map(value => (
              <button
                key={String(value)}
                type="button"
                className={styles.modelOption}
                role="menuitemradio"
                aria-checked={selected === value}
                disabled={executing}
                onClick={() => {
                  void select(value)
                }}
              >
                <span>{value ? 'Plan 模式' : '普通模式'}</span>
                <Check
                  size={15}
                  className={selected === value ? undefined : styles.hiddenCheck}
                  aria-hidden="true"
                />
              </button>
            ))}
            {pending && <p className={styles.empty}>模式将在下一步生效</p>}
          </>
        )}
      </AnchoredMenu>
    </div>
  )
}

function permissionLabel(option: PermissionPresetOption | undefined, currentValue: string): string {
  if (option === undefined) return permissionPresetLabel(currentValue, currentValue)
  return permissionPresetLabel(option.value, option.name)
}

/**
 * 权限预设字形，与 DSH Web 的三态一致：只读、工作区写入、完全权限。
 * 部署自定义的预设没有对应字形，退回盾牌。
 */
function permissionGlyph(value: string): ReactNode {
  if (value === 'read-only') return <Eye size={15} aria-hidden="true" />
  if (value === 'danger-full-access' || value === 'auto')
    return <ShieldAlert size={15} aria-hidden="true" />
  return <ShieldCheck size={15} aria-hidden="true" />
}

/**
 * 权限预设胶囊，按 DSH Web 的成品形态：
 *
 * - 当前值来自会话的 `permissions` 投影，可选预设来自进程级 `permissionPresets` 目录；
 * - 两者任一未到达时整块不渲染，不做转圈占位（与 DSH Web 一致）；
 * - 完全权限与 Auto review 需要先勾选风险确认才能启用；
 * - 点击后先本地显示所选值，等运行核心的权限投影回来再以投影为准。
 */
export function PermissionSelector({ disabled = false }: { readonly disabled?: boolean }) {
  const store = useWorkspaceStore()
  const snapshot = useWorkspaceSnapshot()
  const [open, setOpen] = useState(false)
  const [pick, setPick] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const selection = snapshot.sessionPermission

  useEffect(() => {
    setOpen(false)
    setPick(null)
    setConfirming(null)
    setAcknowledged(false)
  }, [snapshot.selectedSessionId])

  useEffect(() => {
    if (
      !disabled &&
      selection !== null &&
      (confirming === null ||
        selection.options.some(option => option.value === confirming && option.selectable))
    )
      return
    setOpen(false)
    setConfirming(null)
    setAcknowledged(false)
  }, [confirming, disabled, selection])

  // 目录请求失败：触发器保留可点开的「权限不可用」，错误与重试放在菜单里，
  // 与 DSH Web 的目录加载失败面（弹出层内的错误条 + Retry）一致。
  if (selection === null) {
    const failed = snapshot.permissionCatalogError ?? null
    if (failed === null || !snapshot.selectedSessionId) return null
    return (
      <div className={styles.control}>
        <ElasticPress>
          <button
            ref={triggerRef}
            className={styles.trigger}
            type="button"
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label="权限不可用"
            title={failed}
            disabled={disabled}
            onClick={() => {
              setOpen(value => !value)
            }}
          >
            <ShieldAlert size={15} aria-hidden="true" />
            <span>权限不可用</span>
            <ChevronUp
              className={open ? styles.chevronOpen : undefined}
              size={13}
              aria-hidden="true"
            />
          </button>
        </ElasticPress>
        <AnchoredMenu
          open={open}
          anchorRef={triggerRef}
          motion="morph"
          className={`${styles.menu} ${styles.permissionMenu}`}
          label="选择访问模式"
          onDismiss={() => {
            setOpen(false)
          }}
        >
          <div className={styles.menuError} role="alert">
            <span>权限预设不可用：{failed}</span>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                void store.loadPermissionCatalog(true)
              }}
            >
              <RefreshCw size={13} aria-hidden="true" />
              重试
            </button>
          </div>
        </AnchoredMenu>
      </div>
    )
  }

  const projected = selection.options.find(option => option.value === selection.currentValue)
  // 本地待确认值：只有目录仍然公布它时才显示，避免把过期的选择留在界面上。
  const currentValue =
    pick !== null && selection.options.some(option => option.value === pick)
      ? pick
      : selection.currentValue
  const current = selection.options.find(option => option.value === currentValue)
  const currentLabel = permissionLabel(current, currentValue)
  const currentTitle = current === undefined ? undefined : permissionPresetDescription(current)
  const busy = pick !== null
  const blocked = disabled || snapshot.switchingPermissionPreset || busy

  const submit = (value: string): void => {
    setPick(value)
    void store
      .selectPermissionPreset(value, snapshot.selectedSessionId)
      .catch(() => false)
      .then(() => {
        setPick(null)
      })
  }

  const choose = (value: string): void => {
    setOpen(false)
    if (value === projected?.value) {
      return
    }
    // 风险确认独立于菜单，关闭后把焦点交回仍然存在的权限入口。
    if (PERMISSION_RISK_PRESETS.has(value)) {
      triggerRef.current?.focus()
      setOpen(false)
      setAcknowledged(false)
      setConfirming(value)
      return
    }
    submit(value)
  }

  const confirmOption =
    confirming === null ? undefined : selection.options.find(option => option.value === confirming)

  return (
    <div className={styles.control}>
      <ElasticPress>
        <button
          ref={triggerRef}
          className={styles.trigger}
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={`访问模式，当前：${currentLabel}`}
          title={currentTitle === undefined ? currentLabel : `${currentLabel}：${currentTitle}`}
          disabled={disabled || snapshot.switchingPermissionPreset}
          onClick={() => {
            setOpen(value => !value)
          }}
        >
          {snapshot.switchingPermissionPreset ? (
            <LoaderCircle className="spin" size={15} aria-hidden="true" />
          ) : (
            permissionGlyph(currentValue)
          )}
          <span>{currentLabel}</span>
          <ChevronUp
            className={open ? styles.chevronOpen : undefined}
            size={13}
            aria-hidden="true"
          />
        </button>
      </ElasticPress>
      <AnchoredMenu
        open={open}
        anchorRef={triggerRef}
        motion="morph"
        className={`${styles.menu} ${styles.permissionMenu}`}
        label="选择访问模式"
        onDismiss={() => {
          setOpen(false)
        }}
      >
        {selection.options.map(option => {
          const selected = option.value === projected?.value
          const description = permissionPresetDescription(option)
          return (
            <div className={styles.permissionOption} key={option.value}>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                aria-label={permissionLabel(option, option.value)}
                disabled={!option.selectable || blocked}
                onClick={() => {
                  choose(option.value)
                }}
              >
                <span className={styles.optionMark}>
                  {selected && <Check size={14} aria-hidden="true" />}
                </span>
                <span>
                  <strong>{permissionLabel(option, option.value)}</strong>
                  {description !== undefined && <small>{description}</small>}
                </span>
              </button>
            </div>
          )
        })}
      </AnchoredMenu>
      <Modal
        className={styles.permissionDialog!}
        classNames={{
          container: 'mydsh-glass-dialog',
          mask: 'mydsh-glass-mask',
          header: styles.permissionHeader!,
          footer: styles.permissionFooter!,
        }}
        title={
          <span className={styles.riskTitle}>
            <AlertTriangle size={20} aria-hidden="true" />
            {confirming === null ? '确认访问模式' : `${riskConfirmLabel(confirming)}？`}
          </span>
        }
        open={confirming !== null}
        centered
        width="min(440px, calc(100vw - 32px))"
        destroyOnHidden
        mask={{ closable: false }}
        focusable={{ trap: true, focusTriggerAfterClose: true }}
        okText={confirming === null ? '确认启用' : riskConfirmLabel(confirming)}
        cancelText="取消"
        cancelButtonProps={{ 'aria-label': '取消', className: styles.permissionCancel! }}
        okButtonProps={{
          danger: true,
          className: styles.permissionConfirm!,
          disabled: !acknowledged || blocked || confirmOption?.selectable !== true,
        }}
        onCancel={() => {
          setConfirming(null)
          setAcknowledged(false)
        }}
        onOk={() => {
          if (!acknowledged || blocked || confirmOption?.selectable !== true) return
          const value = confirmOption.value
          setConfirming(null)
          setAcknowledged(false)
          submit(value)
        }}
      >
        <p className={styles.riskDescription}>
          {confirming === null ? '' : riskWarning(confirming)}
        </p>
        <Checkbox
          className={styles.riskAcknowledgement!}
          checked={acknowledged}
          onChange={event => {
            setAcknowledged(event.target.checked)
          }}
        >
          我已了解风险，并愿意继续
        </Checkbox>
      </Modal>
    </div>
  )
}

/** 风险确认里的说明文案：完全权限关闭沙箱与审批，Auto review 另有实验性提示。 */
function riskWarning(value: string): string {
  if (value === 'auto-review')
    return '保留工作区沙箱，使用当前会话模型审核单次提权。低风险操作可能无需人工确认即可访问工作区外；高风险、判断不清或审核失败时仍需人工审批。审核会消耗额外 Token，AI 可能误判，不能替代安全隔离。'
  return value === 'auto'
    ? 'Auto review 不使用沙箱，并会消耗额外 token，可能误放行或误拒绝。'
    : '启用后，当前会话可直接修改文件、执行命令并访问工作区外的内容，不再逐次请求审批。'
}

/** 风险确认的启用按钮文案。 */
function riskConfirmLabel(value: string): string {
  if (value === 'auto-review') return '启用自动审核提权'
  return value === 'auto' ? '启用 Auto review' : '启用完全权限'
}

export { ModelSelector } from './ModelSelector.tsx'
