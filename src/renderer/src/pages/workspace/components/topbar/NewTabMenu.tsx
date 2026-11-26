/**
 * 顶部工作标签栏「+」新建按钮与液态弹出菜单：仅通过点击或键盘触发展开，不响应悬停；
 * 菜单展开状态下再次点击按钮可直接收起菜单并创建主类型工作标签（如新建聊天）。
 * 运行在 renderer；以引用同步记录展开状态，确保快速连点时准确触发。
 */
import { Plus } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'

import { AnchoredMenu } from '../../../../shared/ui/AnchoredMenu.tsx'
import { ElasticPress } from '../../../../shared/ui/ElasticPress.tsx'

/** 新建工作标签菜单项定义。 */
export interface NewTabMenuItem {
  /** 标签类型键名。 */
  readonly key: string
  /** 菜单展示文案。 */
  readonly label: string
  /** 菜单左侧图标。 */
  readonly icon: ReactNode
  /** 当前环境不可用时禁用。 */
  readonly disabled: boolean
}

/** `NewTabMenu` 组件参数。 */
export interface NewTabMenuProps {
  /** 顶栏当前是否处于显示状态；隐藏时强制关闭菜单。 */
  readonly visible: boolean
  /** 供工作区关闭最后标签时归还焦点的按钮引用。 */
  readonly buttonRef: RefObject<HTMLButtonElement | null>
  /** 可选标签类型列表。 */
  readonly items: readonly NewTabMenuItem[]
  /** 菜单已展开时再次点击按钮直接创建的目标类型键名，默认取首项。 */
  readonly primaryKey?: string | undefined
  /** 附加到触发按钮上的样式类名，用于浮动胶囊等场景微调尺寸。 */
  readonly buttonClassName?: string | undefined
  /** 加号图标像素尺寸，默认 17px。 */
  readonly iconSize?: number | undefined
  /** 是否使用 ElasticPress 包裹触发按钮，默认关闭。 */
  readonly elastic?: boolean | undefined
  /** 选中某项后的创建回调。 */
  readonly onSelect: (key: string) => void
}

/** 渲染顶栏或浮动胶囊中的「+」新建工作标签按钮及 FlClash 液态展开/收回菜单。 */
export function NewTabMenu({
  visible,
  buttonRef,
  items,
  primaryKey,
  buttonClassName,
  iconSize = 17,
  elastic = false,
  onSelect,
}: NewTabMenuProps) {
  const [open, setOpen] = useState(false)
  const [focusOnOpen, setFocusOnOpen] = useState(false)
  const openRef = useRef(false)

  const dismiss = useCallback(() => {
    openRef.current = false
    setOpen(false)
  }, [])

  useEffect(() => {
    if (!visible) dismiss()
  }, [dismiss, visible])

  const triggerPrimary = () => {
    const targetKey = primaryKey ?? items[0]?.key
    const primary = items.find(item => item.key === targetKey)
    if (primary !== undefined && !primary.disabled) onSelect(primary.key)
  }

  const triggerClassName = buttonClassName
    ? `new-session-tab ${buttonClassName}`
    : 'new-session-tab'
  const triggerButton = (
    <button
      type="button"
      className={triggerClassName}
      aria-label="新建工作标签"
      title={open ? '再次点击新建聊天' : '新建标签（连点两次新建聊天）'}
      aria-haspopup="menu"
      aria-expanded={open}
      ref={buttonRef}
      onClick={event => {
        if (!visible) return
        if (openRef.current) {
          dismiss()
          triggerPrimary()
          return
        }
        // 键盘激活（detail === 0）进入首项以支持方向键浏览，鼠标点击保持轻量不强夺焦点。
        setFocusOnOpen(event.detail === 0)
        openRef.current = true
        setOpen(true)
      }}
    >
      <Plus size={iconSize} aria-hidden="true" />
    </button>
  )

  return (
    <>
      {elastic ? <ElasticPress>{triggerButton}</ElasticPress> : triggerButton}
      <AnchoredMenu
        open={visible && open}
        anchorRef={buttonRef}
        align="end"
        side="bottom"
        motion="morph"
        focusOnOpen={focusOnOpen}
        className="new-tab-menu"
        label="新建工作标签"
        onDismiss={dismiss}
      >
        {items.map(item => (
          <button
            key={item.key}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              dismiss()
              onSelect(item.key)
            }}
          >
            {item.icon}
            <span>{item.label}</span>
          </button>
        ))}
      </AnchoredMenu>
    </>
  )
}
