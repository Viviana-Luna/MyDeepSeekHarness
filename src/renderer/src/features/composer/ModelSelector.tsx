/** 输入区模型菜单：在同一层展示模型，把推理等级放在对应行的侧边。 */
import { Check, ChevronRight, ChevronUp, LoaderCircle, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState, type RefObject } from 'react'
import type {
  ModelCatalogModel,
  ModelSelection,
  SessionModels,
} from '../../domain/session-controls.ts'
import { useWorkspaceSnapshot, useWorkspaceStore } from '../../hooks/useWorkspace.ts'
import { AnchoredMenu } from '../../shared/ui/AnchoredMenu.tsx'
import { ElasticPress } from '../../shared/ui/ElasticPress.tsx'
import { ProviderBrandIcon } from '../settings/ProviderBrandIcon.tsx'
import styles from './ComposerControls.module.css'

interface EffortMenu {
  readonly provider: string
  readonly model: ModelCatalogModel
  readonly anchor: HTMLButtonElement
  readonly focus: boolean
}

function isCurrent(
  current: ModelSelection | undefined,
  provider: string,
  model: ModelCatalogModel,
) {
  return current?.provider === provider && current.model === model.id
}

function effortName(model: ModelCatalogModel, effort: string | undefined) {
  return model.reasoning?.efforts.find(option => option.id === effort)?.name ?? effort ?? '默认'
}

function selectionFor(
  provider: string,
  model: ModelCatalogModel,
  effort: string | undefined,
): ModelSelection {
  return { provider, model: model.id, ...(effort === undefined ? {} : { reasoningEffort: effort }) }
}

function ModelRows({
  directory,
  blocked,
  submenuId,
  active,
  onOpen,
  onSelect,
}: {
  directory: SessionModels
  blocked: boolean
  submenuId: string
  active: EffortMenu | null
  onOpen: (submenu: EffortMenu | null) => void
  onSelect: (selection: ModelSelection) => void
}) {
  return (
    <div className={styles.modelList}>
      {directory.failures.map(failure => (
        <p className={styles.menuError} role="alert" key={failure.id}>
          {failure.name}：{failure.message}
        </p>
      ))}
      {directory.groups.map(provider => (
        <section
          className={styles.modelGroup}
          role="group"
          aria-label={provider.name}
          key={provider.id}
        >
          <h3>
            <ProviderBrandIcon providerId={provider.id} displayName={provider.name} size="sm" />
            <span className={styles.providerGroupName}>{provider.name}</span>
          </h3>
          {provider.models.map(model => {
            const current = isCurrent(directory.current, provider.id, model)
            const effort =
              (current ? directory.current.reasoningEffort : undefined) ??
              model.reasoning?.defaultEffort
            const hasEfforts = (model.reasoning?.efforts.length ?? 0) > 0
            const expanded = active?.provider === provider.id && active.model.id === model.id
            return (
              <button
                className={styles.modelOption}
                type="button"
                role="menuitemradio"
                aria-label={model.name}
                aria-checked={current}
                aria-haspopup={hasEfforts ? 'menu' : undefined}
                aria-expanded={hasEfforts ? expanded : undefined}
                aria-controls={expanded ? submenuId : undefined}
                title={model.description ?? model.name}
                disabled={blocked}
                key={model.id}
                onMouseEnter={event => {
                  if (!blocked && !expanded)
                    onOpen(
                      hasEfforts
                        ? {
                            provider: provider.id,
                            model,
                            anchor: event.currentTarget,
                            focus: false,
                          }
                        : null,
                    )
                }}
                onKeyDown={event => {
                  if (!hasEfforts || event.key !== 'ArrowRight') return
                  event.preventDefault()
                  onOpen({ provider: provider.id, model, anchor: event.currentTarget, focus: true })
                }}
                onClick={event => {
                  if (hasEfforts)
                    onOpen({
                      provider: provider.id,
                      model,
                      anchor: event.currentTarget,
                      focus: true,
                    })
                  else onSelect(selectionFor(provider.id, model, effort))
                }}
              >
                <span className={styles.modelName}>{model.name}</span>
                {hasEfforts && (
                  <span className={styles.rowEffort}>{effortName(model, effort)}</span>
                )}
                {hasEfforts ? (
                  <ChevronRight size={14} aria-hidden="true" />
                ) : (
                  <Check
                    size={14}
                    aria-hidden="true"
                    className={current ? undefined : styles.hiddenCheck}
                  />
                )}
              </button>
            )
          })}
        </section>
      ))}
      {directory.groups.every(provider => provider.models.length === 0) && (
        <p className={styles.empty}>暂无可选模型，请先在设置中配置提供商。</p>
      )}
    </div>
  )
}

function EffortRows({
  active,
  current,
  blocked,
  onSelect,
}: {
  active: EffortMenu
  current: ModelSelection | undefined
  blocked: boolean
  onSelect: (selection: ModelSelection) => void
}) {
  const reasoning = active.model.reasoning
  if (!reasoning) return null
  const selected =
    (isCurrent(current, active.provider, active.model) ? current?.reasoningEffort : undefined) ??
    reasoning.defaultEffort
  const choices =
    reasoning.defaultEffort === undefined
      ? [
          { id: undefined, name: '默认', description: '使用提供商的默认推理等级' },
          ...reasoning.efforts,
        ]
      : reasoning.efforts
  return choices.map(effort => (
    <button
      className={styles.modelOption}
      type="button"
      role="menuitemradio"
      aria-checked={selected === effort.id}
      disabled={blocked}
      title={effort.description}
      key={effort.id ?? 'provider-default'}
      onClick={() => onSelect(selectionFor(active.provider, active.model, effort.id))}
    >
      <span className={styles.modelName}>{effort.name}</span>
      <Check
        size={14}
        aria-hidden="true"
        className={selected === effort.id ? undefined : styles.hiddenCheck}
      />
    </button>
  ))
}

function ModelMenuStatus({
  error,
  canRetry,
  loading,
  onRetry,
}: {
  readonly error: string | null
  readonly canRetry: boolean
  readonly loading: boolean
  readonly onRetry: () => void
}) {
  return (
    <>
      {error !== null && (
        <div className={styles.menuError} role="alert">
          <span>{error}</span>
          {canRetry && (
            <button
              type="button"
              role="menuitem"
              onClick={event => {
                // 请求开始后重试项会卸载，先把焦点交给仍在的菜单。
                event.currentTarget.closest<HTMLElement>('[role="menu"]')?.focus()
                onRetry()
              }}
            >
              <RefreshCw size={13} aria-hidden="true" />
              重试
            </button>
          )}
        </div>
      )}
      {loading && (
        <p className={styles.empty} role="status">
          正在读取模型列表…
        </p>
      )}
    </>
  )
}

function useModelSelectorDraft(options: {
  readonly disabled: boolean
  readonly dismiss: () => void
  readonly openRef: { current: boolean }
  readonly pendingOpenRef: { current: boolean }
  readonly setOpen: (open: boolean) => void
  readonly setDraftError: (error: string | null) => void
}) {
  const store = useWorkspaceStore()
  const snapshot = useWorkspaceSnapshot()
  const [preparingSession, setPreparingSession] = useState(false)
  const { disabled, dismiss, openRef, pendingOpenRef, setOpen, setDraftError } = options

  useEffect(() => {
    if (disabled) {
      dismiss()
      return
    }
    if (pendingOpenRef.current && snapshot.selectedSessionId !== null) {
      pendingOpenRef.current = false
      setDraftError(null)
      return
    }
    dismiss()
  }, [dismiss, snapshot.selectedSessionId, disabled, pendingOpenRef, setDraftError])

  const openDraftModels = useCallback(async () => {
    if (preparingSession || snapshot.creatingSession) return
    openRef.current = true
    pendingOpenRef.current = true
    setDraftError(null)
    setPreparingSession(true)
    setOpen(true)
    try {
      const sessionId = await store.ensureComposerSession?.()
      if (!openRef.current) return
      if (sessionId === null || sessionId === undefined) {
        pendingOpenRef.current = false
        setDraftError(store.getSnapshot?.()?.error ?? '无法创建新会话以读取模型列表')
        return
      }
      void store.loadSessionModels(false, sessionId)
    } finally {
      setPreparingSession(false)
    }
  }, [
    openRef,
    pendingOpenRef,
    preparingSession,
    setDraftError,
    setOpen,
    snapshot.creatingSession,
    store,
  ])

  return { preparingSession, openDraftModels }
}

function ModelTriggerButton({
  triggerRef,
  open,
  busy,
  disabled,
  label,
  modelLabel,
  effort,
  onClick,
}: {
  readonly triggerRef: RefObject<HTMLButtonElement | null>
  readonly open: boolean
  readonly busy: boolean
  readonly disabled: boolean
  readonly label: string
  readonly modelLabel: string
  readonly effort: string | undefined
  readonly onClick: () => void
}) {
  return (
    <ElasticPress>
      <button
        ref={triggerRef}
        className={`${styles.trigger} ${styles.modelTrigger}`}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-busy={busy}
        aria-label={`模型：${label}`}
        disabled={disabled}
        title={`模型：${label}`}
        onClick={onClick}
      >
        {busy && <LoaderCircle className="spin" size={15} aria-hidden="true" />}
        <span>
          {modelLabel}
          {effort !== undefined && <span className={styles.triggerEffort}> · {effort}</span>}
        </span>
        <ChevronUp className={open ? styles.chevronOpen : undefined} size={13} aria-hidden="true" />
      </button>
    </ElasticPress>
  )
}

/** 打开模型列表；选择强度时一次提交模型与等级，成功后归还输入区焦点。 */
export function ModelSelector({ disabled = false }: { readonly disabled?: boolean }) {
  const store = useWorkspaceStore()
  const snapshot = useWorkspaceSnapshot()
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState<EffortMenu | null>(null)
  const [draftError, setDraftError] = useState<string | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const openRef = useRef(false)
  const pendingOpenRef = useRef(false)
  const submenuId = useId()
  const directory = snapshot.sessionModels
  const current = directory?.current
  const model = directory?.groups
    .find(group => group.id === current?.provider)
    ?.models.find(option => option.id === current?.model)

  const dismiss = useCallback(() => {
    openRef.current = false
    pendingOpenRef.current = false
    setOpen(false)
    setActive(null)
    setDraftError(null)
  }, [])
  const { preparingSession, openDraftModels } = useModelSelectorDraft({
    disabled,
    dismiss,
    openRef,
    pendingOpenRef,
    setOpen,
    setDraftError,
  })
  const busyLoading = snapshot.loadingSessionModels || preparingSession
  const modelLabel = model?.name ?? current?.model ?? (busyLoading ? '读取模型…' : '选择模型')
  const effectiveEffort = current?.reasoningEffort ?? model?.reasoning?.defaultEffort
  const effort = model?.reasoning ? effortName(model, effectiveEffort) : undefined
  const label = effort === undefined ? modelLabel : `${modelLabel} · ${effort}`
  const blocked =
    disabled || snapshot.selectingSessionModel || preparingSession || snapshot.creatingSession

  const choose = async (selection: ModelSelection) => {
    if (blocked) return
    const unchanged =
      current?.provider === selection.provider &&
      current.model === selection.model &&
      effectiveEffort === selection.reasoningEffort
    if (unchanged || (await store.selectSessionModel(selection, snapshot.selectedSessionId))) {
      dismiss()
      triggerRef.current?.focus()
    }
  }
  const select = (selection: ModelSelection) => {
    void choose(selection)
  }
  const refresh = () => {
    if (snapshot.selectedSessionId === null) {
      void openDraftModels()
      return
    }
    void store.loadSessionModels(true, snapshot.selectedSessionId)
  }

  return (
    <div
      className={`${styles.control} ${styles.modelControl}`}
      onKeyDownCapture={event => {
        if (active && (event.key === 'Escape' || event.key === 'ArrowLeft')) {
          event.preventDefault()
          event.stopPropagation()
          active.anchor.focus()
          setActive(null)
        }
      }}
    >
      <ModelTriggerButton
        triggerRef={triggerRef}
        open={open}
        busy={busyLoading || snapshot.selectingSessionModel}
        disabled={disabled}
        label={label}
        modelLabel={modelLabel}
        effort={effort}
        onClick={() => {
          if (open) {
            dismiss()
            return
          }
          if (snapshot.selectedSessionId === null) {
            void openDraftModels()
            return
          }
          openRef.current = true
          setOpen(true)
          if (directory === null && !snapshot.loadingSessionModels) refresh()
        }}
      />
      <AnchoredMenu
        open={open}
        anchorRef={triggerRef}
        align="end"
        motion="morph"
        className={`${styles.menu} ${styles.modelMenu}`}
        label="选择模型"
        onDismiss={dismiss}
        submenu={
          active
            ? {
                id: submenuId,
                anchor: active.anchor,
                focus: active.focus,
                className: `${styles.menu} ${styles.effortMenu}`,
                label: `${active.model.name} 推理等级`,
                children: (
                  <EffortRows
                    active={active}
                    current={current}
                    blocked={blocked}
                    onSelect={select}
                  />
                ),
              }
            : undefined
        }
      >
        <ModelMenuStatus
          error={snapshot.sessionModelsError ?? draftError}
          canRetry={directory === null}
          loading={busyLoading}
          onRetry={refresh}
        />
        {directory && (
          <ModelRows
            directory={directory}
            blocked={blocked}
            submenuId={submenuId}
            active={active}
            onOpen={setActive}
            onSelect={select}
          />
        )}
        {directory !== null && !directory.routable && (
          <p className={styles.routeWarning} role="alert">
            当前提供商不可用，发送已暂停。
          </p>
        )}
      </AnchoredMenu>
    </div>
  )
}
