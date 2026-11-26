/**
 * MyDSH 普通插槽核心，移植自 DeepSeek Harness ddefc45fbc 的
 * packages/client/ui-slots/src/index.ts（MIT）。保留声明所有权、优先级、
 * 级联释放、过期引用与微任务通知；未移植当前没有消费者的组件工厂和 Store 轴。
 * Copyright (c) DeepSeek Harness contributors. 许可证见 docs/upstream/dsh/LICENSE。
 */
export type SlotKind = 'single' | 'list' | 'keyed'
export interface SlotSpec {
  kind: SlotKind
  scope: 'application' | 'project' | 'session'
}
export interface SlotOptions {
  name: string
  key?: string
  id?: string
  order?: number
  priority?: number
  registrant?: string
  children?: Readonly<Record<string, SlotSpec>>
}
export interface SlotEntry<T = unknown> {
  readonly component: T
  readonly options: SlotOptions
}
interface SlotRecord {
  spec: SlotSpec | undefined
  declaredBy: string | undefined
  epoch: number
  version: number
  entries: readonly SlotEntry[]
  listeners: Set<() => void>
  declarations: Set<() => void>
}
const EMPTY: readonly SlotEntry[] = Object.freeze([])

/** 注册与渲染分离；无 React 或 Cordis 运行依赖，可独立验证所有权。 */
export class SlotCore {
  private readonly records = new Map<string, SlotRecord>()
  private readonly dirty = new Set<SlotRecord>()
  private scheduled = false

  constructor() {
    const root = this.record('root')
    root.spec = { kind: 'single', scope: 'application' }
    root.declaredBy = 'MyDSH'
    root.epoch = 1
  }

  register<T>(options: SlotOptions, component: T): () => void {
    const record = this.records.get(options.name)
    if (record?.spec === undefined) throw new Error(`插槽「${options.name}」尚未由父组件声明`)
    const { kind } = record.spec
    if (kind === 'keyed' && !options.key) throw new Error(`插槽「${options.name}」需要 key`)
    if (kind === 'list' && !options.id) throw new Error(`插槽「${options.name}」需要 id`)
    const priority = options.priority ?? 0
    const cell = kind === 'keyed' ? options.key : kind === 'list' ? options.id : undefined
    if (
      record.entries.some(
        entry =>
          (entry.options.priority ?? 0) === priority &&
          (kind === 'keyed'
            ? entry.options.key
            : kind === 'list'
              ? entry.options.id
              : undefined) === cell,
      )
    ) {
      throw new Error(`插槽「${options.name}」的「${cell ?? '默认'}」位置已被占用`)
    }
    for (const name of Object.keys(options.children ?? {})) {
      if (this.records.get(name)?.spec !== undefined) throw new Error(`子插槽「${name}」已有声明者`)
    }
    const entry: SlotEntry<T> = { options, component }
    record.entries = [...record.entries, entry].toSorted(
      (a, b) =>
        (a.options.priority ?? 0) - (b.options.priority ?? 0) ||
        (kind === 'list' ? (a.options.order ?? 0) - (b.options.order ?? 0) : 0),
    )
    this.changed(record)
    // 先提交全部子声明，再通知依赖者，避免重入时观察到一半已建立的树。
    const declarations = Object.entries(options.children ?? {}).map(([name, spec]) => {
      const child = this.record(name)
      child.spec = spec
      child.declaredBy = options.registrant ?? options.name
      child.epoch += 1
      return child
    })
    for (const child of declarations) this.changed(child)
    for (const child of declarations) this.notifyDeclaration(child)
    return () => {
      if (!record.entries.includes(entry)) return
      record.entries = record.entries.filter(item => item !== entry)
      this.changed(record)
      this.releaseChildren(options.children)
    }
  }

  /** 数组引用在同一次变更前保持稳定，供 React 的外部 Store 订阅使用。 */
  entries(name: string): readonly SlotEntry[] {
    return this.records.get(name)?.entries ?? EMPTY
  }
  spec(name: string): SlotSpec | undefined {
    return this.records.get(name)?.spec
  }
  declarationEpoch(name: string): number {
    return this.records.get(name)?.epoch ?? 0
  }
  isLive(entry: SlotEntry): boolean {
    return [...this.records.values()].some(record => record.entries.includes(entry))
  }

  winners<T>(name: string): readonly SlotEntry<T>[] {
    const record = this.records.get(name)
    if (record?.spec === undefined) return []
    const cells = new Set<string | undefined>()
    return record.entries.filter(entry => {
      const cell =
        record.spec?.kind === 'keyed'
          ? entry.options.key
          : record.spec?.kind === 'list'
            ? entry.options.id
            : undefined
      if (cells.has(cell)) return false
      cells.add(cell)
      return true
    }) as readonly SlotEntry<T>[]
  }

  subscribe(name: string, listener: () => void): () => void {
    const record = this.record(name)
    record.listeners.add(listener)
    return () => {
      record.listeners.delete(listener)
    }
  }

  /** 声明通知同步发送，撤销父声明时依赖插件先释放旧代次资源。 */
  subscribeDeclaration(name: string, listener: () => void): () => void {
    const record = this.record(name)
    record.declarations.add(listener)
    return () => {
      record.declarations.delete(listener)
    }
  }

  private releaseChildren(children: SlotOptions['children']): void {
    for (const name of Object.keys(children ?? {})) {
      const record = this.record(name)
      const doomed = record.entries
      record.entries = EMPTY
      record.spec = undefined
      record.declaredBy = undefined
      record.epoch += 1
      this.changed(record)
      this.notifyDeclaration(record)
      for (const entry of doomed) this.releaseChildren(entry.options.children)
    }
  }

  private record(name: string): SlotRecord {
    let record = this.records.get(name)
    if (record === undefined) {
      record = {
        spec: undefined,
        declaredBy: undefined,
        epoch: 0,
        version: 0,
        entries: EMPTY,
        listeners: new Set(),
        declarations: new Set(),
      }
      this.records.set(name, record)
    }
    return record
  }

  private notifyDeclaration(record: SlotRecord): void {
    // 回调可取消或重新注册其他回调，快照保证本轮通知不进入新一代订阅。
    const listeners = [...record.declarations]
    for (const listener of listeners) listener()
  }
  private changed(record: SlotRecord): void {
    record.version += 1
    this.dirty.add(record)
    if (this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      const dirty = [...this.dirty]
      this.dirty.clear()
      for (const item of dirty) {
        const listeners = [...item.listeners]
        for (const listener of listeners) listener()
      }
    })
  }
}
