/**
 * 全局两级交互反馈委托（对齐 FlClash 分层体系）：
 * 1. 悬浮图标、胶囊、标签页、圆形/圆角控件 -> FlClash ElasticPress 弹性按压、跟手橡皮筋与轻触冲顶；
 * 2. 表单、设置页及弹窗操作栏等矩形按钮 -> iOS PressLook.tint 明暗轻压着色（不缩放变形）；
 * 3. 弹出菜单行、树/列表行、标签页拖拽与分隔柄 -> 自动避让，保证零抖动与原生拖放。
 */
import { ElasticPressMotion } from './elasticPressMotion.ts'
import { isPressDisabled, prefersReducedMotion, PressSession } from './elasticPressSession.ts'

/** 全局委托识别出的控件按压层级。 */
export type GlobalPressKind = 'elastic' | 'tint'

/** 全局委托目标分类结果。 */
export interface GlobalPressMatch {
  readonly target: HTMLElement
  readonly kind: GlobalPressKind
}

const CANDIDATE_SELECTOR = 'button, [role="button"], .ant-btn'

const EXCLUDED_ANCESTOR_SELECTOR = [
  '[data-no-elastic-press]',
  '.window-controls',
  '.session-tab',
  '.panel-divider',
  '.xterm',
  '.cm-editor',
  '.project-menu',
  '.project-focus-menu',
  '.right-island-overflow-menu',
  '.file-reference-menu',
  '.ant-dropdown-menu',
  '[role="menu"]',
  '[role="listbox"]',
].join(', ')

const EXCLUDED_SELF_SELECTOR = [
  '[role="menuitem"]',
  '[role="menuitemradio"]',
  '[role="menuitemcheckbox"]',
  '[role="option"]',
  '[role="treeitem"]',
  '[role="gridcell"]',
  '[role="separator"]',
  '[role="slider"]',
  '.session-row',
  '.tree-row',
  '.change-row',
  '.git-commit-row',
  '.git-commit-file-row',
  '.project-group-toggle',
  '.scm-resource-toggle',
  '.scm-pane-toggle',
  '.panel-divider__capsule',
  '.panel-resize-corner',
].join(', ')

/** FlClash PressLook.tint 分层：常规矩形表单、设置及弹窗底栏按钮。 */
const TINT_TARGET_SELECTOR = [
  '.ant-btn:not(.ant-btn-icon-only):not(.ant-btn-circle):not(.ant-btn-round)',
  '.settings-button',
  '.settings-dialog__actions > button',
  '.project-action-dialog__frame > footer button',
  '.ant-modal-footer button',
  '[role="dialog"] footer button',
].join(', ')

const MAX_ELASTIC_HEIGHT = 160
const TINT_RELEASE_CLEANUP_MS = 280

/**
 * 分类全局事件目标对应的手势反馈层级；显式受管、列表/菜单项及禁用控件返回 null。
 * @param eventTarget 原生指针事件命中的节点。
 */
export function classifyGlobalPressTarget(
  eventTarget: EventTarget | null,
): GlobalPressMatch | null {
  if (!(eventTarget instanceof Element)) return null
  const candidate = eventTarget.closest(CANDIDATE_SELECTOR)
  if (!(candidate instanceof HTMLElement) || !candidate.isConnected) return null
  if (candidate.dataset.elasticManaged === 'true') return null
  if (candidate.closest(EXCLUDED_ANCESTOR_SELECTOR) !== null) return null
  if (candidate.matches(EXCLUDED_SELF_SELECTOR)) return null
  if (isPressDisabled(candidate)) return null
  if (candidate.offsetHeight > MAX_ELASTIC_HEIGHT) return null
  const kind: GlobalPressKind = candidate.matches(TINT_TARGET_SELECTOR) ? 'tint' : 'elastic'
  return { target: candidate, kind }
}

/**
 * 查找应交由全局弹性按压接管的控件，排除表单矩形按钮、列表/菜单行与特殊容器。
 * @param eventTarget 原生指针事件命中的节点。
 */
export function findGlobalElasticTarget(eventTarget: EventTarget | null): HTMLElement | null {
  const match = classifyGlobalPressTarget(eventTarget)
  return match?.kind === 'elastic' ? match.target : null
}

/**
 * 管理 iOS PressLook.tint 轻压态：按下瞬间切换 active，松开切回 idle 并等待 250ms 过渡收尾。
 */
function createTintController() {
  let activeTarget: HTMLElement | null = null
  let activePointerId: number | null = null
  let idleTarget: HTMLElement | null = null
  let clearTimer: number | null = null

  const clearIdle = () => {
    if (clearTimer !== null) {
      window.clearTimeout(clearTimer)
      clearTimer = null
    }
    if (idleTarget !== null) {
      if (idleTarget.dataset.pressTint === 'idle') {
        delete idleTarget.dataset.pressTint
      }
      idleTarget = null
    }
  }

  const finish = () => {
    window.removeEventListener('pointerup', onPointerEnd, true)
    window.removeEventListener('pointercancel', onPointerEnd, true)
    window.removeEventListener('blur', finish)
    activePointerId = null
    const target = activeTarget
    activeTarget = null
    if (target === null || !target.isConnected) return
    clearIdle()
    target.dataset.pressTint = 'idle'
    idleTarget = target
    clearTimer = window.setTimeout(() => {
      clearTimer = null
      idleTarget = null
      if (target.dataset.pressTint === 'idle') {
        delete target.dataset.pressTint
      }
    }, TINT_RELEASE_CLEANUP_MS)
  }

  const onPointerEnd = (event: PointerEvent) => {
    if (activePointerId === null || event.pointerId !== activePointerId) return
    finish()
  }

  return {
    begin(event: PointerEvent, target: HTMLElement) {
      if (event.defaultPrevented || event.isPrimary === false || event.button !== 0) return
      if (prefersReducedMotion()) return
      finish()
      clearIdle()
      activeTarget = target
      activePointerId = event.pointerId
      target.dataset.pressTint = 'active'
      window.addEventListener('pointerup', onPointerEnd, true)
      window.addEventListener('pointercancel', onPointerEnd, true)
      window.addEventListener('blur', finish)
    },
    dispose() {
      clearIdle()
      if (activeTarget !== null) {
        delete activeTarget.dataset.pressTint
      }
      finish()
      clearIdle()
    },
  }
}

/**
 * 在应用根节点安装全局手势委托，统一提供 FlClash 弹性按压与 iOS 轻压着色反馈。
 * 悬停保持静止占位尺寸，避免紧凑工具条互相遮挡，同时与显式 NavigationDock 悬停预抬升分工明确。
 * 返回卸载清理函数，断开监听并收回所有仍在回弹的动画帧。
 */
export function installGlobalElasticPress(): () => void {
  const session = new PressSession()
  const tint = createTintController()
  const motions = new WeakMap<HTMLElement, ElasticPressMotion>()
  const runningMotions = new Set<ElasticPressMotion>()

  const getMotion = (target: HTMLElement): ElasticPressMotion => {
    const existing = motions.get(target)
    if (existing !== undefined) return existing
    const created = new ElasticPressMotion(target, () => {
      runningMotions.delete(created)
    })
    motions.set(target, created)
    return created
  }

  const onPointerDown = (event: PointerEvent) => {
    const match = classifyGlobalPressTarget(event.target)
    if (match === null) return
    if (match.kind === 'tint') {
      tint.begin(event, match.target)
      return
    }
    const motion = getMotion(match.target)
    session.begin(event, match.target, motion)
    if (motion.isActive()) runningMotions.add(motion)
  }

  const onClickCapture = (event: MouseEvent) => {
    session.interceptClick(event)
  }

  document.addEventListener('pointerdown', onPointerDown)
  window.addEventListener('click', onClickCapture, true)

  return () => {
    document.removeEventListener('pointerdown', onPointerDown)
    window.removeEventListener('click', onClickCapture, true)
    tint.dispose()
    session.dispose(false)
    const pendingMotions = Array.from(runningMotions)
    runningMotions.clear()
    for (const motion of pendingMotions) {
      motion.dispose()
    }
  }
}
