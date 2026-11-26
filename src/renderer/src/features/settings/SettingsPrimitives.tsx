/**
 * 设置中心公共原语：提供分组区块、设置项行、下拉选择器、能力提示条与状态圆点。
 * 运行在 renderer，供各设置分类页复用；不持有后台连接或需要手动释放的资源。
 */
import { Select, type SelectProps } from 'antd'
import type { ReactNode } from 'react'

/** 设置下拉选择器的单个选项数据结构，支持可选分组标签与禁用态。 */
export interface SettingsSelectOption {
  readonly value: string
  readonly label: string
  readonly group?: string
  readonly disabled?: boolean
}

/**
 * 渲染设置中心统一下拉选择器；把扁平的分组选项列表转换为 Ant Design Select 结构。
 * 展开、定位、键盘导航与焦点恢复由组件库自身管理。
 */
export function SettingsSelect({
  label,
  value,
  options,
  placeholder = '请选择',
  disabled = false,
  onChange,
}: {
  label: string
  value: string
  options: readonly SettingsSelectOption[]
  placeholder?: string
  disabled?: boolean
  onChange(value: string): void
}) {
  // 只转换设置目录的分组结构；展开、定位、键盘与焦点由 Ant Design 负责。
  const selectOptions: NonNullable<SelectProps<string>['options']> = []
  for (const option of options) {
    if (option.group === undefined) {
      selectOptions.push(option)
      continue
    }
    const previous = selectOptions.at(-1)
    if (previous?.label === option.group && previous.options !== undefined) {
      previous.options.push(option)
    } else {
      selectOptions.push({ label: option.group, options: [option] })
    }
  }

  return (
    <Select<string>
      className="settings-select"
      aria-label={label}
      value={options.some(option => option.value === value) ? value : null}
      options={selectOptions}
      placeholder={placeholder}
      disabled={disabled || options.length === 0}
      showSearch={false}
      virtual={false}
      onChange={onChange}
    />
  )
}

/** 渲染设置页的分组卡片容器，可选展示标题与说明文案。 */
export function SettingsSection({
  title,
  description,
  children,
}: {
  title?: string
  description?: string
  children: ReactNode
}) {
  return (
    <section className="settings-section">
      {(title !== undefined || description !== undefined) && (
        <header className="settings-section__header">
          {title !== undefined && <h3>{title}</h3>}
          {description !== undefined && <p>{description}</p>}
        </header>
      )}
      <div className="settings-section__body">{children}</div>
    </section>
  )
}

/**
 * 渲染分组卡片中的单条设置项；支持左右双列（默认）或上下堆叠（`layout="vertical"`）排布。
 */
export function SettingRow({
  title,
  description,
  children,
  warning,
  layout,
}: {
  title: string
  description?: string
  children: ReactNode
  warning?: boolean
  layout?: 'horizontal' | 'vertical'
}) {
  return (
    <div className="settings-row" data-warning={warning || undefined} data-layout={layout}>
      <div className="settings-row__copy">
        <strong>{title}</strong>
        {description !== undefined && <small>{description}</small>}
      </div>
      <div className="settings-row__control">{children}</div>
    </div>
  )
}

/** 渲染运行时能力、只读提示或错误状态横幅；`tone="error"` 时使用 `role="alert"` 立即播报。 */
export function CapabilityNotice({
  title,
  children,
  tone = 'neutral',
}: {
  title: string
  children: ReactNode
  tone?: 'neutral' | 'warning' | 'error'
}) {
  return (
    <div
      className="settings-capability"
      data-tone={tone}
      role={tone === 'error' ? 'alert' : 'status'}
    >
      <strong>{title}</strong>
      <p>{children}</p>
    </div>
  )
}

/** 渲染 7px 状态指示圆点，仅用于视觉辅助，不进入无障碍朗读树。 */
export function StatusDot({ state }: { state: 'positive' | 'negative' | 'neutral' | 'warning' }) {
  return <span className="settings-status-dot" data-state={state} aria-hidden="true" />
}
