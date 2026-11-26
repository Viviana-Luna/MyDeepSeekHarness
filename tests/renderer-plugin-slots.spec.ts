// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import { createElement as h, useEffect } from 'react'
import { act, render, screen, waitFor, cleanup } from '@testing-library/react'
import type { Context } from '@deepseek-ai/cordis'
import type { ConversationToolItem } from '../src/shared/session-projection.ts'
import type {
  DesktopBridge,
  FrontendPluginDescriptor,
} from '../src/renderer/src/platform/contracts.ts'
import {
  PluginActions,
  PluginToolResult,
  PluginNotifications,
  UiRuntimeContext,
} from '../src/renderer/src/plugins/react.tsx'
import { builtinUiPlugins } from '../src/renderer/src/plugins/builtin.tsx'
import { FrontendPluginLoader } from '../src/renderer/src/plugins/loader.ts'
import { UiRuntime } from '../src/renderer/src/plugins/registry.ts'
import { SlotCore } from '../src/renderer/src/plugins/slot-core.ts'
import { callRemote } from '../src/renderer/src/plugins/sdk.ts'
import * as desktop from '../src/renderer/src/services/desktop.ts'

const TestIcon = () => null

// 本次新增界面插件生命周期，现有固定模式测试无法发现声明撤销后残留贡献的回归。
describe('界面插件插槽生命周期', () => {
  it('按领域独立装配内置贡献，并在卸载会话插件时保留其他领域', async () => {
    const runtime = new UiRuntime()
    const ids = (name: string) =>
      runtime.slots.core
        .winners<{ id: string }>(name)
        .map(entry => entry.component.id)
        .toSorted()
    try {
      await Promise.all(builtinUiPlugins.map(entry => runtime.install(entry.id, entry.plugin)))
      expect(ids('modes')).toEqual([
        'browser',
        'changes',
        'connections',
        'conversation',
        'database',
        'files',
        'plugins',
        'terminal',
        'trajectory',
      ])
      expect(ids('islands')).toEqual([
        'browser',
        'changes',
        'connections',
        'conversation',
        'file-outline-tasks',
        'files',
        'git-history',
        'plan-preview',
        'plugins',
        'session-info',
        'terminal',
        'trajectory',
      ])
      expect(ids('settings')).toEqual([
        'appearance',
        'archived-sessions',
        'automation',
        'general',
        'models',
        'presets',
      ])
      expect(runtime.slots.core.winners('composer.readings')).toHaveLength(0)
      expect(runtime.slots.core.winners('composer.actions')).toHaveLength(0)
      expect(runtime.slots.core.winners('session.info')).toHaveLength(1)
      expect(runtime.slots.core.winners('workspace.alerts')).toHaveLength(1)

      await runtime.uninstall('mydsh.session-ui')
      expect(ids('modes')).toEqual([
        'browser',
        'changes',
        'connections',
        'database',
        'files',
        'plugins',
        'terminal',
      ])
      expect(ids('islands')).toEqual([
        'browser',
        'changes',
        'connections',
        'file-outline-tasks',
        'files',
        'git-history',
        'plugins',
        'terminal',
      ])
      expect(
        runtime.slots.core
          .winners<{ id: string; placements: string[] }>('islands')
          .find(entry => entry.component.id === 'files')?.component.placements,
      ).toEqual(['main'])
      expect(ids('settings')).toEqual([
        'appearance',
        'archived-sessions',
        'automation',
        'general',
        'models',
        'presets',
      ])
      expect(runtime.slots.core.winners('session.info')).toHaveLength(1)
      await runtime.uninstall('mydsh.source-control-ui')
      expect(runtime.slots.core.winners('session.info')).toHaveLength(0)
      expect(runtime.slots.core.winners('workspace.alerts')).toHaveLength(0)
      await runtime.uninstall('mydsh.connections-ui')
      expect(runtime.slots.core.winners('composer.actions')).toHaveLength(0)
    } finally {
      await runtime.dispose()
    }
  })

  it('按声明注册、排序，并随父插件停用级联释放及使旧引用失效', async () => {
    const runtime = new UiRuntime()
    const core = runtime.slots.core
    await runtime.install('parent', {
      inject: ['mydshSlots'],
      apply(ctx) {
        ctx.mydshSlots.register(
          {
            name: 'modes',
            key: 'fixture',
            children: { actions: { kind: 'list', scope: 'session' } },
          },
          null,
        )
        ctx.mydshSlots.registerIsland({
          id: 'fixture.island',
          label: '测试浮岛',
          icon: () => null,
          component: () => null,
          placements: ['right'],
          scope: 'session',
        })
      },
    })
    await runtime.install('child', {
      inject: ['mydshSlots'],
      apply(ctx) {
        ctx.mydshSlots.register({ name: 'actions', id: 'second', order: 2 }, '第二项')
        ctx.mydshSlots.register(
          {
            name: 'actions',
            id: 'first',
            order: 1,
            children: { details: { kind: 'single', scope: 'session' } },
          },
          '第一项',
        )
        ctx.mydshSlots.register({ name: 'details' }, '详情')
      },
    })
    expect(core.winners<string>('actions').map(item => item.component)).toEqual([
      '第一项',
      '第二项',
    ])
    expect(core.winners('islands')).toHaveLength(1)
    const oldEntry = core.entries('details')[0]!
    let updates = 0
    const unsubscribe = core.subscribe('actions', () => {
      updates += 1
    })
    await runtime.uninstall('parent')
    await runtime.uninstall('child')
    expect(core.isLive(oldEntry)).toBe(false)
    expect(core.spec('details')).toBeUndefined()
    expect(core.entries('actions')).toEqual([])
    expect(core.entries('islands')).toEqual([])
    await Promise.resolve()
    expect(updates).toBe(1)
    unsubscribe()
    await runtime.dispose()
  })

  it('拒绝未声明插槽和同位置重复注册，允许释放后重新声明', () => {
    const core = new SlotCore()
    expect(() => core.register({ name: 'missing' }, null)).toThrow('尚未由父组件声明')
    const release = core.register(
      { name: 'root', children: { main: { kind: 'keyed', scope: 'application' } } },
      null,
    )
    core.register({ name: 'main', key: 'files' }, null)
    expect(() => core.register({ name: 'main', key: 'files' }, null)).toThrow('已被占用')
    const oldEpoch = core.declarationEpoch('main')
    release()
    core.register(
      { name: 'root', children: { main: { kind: 'keyed', scope: 'application' } } },
      null,
    )
    expect(core.declarationEpoch('main')).toBeGreaterThan(oldEpoch)
    expect(() => core.register({ name: 'main', key: 'files' }, null)).not.toThrow()
  })

  it('在进入外壳前拒绝位置、作用域或组件元数据无效的浮岛', async () => {
    const runtime = new UiRuntime()
    try {
      await expect(
        runtime.install('invalid-scope', {
          apply(ctx) {
            ctx.mydshSlots.registerIsland({
              id: 'invalid.scope',
              label: '错误作用域',
              icon: TestIcon,
              component: () => null,
              placements: ['right'],
              scope: 'application',
            } as never)
          },
        }),
      ).rejects.toThrow('作用域必须是 session、project 或 window')
      await expect(
        runtime.install('invalid-component', {
          apply(ctx) {
            ctx.mydshSlots.registerIsland({
              id: 'invalid.component',
              label: '错误组件',
              icon: TestIcon,
              component: [] as never,
              placements: ['right'],
              scope: 'session',
            })
          },
        }),
      ).rejects.toThrow('标识、名称、图标、组件或顺序无效')
      expect(runtime.slots.core.entries('islands')).toEqual([])
    } finally {
      await runtime.dispose()
    }
  })
})

const entry = (version: string, previousVersion?: string): FrontendPluginDescriptor => ({
  id: 'example.view',
  version,
  entryUrl: `mydsh-plugin://example.view/${version}/entry.js`,
  ...(previousVersion ? { previousVersion } : {}),
})

// 已有固定视图测试不能验证扩展贡献换作用域时的 React effect 清理及升级回退。
describe('扩展贡献与失败恢复', () => {
  it('单次调用取消仅把编号交给桌面桥，并拒绝发送已经取消的请求', async () => {
    const remoteResult = Promise.withResolvers<unknown>()
    const call = vi.fn<DesktopBridge['remote']['call']>(() => remoteResult.promise)
    const cancelCall = vi.fn(async () => {})
    const bridge = vi
      .spyOn(desktop, 'getDesktopBridge')
      .mockReturnValue({ remote: { call, cancelCall } } as unknown as DesktopBridge)
    try {
      const controller = new AbortController()
      const pending = callRemote('example/read', { path: 'README.md' }, controller.signal)
      const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
      controller.abort()
      await rejected
      expect(call).toHaveBeenCalledWith(
        'example/read',
        { path: 'README.md' },
        expect.stringMatching(/^\d+$/u),
      )
      expect(cancelCall).toHaveBeenCalledWith(call.mock.calls[0]![2])
      await expect(callRemote('example/read', {}, controller.signal)).rejects.toMatchObject({
        name: 'AbortError',
      })
      expect(call).toHaveBeenCalledTimes(1)
    } finally {
      remoteResult.resolve(null)
      bridge.mockRestore()
    }
  })

  it('按作用域重建动作、按工具选择输出，并在停用时释放通知与占用', async () => {
    const runtime = new UiRuntime()
    let released = 0
    const Action = () => {
      useEffect(
        () => () => {
          released++
        },
        [],
      )
      return h('span', null, '动作')
    }
    const item: ConversationToolItem = {
      type: 'tool',
      seq: 1,
      latestSeq: 1,
      time: 0,
      endTime: 1,
      turn: 1,
      callId: 'read-1',
      name: 'read',
      summary: '读取',
      argumentsText: '{}',
      resultText: '原文',
      status: 'settled',
      isError: false,
    }
    await runtime.install('views', {
      apply(ctx) {
        ctx.mydshSlots.registerAction('composer.actions', 'action', Action)
        ctx.mydshSlots.registerToolResult('read', ({ item: resultItem }) =>
          h('strong', null, `读取结果：${resultItem.resultText}`),
        )
        ctx.mydshSlots.registerAction(
          'shell.notifications',
          'later',
          () => h('span', null, '后通知'),
          20,
        )
        ctx.mydshSlots.registerAction(
          'shell.notifications',
          'first',
          () => h('span', null, '先通知'),
          10,
        )
        ctx.mydshSlots.blockSwitch('扩展笔记尚未保存')
      },
    })
    const content = (scope: string) =>
      h(
        UiRuntimeContext.Provider,
        { value: runtime },
        h(PluginActions, { name: 'composer.actions', scopeKey: scope }),
        h(PluginToolResult, { item, scopeKey: scope, fallback: '原文' }),
        h(PluginNotifications),
      )
    const view = render(content('session-one'))
    try {
      expect(screen.getByText('读取结果：原文')).toBeTruthy()
      expect(screen.getByRole('status').textContent).toBe('先通知后通知')
      expect(runtime.slots.busyReasons).toEqual(['扩展笔记尚未保存'])
      view.rerender(content('session-two'))
      expect(released).toBe(1)
      await act(async () => {
        await runtime.uninstall('views')
      })
      expect(released).toBe(2)
      expect(runtime.slots.busyReasons).toEqual([])
      expect(screen.getByText('原文')).toBeTruthy()
      expect(screen.queryByRole('status')).toBeNull()
    } finally {
      cleanup()
      await runtime.dispose()
    }
  })

  it('前端候选失败时恢复上一版本，清单再次通知不会循环加载或回滚', async () => {
    const runtime = new UiRuntime()
    let current = entry('1.0.0')
    let changed: (() => void) | undefined
    let candidateLoads = 0
    const rollback = vi.fn(async () => {
      current = entry('1.0.0')
      changed?.()
      return {}
    })
    const append = document.head.append.bind(document.head)
    const appendSpy = vi.spyOn(document.head, 'append').mockImplementation((...nodes) => {
      append(...nodes)
      for (const node of nodes)
        if (node instanceof HTMLScriptElement)
          queueMicrotask(() => {
            Object.defineProperty(document, 'currentScript', { configurable: true, value: node })
            try {
              const candidate = node.src.includes('/2.0.0/')
              if (candidate) candidateLoads++
              window['__MYDSH_PLUGINS__']!.define('example.view', (_require, _module, exports) => {
                ;(exports as { apply(ctx: Context): void }).apply = ctx => {
                  if (candidate) throw new Error('候选入口无效')
                  ctx.mydshSlots.register({ name: 'modes', key: 'restored' }, '上一版')
                }
              })
            } finally {
              Reflect.deleteProperty(document, 'currentScript')
            }
            node.dispatchEvent(new Event('load'))
          })
    })
    const report = vi.fn()
    const loader = new FrontendPluginLoader(
      runtime,
      {
        getFrontendPlugins: async () => [current],
        onFrontendPluginsChanged: listener => {
          changed = listener
          return () => {}
        },
        host: { call: rollback },
      },
      report,
    )
    try {
      loader.start()
      await waitFor(() => {
        expect(runtime.slots.core.entries('modes')).toHaveLength(1)
      })
      current = entry('2.0.0', '1.0.0')
      changed?.()
      await waitFor(() => {
        expect(report).toHaveBeenCalledWith(expect.stringContaining('已恢复 1.0.0'))
      })
      changed?.()
      changed?.()
      await waitFor(() => {
        expect(runtime.slots.core.winners('modes')[0]?.component).toBe('上一版')
      })
      expect(rollback).toHaveBeenCalledExactlyOnceWith('mydshPlugins.rollback', {
        id: 'example.view',
      })
      expect(candidateLoads).toBe(1)
    } finally {
      await loader.dispose()
      await runtime.dispose()
      appendSpy.mockRestore()
    }
  })
})
