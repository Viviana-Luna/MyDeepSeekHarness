// @vitest-environment jsdom

/** 验证精简后的空会话视图结构、像素工坊画布挂载与主题色同步，以及像素图元、网格排布与主题色板纯函数。 */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildPixelWorkshopGrid,
  PIXEL_WORKSHOP_SPRITES,
  resolveWorkshopPalette,
  WORKSHOP_CELL_SIZE,
  WORKSHOP_CLEAR_RADIUS,
  type PixelSpriteDefinition,
} from '../src/renderer/src/features/conversation/pixel-workshop-sprites.ts'
import type { WorkspaceSnapshot } from '../src/renderer/src/models/workspace/store.ts'

vi.mock('../src/renderer/src/hooks/useWorkspace.ts', () => ({
  useWorkspaceStore: () => ({}),
  useWorkspaceSnapshot: () => ({}),
}))
vi.mock('../src/renderer/src/features/project-workspace/ProjectWorkspaceProvider.tsx', () => ({
  useProjectWorkspace: () => ({ openFileFromConversation: vi.fn() }),
}))
vi.mock('../src/renderer/src/features/conversation/ConversationView.tsx', () => ({
  ConversationView: ({ emptyState }: { emptyState: React.ReactNode }) => emptyState,
}))
vi.mock(
  '../src/renderer/src/pages/workspace/components/rightpanel/chat-rightpanel/SessionPresetPicker.tsx',
  () => ({
    SessionPresetPicker: () => <div>预设选择</div>,
  }),
)

import { ChatMainPanel } from '../src/renderer/src/pages/workspace/components/mainpanel/chat-mainpanel/index.tsx'

afterEach(() => {
  cleanup()
  document.documentElement.style.removeProperty('--accent')
  vi.clearAllMocks()
})

function countLitRowPixels(sprite: PixelSpriteDefinition, row: string): number {
  expect(row).toHaveLength(sprite.width)
  if (sprite.colorMap === undefined) {
    expect(row).toMatch(/^[.123]+$/u)
    return row.replaceAll('.', '').length
  }
  let litPixels = 0
  for (const ch of row) {
    if (ch === '.') continue
    expect(sprite.colorMap.dark[ch]).toMatch(/^#[0-9a-f]{6}$/iu)
    expect(sprite.colorMap.light[ch]).toMatch(/^#[0-9a-f]{6}$/iu)
    litPixels += 1
  }
  return litPixels
}

describe('空会话页面与像素工坊背景', () => {
  it('不再渲染起手建议卡片与点阵徽章，并在新会话、已有空会话和未选会话态正确呈现背景画布与预设槽', () => {
    const newSessionSnapshot = {
      sessions: [],
      projects: [{ id: '项目-1', name: '项目' }],
      selectedProjectId: '项目-1',
      newSessionProjectId: '项目-1',
    } as unknown as WorkspaceSnapshot

    const view = render(<ChatMainPanel snapshot={newSessionSnapshot} history={[]} />)
    expect(screen.getByRole('heading', { name: '在 项目 中开始新会话' })).toBeTruthy()
    expect(screen.getByText('预设选择')).toBeTruthy()
    expect(screen.queryByRole('group', { name: '起手建议' })).toBeNull()
    const stage = document.querySelector<HTMLElement>('[aria-label="空会话"]')
    const content = stage?.querySelector<HTMLElement>(':scope > div')
    expect(content?.querySelector(':scope > [aria-hidden="true"]')).toBeNull()
    expect(content?.firstElementChild?.tagName).toBe('H2')
    const canvas = document.querySelector<HTMLCanvasElement>('canvas[data-pixel-workshop="true"]')
    expect(canvas).toBeTruthy()
    expect(canvas?.dataset.accent).toMatch(/^#[0-9a-f]{6}$/u)

    const blankSessionSnapshot = {
      selectedSessionId: '会话-2',
      sessions: [{ sessionId: '会话-2', blank: true }],
      projects: [],
      awaitingResponseSessionIds: [],
      historyError: null,
    } as unknown as WorkspaceSnapshot

    view.rerender(<ChatMainPanel snapshot={blankSessionSnapshot} history={[]} />)
    expect(screen.getByRole('heading', { name: '这个对话还没有消息' })).toBeTruthy()
    expect(screen.getByText('在下方输入任务，开始这段对话。')).toBeTruthy()
    expect(screen.getByText('预设选择')).toBeTruthy()
    expect(screen.queryByRole('group', { name: '起手建议' })).toBeNull()
    expect(document.querySelector('canvas[data-pixel-workshop="true"]')).toBeTruthy()

    view.rerender(
      <ChatMainPanel
        snapshot={{ ...blankSessionSnapshot, selectedSessionId: null }}
        history={[]}
      />,
    )
    expect(screen.getByRole('heading', { name: '从一个项目聊天开始' })).toBeTruthy()
    expect(screen.queryByText('预设选择')).toBeNull()
    expect(document.querySelector('canvas[data-pixel-workshop="true"]')).toBeTruthy()
  })

  it('像素工坊画布在挂载与根节点 --accent 变更时实时同步 data-accent', async () => {
    document.documentElement.style.setProperty('--accent', '#2f9d77')
    const snapshot = {
      selectedSessionId: '会话-2',
      sessions: [{ sessionId: '会话-2', blank: true }],
      projects: [],
      awaitingResponseSessionIds: [],
      historyError: null,
    } as unknown as WorkspaceSnapshot

    render(<ChatMainPanel snapshot={snapshot} history={[]} />)
    const canvas = document.querySelector<HTMLCanvasElement>('canvas[data-pixel-workshop="true"]')
    expect(canvas?.dataset.accent).toBe('#2f9d77')

    document.documentElement.style.setProperty('--accent', '#d97745')
    await waitFor(() => expect(canvas?.dataset.accent).toBe('#d97745'))

    document.documentElement.style.setProperty('--accent', '#8069d4')
    await waitFor(() => expect(canvas?.dataset.accent).toBe('#8069d4'))
  })

  it('全部 14 套像素图元（含大肥鱼与 Token 票）非空，帧尺寸与明暗色表覆盖合法', () => {
    expect(PIXEL_WORKSHOP_SPRITES).toHaveLength(14)
    const ids = new Set(PIXEL_WORKSHOP_SPRITES.map(sprite => sprite.id))
    expect(ids.size).toBe(14)
    expect(ids.has('feiyu')).toBe(true)
    expect(ids.has('token-ticket')).toBe(true)

    for (const sprite of PIXEL_WORKSHOP_SPRITES) {
      expect(sprite.width).toBeGreaterThan(0)
      expect(sprite.height).toBeGreaterThan(0)
      expect(sprite.frames.length).toBeGreaterThanOrEqual(2)
      if (sprite.hoverGlow !== undefined) {
        expect(sprite.hoverGlow.dark).toMatch(/^#[0-9a-f]{6}$/iu)
        expect(sprite.hoverGlow.light).toMatch(/^#[0-9a-f]{6}$/iu)
      }
      for (const frame of sprite.frames) {
        expect(frame).toHaveLength(sprite.height)
        const litPixels = frame.reduce((sum, row) => sum + countLitRowPixels(sprite, row), 0)
        expect(litPixels).toBeGreaterThan(0)
      }
    }
  })

  it('网格排布保持中央留白无图元，默认窗与宽窗 2×2 大格包含大肥鱼与 Token 票且零遮挡', () => {
    const layout = buildPixelWorkshopGrid(1200, 900)
    const repeat = buildPixelWorkshopGrid(1200, 900)
    expect(layout.cellSize).toBe(WORKSHOP_CELL_SIZE)
    expect(layout.cells.map(cell => cell.key)).toEqual(repeat.cells.map(cell => cell.key))

    const showcase = layout.cells.filter(cell => cell.span === 2)
    const regular = layout.cells.filter(cell => cell.span === 1)
    expect(showcase.length).toBeGreaterThanOrEqual(2)
    expect(showcase.length).toBeLessThanOrEqual(3)
    expect(regular.length).toBeGreaterThan(0)
    expect(showcase.map(cell => cell.sprite.id)).toContain('feiyu')
    expect(showcase.map(cell => cell.sprite.id)).toContain('token-ticket')
    expect(regular.some(cell => cell.sprite.id === 'feiyu')).toBe(false)

    const occupiedSlots = new Set<string>()
    for (const cell of layout.cells) {
      expect(cell.normalizedDist).toBeGreaterThanOrEqual(WORKSHOP_CLEAR_RADIUS)
      expect(cell.x).toBeGreaterThanOrEqual(0)
      expect(cell.y).toBeGreaterThanOrEqual(0)
      expect(cell.x + cell.size).toBeLessThanOrEqual(layout.width)
      expect(cell.y + cell.size).toBeLessThanOrEqual(layout.height)
      expect(cell.pixelSize).toBe(cell.span === 2 ? 5 : 3)
      for (let dc = 0; dc < cell.span; dc += 1) {
        for (let dr = 0; dr < cell.span; dr += 1) {
          const slot = `${String(cell.col + dc)},${String(cell.row + dr)}`
          expect(occupiedSlots.has(slot)).toBe(false)
          occupiedSlots.add(slot)
        }
      }
    }

    // 2×2 大格彼此保持间隔，不紧贴粘连。
    for (let i = 0; i < showcase.length; i += 1) {
      for (let j = i + 1; j < showcase.length; j += 1) {
        const a = showcase[i]!
        const b = showcase[j]!
        const colGap = Math.max(a.col - (b.col + 2), b.col - (a.col + 2))
        const rowGap = Math.max(a.row - (b.row + 2), b.row - (a.row + 2))
        expect(Math.max(colGap, rowGap)).toBeGreaterThanOrEqual(1)
      }
    }

    // 1280×800 默认窗（中央画布约 674×742）下，2×2 大格包含大肥鱼与 Token 票，且中央前景区域零遮挡。
    const defaultCanvas = buildPixelWorkshopGrid(674, 742)
    const defaultShowcase = defaultCanvas.cells.filter(cell => cell.span === 2)
    expect(defaultShowcase.length).toBeGreaterThanOrEqual(2)
    expect(defaultShowcase.map(cell => cell.sprite.id)).toContain('feiyu')
    expect(defaultShowcase.map(cell => cell.sprite.id)).toContain('token-ticket')
    expect(defaultCanvas.cells.some(cell => cell.span === 1 && cell.sprite.id === 'feiyu')).toBe(
      false,
    )
    for (const cell of defaultCanvas.cells) {
      const cx = cell.x + cell.size / 2
      const cy = cell.y + cell.size / 2
      const half = cell.size * 0.32
      const overlapsHeader =
        cx + half > defaultCanvas.focalX - 140 &&
        cx - half < defaultCanvas.focalX + 140 &&
        cy + half > defaultCanvas.focalY - 80 &&
        cy - half < defaultCanvas.focalY + 8
      const overlapsPresetSlider =
        cx + half > defaultCanvas.focalX - 245 &&
        cx - half < defaultCanvas.focalX + 245 &&
        cy + half > defaultCanvas.focalY - 15 &&
        cy - half < defaultCanvas.focalY + 60
      expect(overlapsHeader).toBe(false)
      expect(overlapsPresetSlider).toBe(false)
    }
  })

  it('明暗主题色板跟随用户自定义 --accent 并提供 6 组阶梯色彩', () => {
    const darkBlue = resolveWorkshopPalette('#4d6bfe', true)
    const darkGreen = resolveWorkshopPalette('#2f9d77', true)
    const lightGreen = resolveWorkshopPalette('#2f9d77', false)

    expect(darkBlue.tones).toHaveLength(6)
    expect(darkGreen.tones).toHaveLength(6)
    expect(lightGreen.tones).toHaveLength(6)
    expect(darkBlue.accent).toBe('#4d6bfe')
    expect(darkGreen.accent).toBe('#2f9d77')
    expect(darkBlue.tones[0]?.primary).not.toBe(darkGreen.tones[0]?.primary)
    expect(darkGreen.gridLine).not.toBe(lightGreen.gridLine)
    expect(darkGreen.tones[1]?.primary).not.toBe(lightGreen.tones[1]?.primary)
    expect(darkGreen.hoverAlpha).toBeGreaterThan(darkGreen.restAlpha)
    expect(darkGreen.neighborAlpha).toBeGreaterThan(darkGreen.restAlpha)
  })
})
