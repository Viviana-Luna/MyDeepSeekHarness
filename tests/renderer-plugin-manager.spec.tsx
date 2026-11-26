// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { DesktopBridge } from '../src/renderer/src/platform/contracts.ts'
import { useRuntimePlugins } from '../src/renderer/src/features/plugins/useRuntimePlugins.ts'

afterEach(() => {
  cleanup()
  delete window.dshDesktop
})

it('插件清单只接受最新读取，离开页面后释放订阅并忽略迟到结果', async () => {
  const pending: Array<(value: unknown) => void> = []
  let changed: (() => void) | undefined
  const release = vi.fn()
  window.dshDesktop = {
    version: 11,
    host: {
      call: vi.fn(
        () =>
          new Promise(resolve => {
            pending.push(resolve)
          }),
      ),
    },
    onFrontendPluginsChanged: (listener: () => void) => {
      changed = listener
      return release
    },
  } as unknown as DesktopBridge
  const { result, unmount } = renderHook(useRuntimePlugins)
  await act(async () => {
    changed?.()
  })
  await act(async () => {
    pending[1]!([{ id: 'newer' }])
  })
  await waitFor(() => expect(result.current.plugins[0]?.id).toBe('newer'))
  await act(async () => {
    pending[0]!([{ id: 'older' }])
  })
  expect(result.current.plugins[0]?.id).toBe('newer')
  await act(async () => {
    changed?.()
  })
  unmount()
  expect(release).toHaveBeenCalledOnce()
  await act(async () => {
    pending[2]!([{ id: 'late' }])
  })
  expect(result.current.plugins[0]?.id).toBe('newer')
})
