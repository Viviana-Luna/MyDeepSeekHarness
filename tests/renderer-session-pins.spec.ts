import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PINNED_SESSION_IDS_STORAGE_KEY,
  persistPinnedSessionIds,
  readPinnedSessionIds,
  reconcilePinnedSessionIds,
  togglePinnedSessionId,
  type SessionPinStorage,
} from '../src/renderer/src/domain/session-pins.ts'

function storageMock(
  values: Record<string, string> = {},
  overrides: Partial<SessionPinStorage> = {},
): SessionPinStorage & {
  readonly getItem: ReturnType<typeof vi.fn>
  readonly setItem: ReturnType<typeof vi.fn>
} {
  const map = new Map(Object.entries(values))
  const getItem = vi.fn((key: string) => map.get(key) ?? null)
  const setItem = vi.fn((key: string, value: string) => {
    map.set(key, value)
  })

  return {
    getItem,
    setItem,
    ...overrides,
  } as SessionPinStorage & {
    readonly getItem: ReturnType<typeof vi.fn>
    readonly setItem: ReturnType<typeof vi.fn>
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('会话置顶持久化', () => {
  it('首次读取、损坏 JSON、非法结构和读取异常都返回空数组', () => {
    expect(readPinnedSessionIds(storageMock())).toEqual([])
    expect(readPinnedSessionIds(storageMock({ [PINNED_SESSION_IDS_STORAGE_KEY]: '' }))).toEqual([])
    expect(
      readPinnedSessionIds(storageMock({ [PINNED_SESSION_IDS_STORAGE_KEY]: 'not-json' })),
    ).toEqual([])
    expect(readPinnedSessionIds(storageMock({ [PINNED_SESSION_IDS_STORAGE_KEY]: '{}' }))).toEqual(
      [],
    )
    expect(
      readPinnedSessionIds(storageMock({ [PINNED_SESSION_IDS_STORAGE_KEY]: '["a",1]' })),
    ).toEqual([])
    expect(readPinnedSessionIds(storageMock({ [PINNED_SESSION_IDS_STORAGE_KEY]: '[""]' }))).toEqual(
      [],
    )
    const tooLongSessionId = 'a'.repeat(513)
    expect(
      readPinnedSessionIds(
        storageMock({
          [PINNED_SESSION_IDS_STORAGE_KEY]: JSON.stringify([tooLongSessionId]),
        }),
      ),
    ).toEqual([])
    expect(
      readPinnedSessionIds(
        storageMock(
          {},
          {
            getItem: vi.fn(() => {
              throw new Error('读取失败')
            }),
            setItem: vi.fn(),
          },
        ),
      ),
    ).toEqual([])
  })

  it('只接受严格 JSON 字符串数组并在读取时规范化去重与截断', () => {
    const storage = storageMock({
      [PINNED_SESSION_IDS_STORAGE_KEY]: JSON.stringify(['会话-3', '会话-1', '会话-3', '会话-2']),
    })

    expect(readPinnedSessionIds(storage)).toEqual(['会话-3', '会话-1', '会话-2'])

    const manySessionIds = Array.from({ length: 205 }, (_, index) => '会话-' + String(index + 1))
    const largeStorage = storageMock({
      [PINNED_SESSION_IDS_STORAGE_KEY]: JSON.stringify(manySessionIds),
    })

    const readResult = readPinnedSessionIds(largeStorage)
    expect(readResult).toHaveLength(200)
    expect(readResult[0]).toBe('会话-1')
    expect(readResult[199]).toBe('会话-200')
  })

  it('写入前先规范化，并在 setItem 异常时静默返回规范化结果', () => {
    const storage = storageMock()
    const normalized = persistPinnedSessionIds(storage, [
      '会话-2',
      '会话-1',
      '会话-2',
      '',
      '会话-3',
    ])

    expect(normalized).toEqual(['会话-2', '会话-1', '会话-3'])
    expect(storage.setItem).toHaveBeenCalledWith(
      PINNED_SESSION_IDS_STORAGE_KEY,
      JSON.stringify(['会话-2', '会话-1', '会话-3']),
    )

    const failingStorage = storageMock(
      {},
      {
        setItem: vi.fn(() => {
          throw new Error('写入失败')
        }),
      },
    )
    expect(persistPinnedSessionIds(failingStorage, ['会话-1'])).toEqual(['会话-1'])
  })

  it('切换时将新置顶放到首位，已置顶则移除，非法输入保持当前状态', () => {
    expect(togglePinnedSessionId(['会话-2', '会话-1'], '会话-3')).toEqual([
      '会话-3',
      '会话-2',
      '会话-1',
    ])
    expect(togglePinnedSessionId(['会话-2', '会话-1'], '会话-1')).toEqual(['会话-2'])
    expect(togglePinnedSessionId(['会话-2', '会话-1'], '')).toEqual(['会话-2', '会话-1'])
    expect(togglePinnedSessionId(['会话-2', '会话-1'], 'a'.repeat(513))).toEqual([
      '会话-2',
      '会话-1',
    ])
  })

  it('回收时只保留当前存在的会话并维持既有置顶顺序', () => {
    expect(
      reconcilePinnedSessionIds(
        ['会话-3', '会话-1', '会话-2', '会话-4'],
        ['会话-1', '会话-2', '会话-5'],
      ),
    ).toEqual(['会话-1', '会话-2'])

    expect(
      reconcilePinnedSessionIds(['会话-2', '会话-1', '会话-3'], ['会话-3', '会话-1', '会话-2']),
    ).toEqual(['会话-2', '会话-1', '会话-3'])

    const moreThanTwoHundredSessions = [
      ...Array.from({ length: 200 }, (_, index) => `其他会话-${String(index)}`),
      '目标会话',
    ]
    expect(reconcilePinnedSessionIds(['目标会话'], moreThanTwoHundredSessions)).toEqual([
      '目标会话',
    ])
  })
})
