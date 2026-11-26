/* oxlint-disable no-await-in-loop -- 同一注册表的装卸必须串行，后继插件可依赖前驱的服务。 */
import * as React from 'react'
import * as ReactDOM from 'react-dom'
import * as ReactDOMClient from 'react-dom/client'
import * as JsxRuntime from 'react/jsx-runtime'
import * as JsxDevRuntime from 'react/jsx-dev-runtime'
import * as Cordis from '@deepseek-ai/cordis'
import type { Plugin } from '@deepseek-ai/cordis'
import type { DesktopBridge, FrontendPluginDescriptor } from '../platform/contracts.ts'
import * as sdk from './sdk.ts'
import type { UiRuntime } from './registry.ts'

type Factory = (
  require: (name: string) => unknown,
  module: { exports: unknown },
  exports: unknown,
) => void
interface PendingScript {
  script: HTMLScriptElement
  factory?: Factory
}
const shared: Readonly<Record<string, unknown>> = Object.freeze({
  react: React,
  'react-dom': ReactDOM,
  'react-dom/client': ReactDOMClient,
  'react/jsx-runtime': JsxRuntime,
  'react/jsx-dev-runtime': JsxDevRuntime,
  '@deepseek-ai/cordis': Cordis,
  '@mydsh/ui': sdk,
})

/**
 * 只加载主进程已经批准的本地脚本，不使用 eval 或任意 import URL。
 * 工厂中的 require 仅解析宿主共享依赖，其余依赖由转换工具链预先打包。
 */
export class FrontendPluginLoader {
  private readonly pending = new Map<string, PendingScript>()
  private readonly active = new Map<
    string,
    { entry: FrontendPluginDescriptor; script: HTMLScriptElement; styles: HTMLLinkElement[] }
  >()
  private queue = Promise.resolve()
  private readonly failed = new Map<
    string,
    { version: string; entryUrl: string; message: string }
  >()
  private readonly rollbackAttempts = new Set<string>()
  private readonly abort = new AbortController()
  private stopped = false
  private unsubscribe: (() => void) | undefined
  private readonly define = (id: string, factory: Factory) => {
    const record = this.pending.get(id)
    if (
      !record ||
      document.currentScript !== record.script ||
      typeof factory !== 'function' ||
      record.factory
    ) {
      throw new Error(`插件「${id}」未获得当前入口注册权限`)
    }
    record.factory = factory
  }
  private readonly registry = Object.freeze({ define: this.define })

  constructor(
    private readonly runtime: UiRuntime,
    private readonly bridge: Pick<
      DesktopBridge,
      'getFrontendPlugins' | 'onFrontendPluginsChanged'
    > & { host: Pick<DesktopBridge['host'], 'call'> },
    private readonly report: (message: string | null) => void,
    private readonly flushBusy?: () => Promise<void>,
  ) {}

  start(): void {
    Object.defineProperty(window, '__MYDSH_PLUGINS__', { value: this.registry, configurable: true })
    this.unsubscribe = this.bridge.onFrontendPluginsChanged(() => {
      this.refresh()
    })
    this.refresh()
  }

  private refresh(): void {
    // 安装/卸载串行进行，迟到的脚本或清理不能覆盖更新版本的注册。
    this.queue = this.queue
      .then(async () => {
        if (this.stopped) return
        const descriptors = await this.bridge.getFrontendPlugins()
        if (this.stopped) return
        const wanted = new Map(descriptors.map(entry => [entry.id, entry]))
        for (const [id, failure] of this.failed) {
          const next = wanted.get(id)
          if (!next || next.version !== failure.version || next.entryUrl !== failure.entryUrl)
            this.failed.delete(id)
          if (!next)
            for (const attempt of this.rollbackAttempts)
              if (attempt.startsWith(`${id}@`)) this.rollbackAttempts.delete(attempt)
        }
        for (const [id, loaded] of this.active) {
          const next = wanted.get(id)
          if (next?.version === loaded.entry.version && next.entryUrl === loaded.entry.entryUrl)
            continue
          await this.runtime.uninstall(id)
          loaded.script.remove()
          loaded.styles.forEach(style => {
            style.remove()
          })
          this.active.delete(id)
        }
        for (const entry of descriptors) {
          if (this.stopped || this.active.has(entry.id) || this.failed.has(entry.id)) continue
          try {
            await this.load(entry)
          } catch (error) {
            await this.recover(entry, error)
          }
        }
        const failures = [...this.failed].map(([id, failure]) => `${id}：${failure.message}`)
        this.report(failures.length ? failures.join('；') : null)
      })
      .catch(error => {
        if (!this.stopped) this.report(error instanceof Error ? error.message : '无法同步界面插件')
      })
  }

  /** 只有升级且确有上一版时回退一次；失败版本不会因清单事件反复加载。 */
  private async recover(entry: FrontendPluginDescriptor, error: unknown): Promise<void> {
    const reason = error instanceof Error ? error.message : '加载失败'
    this.failed.set(entry.id, { ...entry, message: reason })
    const attempt = `${entry.id}@${entry.version}`
    if (!entry.previousVersion || this.rollbackAttempts.has(attempt) || this.stopped) return
    this.rollbackAttempts.add(attempt)
    try {
      // 候选失败后的 effect 清理可能刚撤销占用；先同步到主进程再请求回退。
      await this.flushBusy?.()
      await this.bridge.host.call('mydshPlugins.rollback', { id: entry.id })
      const previous = (await this.bridge.getFrontendPlugins()).find(
        candidate => candidate.id === entry.id && candidate.version === entry.previousVersion,
      )
      if (!previous) throw new Error('上一版本尚未恢复到可运行状态，请查看插件管理中的原因')
      // 即使旧入口也失败，下一次刷新仍保持错误，避免旧版本形成重试循环。
      this.failed.set(entry.id, { ...previous, message: `新版本加载失败：${reason}；上一版恢复中` })
      await this.load(previous)
      this.failed.set(entry.id, {
        ...previous,
        message: `新版本加载失败：${reason}；已恢复 ${previous.version}`,
      })
    } catch (failure) {
      const current = this.failed.get(entry.id)!
      this.failed.set(entry.id, {
        ...current,
        message: `新版本加载失败：${reason}；恢复未完成：${failure instanceof Error ? failure.message : '恢复失败'}`,
      })
    }
  }

  private async load(entry: FrontendPluginDescriptor): Promise<void> {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(entry.id) || entry.id.startsWith('mydsh.'))
      throw new Error('扩展标识不合法或占用了内置命名空间')
    this.validateUrl(entry, entry.entryUrl)
    for (const styleUrl of entry.styleUrls ?? []) this.validateUrl(entry, styleUrl)
    const script = document.createElement('script')
    script.src = entry.entryUrl
    script.dataset.mydshPlugin = entry.id
    const record: PendingScript = { script }
    this.pending.set(entry.id, record)
    const styles: HTMLLinkElement[] = []
    try {
      for (const styleUrl of entry.styleUrls ?? []) {
        const style = document.createElement('link')
        style.rel = 'stylesheet'
        style.href = styleUrl
        style.dataset.mydshPlugin = entry.id
        styles.push(style)
        await this.loadElement(style)
      }
      await this.loadElement(script)
      if (this.stopped) return
      if (!record.factory) throw new Error('入口没有注册模块工厂')
      const module = { exports: {} as unknown }
      record.factory(
        name => {
          if (!Object.hasOwn(shared, name))
            throw new Error(`插件使用了未共享的依赖「${name}」，请重新构建并将其打包`)
          return shared[name]
        },
        module,
        module.exports,
      )
      const exported = module.exports as { default?: Plugin; apply?: unknown }
      const plugin = exported.default ?? exported
      if (
        typeof plugin !== 'function' &&
        (typeof plugin !== 'object' || plugin === null || typeof plugin.apply !== 'function')
      ) {
        throw new Error('插件必须导出 Cordis apply(ctx) 入口')
      }
      await this.runtime.install(entry.id, plugin as Plugin)
      this.active.set(entry.id, { entry, script, styles })
    } finally {
      this.pending.delete(entry.id)
      if (!this.active.has(entry.id)) {
        script.remove()
        styles.forEach(style => {
          style.remove()
        })
      }
    }
  }

  private validateUrl(entry: FrontendPluginDescriptor, value: string): void {
    const url = new URL(value)
    if (
      url.protocol !== 'mydsh-plugin:' ||
      url.hostname !== entry.id ||
      url.pathname.split('/')[1] !== entry.version ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    )
      throw new Error('插件资源不属于对应的安装版本')
  }

  private loadElement(element: HTMLScriptElement | HTMLLinkElement): Promise<void> {
    return new Promise((resolve, reject) => {
      const signal = this.abort.signal
      const timer = window.setTimeout(() => {
        finish(new Error('界面插件资源加载超时'))
      }, 15000)
      const finish = (error?: Error) => {
        window.clearTimeout(timer)
        element.removeEventListener('load', onLoad)
        element.removeEventListener('error', onError)
        signal.removeEventListener('abort', onAbort)
        if (error) reject(error)
        else resolve()
      }
      const onLoad = () => {
        finish()
      }
      const onError = () => {
        finish(new Error('无法读取界面插件资源'))
      }
      const onAbort = () => {
        finish(new Error('界面插件加载已取消'))
      }
      element.addEventListener('load', onLoad, { once: true })
      element.addEventListener('error', onError, { once: true })
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) {
        onAbort()
        return
      }
      document.head.append(element)
    })
  }

  async dispose(): Promise<void> {
    this.stopped = true
    this.abort.abort()
    this.unsubscribe?.()
    await this.queue
    for (const [id, loaded] of this.active) {
      await this.runtime.uninstall(id)
      loaded.script.remove()
      loaded.styles.forEach(style => {
        style.remove()
      })
    }
    this.active.clear()
    if (window['__MYDSH_PLUGINS__'] === this.registry) delete window['__MYDSH_PLUGINS__']
  }
}

declare global {
  interface Window {
    __MYDSH_PLUGINS__?: { define(id: string, factory: Factory): void }
  }
}
