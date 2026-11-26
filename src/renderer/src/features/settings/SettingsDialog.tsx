/**
 * 设置中心对话框：提供分类侧栏导航、选中指示条、配置文件直达与各子设置页宿主。
 * 运行在 renderer；内部骨架随弹窗显隐挂载，以保证侧栏弹性选择条在首次打开时正确定位。
 */
import { Button, Menu, Modal } from 'antd'
import { FileCode2, LoaderCircle, RotateCw, X } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'

import { useWorkspaceSnapshot, useWorkspaceStore } from '../../hooks/useWorkspace.ts'
import {
  contributionKey,
  PluginBoundary,
  PluginIconView,
  usePluginSettings,
} from '../../plugins/react.tsx'
import type { SettingsContribution } from '../../plugins/registry.ts'
import { useSelectionWorm } from '../../shared/ui/useSelectionWorm.ts'
import { useSettingsCenter } from './useSettingsCenter.ts'
import './settings.css'

interface SettingsDialogProps {
  /**
   * 外观由桌面设置域拥有，不经过 DSH Host。调用方传入该页，避免设置中心反向依赖外观实现。
   */
  readonly appearance?: ReactNode
}

interface SettingsDialogFrameProps {
  readonly section: string
  readonly sections: readonly SettingsContribution[]
  readonly appearance?: ReactNode
  readonly settings: ReturnType<typeof useSettingsCenter>
  onSelectSection(section: string): void
  onClose(): void
}

function SettingsDialogFrame({
  section,
  sections,
  appearance,
  settings,
  onSelectSection,
  onClose,
}: SettingsDialogFrameProps) {
  const contentRef = useRef<HTMLDivElement>(null)
  const navTrackRef = useRef<HTMLDivElement>(null)
  const { state, load, openDocument } = settings
  const wormRef = useSelectionWorm({
    containerRef: navTrackRef,
    activeSelector: '.ant-menu-item-selected, [aria-current="page"]',
    activeKey: `${section}:${String(sections.length)}`,
  })

  useEffect(() => {
    if (contentRef.current !== null) contentRef.current.scrollTop = 0
  }, [section])

  const selectedPage = sections.find(item => item.id === section)
  const Page = selectedPage?.component
  const page =
    section === 'appearance' && appearance !== undefined
      ? appearance
      : Page && (
          <PluginBoundary key={contributionKey(selectedPage)} name={selectedPage.label}>
            <Page {...settings} />
          </PluginBoundary>
        )

  return (
    <div className="settings-dialog__frame">
      <header className="settings-dialog__header">
        <h1 id="settings-dialog-title">设置</h1>
        <div className="settings-dialog__actions">
          {state.document?.hasDocument === true && (
            <Button
              type="text"
              icon={<FileCode2 size={14} aria-hidden="true" />}
              disabled={state.saving !== null}
              loading={state.saving === 'open-document'}
              onClick={() => {
                void openDocument()
              }}
            >
              打开配置文件
            </Button>
          )}
          <Button
            type="text"
            shape="circle"
            aria-label="关闭设置"
            icon={<X size={18} aria-hidden="true" />}
            onClick={onClose}
          />
        </div>
      </header>

      <nav className="settings-nav" aria-label="设置分类">
        <div className="settings-nav__track" ref={navTrackRef}>
          <Menu
            className="settings-nav__items"
            mode="inline"
            inlineIndent={12}
            styles={{ itemContent: { marginInlineStart: 10 } }}
            selectedKeys={[section]}
            items={sections.map(({ id, label, icon }) => ({
              key: id,
              label,
              icon: (
                <span className="settings-nav__icon">
                  <PluginIconView icon={icon} name={label} size={17} />
                </span>
              ),
              'aria-current': section === id ? 'page' : undefined,
            }))}
            onClick={({ key }) => {
              onSelectSection(key)
            }}
          />
          <span ref={wormRef} className="settings-nav__worm" aria-hidden="true" hidden />
        </div>
      </nav>

      <div className="settings-content" data-section={section} ref={contentRef}>
        {state.loading && (
          <div className="settings-loading" role="status">
            <LoaderCircle className="spin" size={16} aria-hidden="true" />
            正在读取运行时能力…
          </div>
        )}
        {state.error !== null && (
          <div className="settings-global-error" role="alert">
            <div>
              <strong>部分设置未能加载</strong>
              <p>{state.error}</p>
            </div>
            <Button
              type="text"
              disabled={state.loading}
              onClick={() => {
                void load()
              }}
            >
              <RotateCw size={14} aria-hidden="true" />
              重试
            </Button>
          </div>
        )}
        {page}
      </div>
    </div>
  )
}

/** 桌面设置中心弹窗组件；打开时聚焦当前导航项，关闭后由 Modal 自动归还焦点。 */
export function SettingsDialog({ appearance }: SettingsDialogProps) {
  const store = useWorkspaceStore()
  const snapshot = useWorkspaceSnapshot()
  const [section, setSection] = useState('general')
  const settings = useSettingsCenter()
  const sections = usePluginSettings()

  useEffect(() => {
    if (sections.length > 0 && !sections.some(item => item.id === section)) setSection('general')
  }, [sections, section])

  const close = () => {
    store.closeSettings()
  }

  return (
    <Modal
      className="settings-dialog"
      classNames={{
        header: 'visually-hidden',
        container: 'settings-dialog__container mydsh-glass-dialog',
        body: 'settings-dialog__body',
        mask: 'mydsh-glass-mask',
      }}
      title="设置"
      open={snapshot.settingsOpen}
      centered
      width="min(860px, calc(100vw - 48px))"
      footer={null}
      closable={false}
      mask={{ closable: true }}
      focusable={{ trap: true, focusTriggerAfterClose: true }}
      destroyOnHidden
      onCancel={close}
      afterOpenChange={open => {
        // 只指定业务上的初始落点；焦点限制、Esc 和关闭后恢复由 Modal 管理。
        const dialog = document.querySelector('.settings-dialog[role="dialog"]')
        // 动画结束前用户可能已进入表单，此时不能把焦点抢回分类菜单。
        if (open && dialog === document.activeElement) {
          dialog?.querySelector<HTMLElement>('[aria-current="page"]')?.focus()
        }
      }}
    >
      {snapshot.settingsOpen && (
        <SettingsDialogFrame
          section={section}
          sections={sections}
          appearance={appearance}
          settings={settings}
          onSelectSection={setSection}
          onClose={close}
        />
      )}
    </Modal>
  )
}
