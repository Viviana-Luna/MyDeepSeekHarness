import type { Session, WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import {
  installHostPermissionHandlers,
  isAllowedHostPermission,
} from '../src/main/security/host-permissions.ts'

const targetUrl = new URL('http://127.0.0.1:3080/')

describe('DSH Host 页面权限', () => {
  it('只允许已确认 Host 顶层页面写入纯文本剪贴板', () => {
    const valid = {
      permission: 'clipboard-sanitized-write',
      requestingUrl: 'http://127.0.0.1:3080/session/example',
      currentPageUrl: 'http://127.0.0.1:3080/',
      isMainFrame: true,
      trustedWebContents: true,
    }
    expect(isAllowedHostPermission(valid, targetUrl)).toBe(true)
    expect(isAllowedHostPermission({ ...valid, permission: 'clipboard-read' }, targetUrl)).toBe(
      false,
    )
    expect(isAllowedHostPermission({ ...valid, permission: 'media' }, targetUrl)).toBe(false)
    expect(isAllowedHostPermission({ ...valid, isMainFrame: false }, targetUrl)).toBe(false)
    expect(isAllowedHostPermission({ ...valid, trustedWebContents: false }, targetUrl)).toBe(false)
    expect(
      isAllowedHostPermission(
        {
          ...valid,
          requestingUrl: 'http://127.0.0.1:3081/',
        },
        targetUrl,
      ),
    ).toBe(false)
    expect(
      isAllowedHostPermission(
        {
          ...valid,
          currentPageUrl: 'data:text/html,正在恢复',
        },
        targetUrl,
      ),
    ).toBe(false)
    expect(isAllowedHostPermission({ ...valid, requestingUrl: undefined }, targetUrl)).toBe(false)
  })

  it('权限检查和申请使用同一白名单，并在清理时移除处理器', () => {
    type CheckHandler = Exclude<Parameters<Session['setPermissionCheckHandler']>[0], null>
    type RequestHandler = Exclude<Parameters<Session['setPermissionRequestHandler']>[0], null>
    let checkHandler: CheckHandler | undefined
    let requestHandler: RequestHandler | undefined
    const setPermissionCheckHandler = vi.fn((handler: CheckHandler | null) => {
      checkHandler = handler ?? undefined
    })
    const setPermissionRequestHandler = vi.fn((handler: RequestHandler | null) => {
      requestHandler = handler ?? undefined
    })
    const session = { setPermissionCheckHandler, setPermissionRequestHandler } as unknown as Session
    let loadedUrl = targetUrl.href
    const trustedWebContents = {
      getURL: () => loadedUrl,
      isDestroyed: () => false,
    } as unknown as WebContents
    const otherWebContents = {
      getURL: () => targetUrl.href,
      isDestroyed: () => false,
    } as unknown as WebContents

    const dispose = installHostPermissionHandlers(session, trustedWebContents, targetUrl)
    expect(
      checkHandler?.(trustedWebContents, 'clipboard-sanitized-write', targetUrl.origin, {
        isMainFrame: true,
        requestingUrl: targetUrl.href,
      }),
    ).toBe(true)
    expect(
      checkHandler?.(otherWebContents, 'clipboard-sanitized-write', targetUrl.origin, {
        isMainFrame: true,
        requestingUrl: targetUrl.href,
      }),
    ).toBe(false)

    const allowed = vi.fn()
    requestHandler?.(trustedWebContents, 'clipboard-sanitized-write', allowed, {
      isMainFrame: true,
      requestingUrl: targetUrl.href,
    })
    expect(allowed).toHaveBeenCalledWith(true)

    loadedUrl = 'data:text/html,正在恢复'
    const denied = vi.fn()
    requestHandler?.(trustedWebContents, 'clipboard-sanitized-write', denied, {
      isMainFrame: true,
      requestingUrl: targetUrl.href,
    })
    expect(denied).toHaveBeenCalledWith(false)

    dispose()
    expect(setPermissionCheckHandler).toHaveBeenLastCalledWith(null)
    expect(setPermissionRequestHandler).toHaveBeenLastCalledWith(null)
  })
})
