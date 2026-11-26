/**
 * 空会话像素工坊背景的纯数据与排布模块：汇总 14 套多帧像素图元（含蓝色大肥鱼与 Token 票）、
 * 确定性大小格排布及明暗主题色板。运行在 renderer（无 DOM 副作用，可直接单测），不持有外部资源。
 */
import {
  PIXEL_WORKSHOP_MASCOTS,
  type MascotSpriteId,
  type PixelSpriteColorMap,
  type PixelSpriteHoverGlow,
} from './pixel-workshop-mascots.ts'

export type { PixelSpriteColorMap, PixelSpriteHoverGlow }

/** 单个多帧像素图元的定义；`.` 为透明，普通图元用 `1`/`2`/`3` 映射主题三阶色，多色图元优先读取 `colorMap`。 */
export interface PixelSpriteDefinition {
  readonly id:
    | MascotSpriteId
    | 'whale'
    | 'sparkle'
    | 'terminal'
    | 'braces'
    | 'planet'
    | 'gear'
    | 'hourglass'
    | 'matrix'
    | 'wave'
    | 'glider'
    | 'cube'
    | 'bot'
  readonly width: number
  readonly height: number
  readonly frames: readonly (readonly string[])[]
  readonly colorMap?: PixelSpriteColorMap
  readonly hoverGlow?: PixelSpriteHoverGlow
  readonly showcaseOnly?: boolean
}

/** 网格中单个放置图元的单元格几何与节奏描述（`span` 为 1 表示常规格，2 表示 2×2 展示大格）。 */
export interface WorkshopCell {
  readonly key: string
  readonly col: number
  readonly row: number
  readonly span: 1 | 2
  readonly x: number
  readonly y: number
  readonly size: number
  readonly sprite: PixelSpriteDefinition
  readonly pixelSize: 3 | 5
  readonly toneIndex: number
  readonly frameDurationMs: number
  readonly phaseOffsetMs: number
  readonly normalizedDist: number
}

/** 根据容器尺寸计算出的对称基准网格及全部已放置图元列表。 */
export interface WorkshopGridLayout {
  readonly width: number
  readonly height: number
  readonly cellSize: number
  readonly cols: number
  readonly rows: number
  readonly originX: number
  readonly originY: number
  readonly focalX: number
  readonly focalY: number
  readonly focalRx: number
  readonly focalRy: number
  readonly cells: readonly WorkshopCell[]
}

/** 单组图元所使用的三阶像素色值。 */
export interface WorkshopTone {
  readonly primary: string
  readonly secondary: string
  readonly soft: string
}

/** 根据当前主题色与明暗模式解析出的完整画布配色与透明度参数。 */
export interface WorkshopPalette {
  readonly accent: string
  readonly isDark: boolean
  readonly tones: readonly WorkshopTone[]
  readonly gridLine: string
  readonly gridLineActive: string
  readonly hoverFill: string
  readonly hoverCorner: string
  readonly rippleStroke: string
  readonly restAlpha: number
  readonly hoverAlpha: number
  readonly neighborAlpha: number
}

/** 基准方格边长（像素），用于维持不同窗口宽度下的统一节奏。 */
export const WORKSHOP_CELL_SIZE = 88

/** 中央焦点椭圆留白半径阈值；小于此值的格子不放置图元，仅保留极淡渐隐网格线。 */
export const WORKSHOP_CLEAR_RADIUS = 0.42

function parseFrames(rawFrames: readonly string[]): readonly (readonly string[])[] {
  return rawFrames.map(frame => frame.split('|'))
}

function defineSprite(
  id: PixelSpriteDefinition['id'],
  width: number,
  height: number,
  rawFrames: readonly string[],
): PixelSpriteDefinition {
  return { id, width, height, frames: parseFrames(rawFrames) }
}

/** 手工设计的 14 套多帧像素工坊图元清单（包含大肥鱼与 Token 票品牌多色图元）。 */
export const PIXEL_WORKSHOP_SPRITES: readonly PixelSpriteDefinition[] = [
  ...PIXEL_WORKSHOP_MASCOTS,
  defineSprite('whale', 13, 9, [
    '.............|.............|.....2.......|...111111....|..11111111.1.|.11311111111.|.111111111111|..12222111.1.|...111111....',
    '.............|....2.2......|.....2.......|...111111....|..11111111..1|.11311111111.|.11111111111.|..12222111.11|...111111....',
    '...2...2.....|..2..2..2....|.............|...111111....|..11111111.11|.11311111111.|.11111111111.|..12222111..1|...111111....',
    '..3.....3....|.............|.............|...111111....|..11111111.1.|.113111111111|.11111111111.|..12222111.1.|...111111....',
  ]),
  defineSprite('sparkle', 9, 9, [
    '.........|....1....|.3..1..3.|...121...|.1122211.|...121...|.3..1..3.|....1....|.........',
    '....1....|....1....|...121...|..12221..|112232211|..12221..|...121...|....1....|....1....',
    '....2....|.2..1..2.|...121...|..12321..|212333212|..12321..|...121...|.2..1..2.|....2....',
    '....1....|....1....|.2.121.2.|...222...|112232211|...222...|.2.121.2.|....1....|....1....',
  ]),
  defineSprite('terminal', 11, 9, [
    '.111111111.|1.3.3.....1|11111111111|1.........1|1.2...22..1|1..2..22..1|1.2...22..1|1.........1|.111111111.',
    '.111111111.|1.3.3.....1|11111111111|1.........1|1.2.......1|1..2......1|1.2...33..1|1.........1|.111111111.',
    '.111111111.|1.3.3.....1|11111111111|1.........1|1.2....22.1|1..2.3.22.1|1.2....22.1|1.........1|.111111111.',
    '.111111111.|1.3.3.....1|11111111111|1.........1|1.2.......1|1..2.3....1|1.2.......1|1.........1|.111111111.',
  ]),
  defineSprite('braces', 11, 9, [
    '..11...11..|.1.......1.|.1.......1.|.1.......1.|1..2.3.3..1|.1.......1.|.1.......1.|.1.......1.|..11...11..',
    '..11...11..|.1.......1.|.1.......1.|.1.......1.|1..3.2.3..1|.1.......1.|.1.......1.|.1.......1.|..11...11..',
    '..11...11..|.1.......1.|.1.......1.|.1.......1.|1..3.3.2..1|.1.......1.|.1.......1.|.1.......1.|..11...11..',
    '..11...11..|.1.......1.|.1.......1.|.1...2...1.|1..3...3..1|.1.......1.|.1.......1.|.1.......1.|..11...11..',
  ]),
  defineSprite('planet', 13, 11, [
    '.............|.............|.....111..33.|....111113..3|...1111111..3|...1111111.3.|..311111113..|.3..111113...|3233.111.....|.33..........|.............',
    '.............|.............|.....111..33.|....111113..3|...1111111..3|...1111111.3.|..311111113..|.3..211113...|3.33.111.....|.33..........|.............',
    '.............|.............|.....111..33.|....111113..3|...1111111..3|...1111121.3.|..311111113..|.3..111113...|3.33.111.....|.33..........|.............',
    '.............|.............|.....111..33.|....111113.23|...1111111..3|...1111111.3.|..311111113..|.3..111113...|3.33.111.....|.33..........|.............',
    '.............|.........2...|.....111..33.|....111113..3|...1111111..3|...1111111.3.|..311111113..|.3..111113...|3.33.111.....|.33..........|.............',
    '.............|.............|.....111..33.|....111113..3|..21111111..3|...1111111.3.|..311111113..|.3..111113...|3.33.111.....|.33..........|.............',
  ]),
  defineSprite('gear', 11, 11, [
    '....111....|....111....|..1111111..|..1122211..|1112...2111|1112...2111|1112...2111|..1122211..|..1111111..|....111....|....111....',
    '.11.....11.|111..1..111|11111111111|..1122211..|..12...21..|.112...211.|..12...21..|..1122211..|11111111111|111..1..111|.11.....11.',
  ]),
  defineSprite('hourglass', 9, 11, [
    '111111111|.1.....1.|.1222221.|..12221..|...121...|....1....|...1.1...|..1...1..|.1.....1.|.1..3..1.|111111111',
    '111111111|.1.....1.|.1.222.1.|..12221..|...121...|....2....|...1.1...|..1.2.1..|.1..2..1.|.1.222.1.|111111111',
    '111111111|.1.....1.|.1.....1.|..1.2.1..|...121...|....2....|...121...|..1.2.1..|.1.222.1.|.1222221.|111111111',
    '111111111|.1.....1.|.1.....1.|..1...1..|...1.1...|....1....|...1.1...|..1.2.1..|.1222221.|.1222221.|111111111',
  ]),
  defineSprite('matrix', 9, 9, [
    '3.3.3.3.3|.........|3.3.1.3.3|.........|3.1.2.1.3|.........|3.3.1.3.3|.........|3.3.3.3.3',
    '3.3.1.3.3|.........|3.2.2.2.3|.........|1.2.1.2.1|.........|3.2.2.2.3|.........|3.3.1.3.3',
    '2.2.2.2.2|.........|2.1.1.1.2|.........|2.1.3.1.2|.........|2.1.1.1.2|.........|2.2.2.2.2',
    '1.3.3.3.1|.........|3.3.3.3.3|.........|3.3.1.3.3|.........|3.3.3.3.3|.........|1.3.3.3.1',
  ]),
  defineSprite('wave', 11, 9, [
    '...........|.......2...|...2...1...|...1...1...|...1.2.1...|.2.1.1.1...|.1.1.1.1.2.|.1.1.1.1.1.|.3.3.3.3.3.',
    '...........|.....2.....|.....1.....|.2...1.2...|.1.2.1.1.2.|.1.1.1.1.1.|.1.1.1.1.1.|.1.1.1.1.1.|.3.3.3.3.3.',
    '...........|.2.........|.1.......2.|.1...2...1.|.1...1...1.|.1.2.1.2.1.|.1.1.1.1.1.|.1.1.1.1.1.|.3.3.3.3.3.',
    '...........|...2.......|...1...2...|...1...1...|.2.1...1...|.1.1.2.1.2.|.1.1.1.1.1.|.1.1.1.1.1.|.3.3.3.3.3.',
  ]),
  defineSprite('glider', 11, 11, [
    '...........|.....11111.|........21.|.......121.|......11.1.|.....11..1.|....31.....|...3.......|..3........|...........|...........',
    '......11111|.........21|........121|.......11.1|......11..1|.....21....|....3......|...3.......|...........|...........|...........',
    '......21111|.........22|........121|.......11.1|.....211..1|....3......|..3..3.....|...........|...........|...........|...........',
    '...........|.....11111.|........11.|.......121.|......11.1.|.....11..1.|....2......|..3........|.3.........|...........|...........',
  ]),
  defineSprite('cube', 11, 11, [
    '.....2.....|...32223...|.333333333.|11333333331|11113331111|11111311111|11111311111|11111311111|.111131111.|...11311...|.....3.....',
    '.....3.....|...33322...|.333333322.|11333333231|11113331111|11111311111|11111311111|11111311111|.111131111.|...11311...|.....3.....',
    '.....3.....|...33333...|.333333333.|11333233331|11112221111|11111211111|11111311111|11111311111|.111131111.|...11311...|.....3.....',
    '.....3.....|...22333...|.223333333.|11323333331|11113331111|11111311111|11111311111|11111311111|.111131111.|...11311...|.....3.....',
  ]),
  defineSprite('bot', 11, 9, [
    '.....3.....|.....1.....|..1111111..|.1.......1.|11.2...2.11|11.......11|.1..333..1.|..1111111..|...........',
    '....323....|.....1.....|..1111111..|.1.......1.|11.2...2.11|11.......11|.1..333..1.|..1111111..|...........',
    '.....2.....|.....1.....|..1111111..|.1.......1.|11.33.33.11|11.......11|.1..333..1.|..1111111..|...........',
    '.....3.....|.....1.....|..1111111..|.1.......1.|11.2...2.11|11.......11|.1.32223.1.|..1111111..|...........',
  ]),
]

const SPRITE_BY_ID = new Map(PIXEL_WORKSHOP_SPRITES.map(sprite => [sprite.id, sprite]))
const REGULAR_WORKSHOP_SPRITES = PIXEL_WORKSHOP_SPRITES.filter(
  sprite => sprite.showcaseOnly !== true,
)
const SHOWCASE_IDS: readonly PixelSpriteDefinition['id'][] = ['feiyu', 'token-ticket', 'whale']

function gridHash(col: number, row: number, salt: number): number {
  let value = (col * 374_761_393 + row * 668_265_263 + salt * 2_246_822_519) | 0
  value = Math.imul(value ^ (value >>> 13), 1_274_126_177)
  return (value ^ (value >>> 16)) >>> 0
}

function focalDistance(
  x: number,
  y: number,
  focal: { readonly x: number; readonly y: number; readonly rx: number; readonly ry: number },
): number {
  return Math.hypot((x - focal.x) / focal.rx, (y - focal.y) / focal.ry)
}

interface SafeRect {
  readonly left: number
  readonly right: number
  readonly top: number
  readonly bottom: number
}

function foregroundSafeRects(focal: FocalEllipse, width: number): readonly SafeRect[] {
  // 分别保护中央「标题与说明」与宽约 460px 的「预设滑块」，避免 1280×800 默认窗下图元半露在文字或胶囊背后。
  const headerHalfWidth = Math.min(140, width * 0.24)
  const sliderHalfWidth = Math.min(268, width * 0.415)
  return [
    {
      left: focal.x - headerHalfWidth,
      right: focal.x + headerHalfWidth,
      top: focal.y - 80,
      bottom: focal.y + 8,
    },
    {
      left: focal.x - sliderHalfWidth,
      right: focal.x + sliderHalfWidth,
      top: focal.y - 32,
      bottom: focal.y + 62,
    },
  ]
}

function intersectsForegroundSafeZone(
  cellBox: { readonly x: number; readonly y: number; readonly size: number },
  focal: FocalEllipse,
  canvasWidth: number,
): boolean {
  const cx = cellBox.x + cellBox.size / 2
  const cy = cellBox.y + cellBox.size / 2
  const half = cellBox.size * 0.32
  for (const rect of foregroundSafeRects(focal, canvasWidth)) {
    if (
      cx + half > rect.left &&
      cx - half < rect.right &&
      cy + half > rect.top &&
      cy - half < rect.bottom
    ) {
      return true
    }
  }
  return false
}

function canPlaceShowcase(
  anchor: { readonly col: number; readonly row: number },
  bounds: GridBounds,
  focal: FocalEllipse,
  placed: readonly { readonly col: number; readonly row: number }[],
): boolean {
  if (
    anchor.col < 0 ||
    anchor.row < 0 ||
    anchor.col + 2 > bounds.cols ||
    anchor.row + 2 > bounds.rows
  ) {
    return false
  }
  for (const existing of placed) {
    // 2×2 大格之间至少间隔 1 格，避免视觉粘连。
    const colGap = Math.max(anchor.col - (existing.col + 2), existing.col - (anchor.col + 2))
    const rowGap = Math.max(anchor.row - (existing.row + 2), existing.row - (anchor.row + 2))
    if (colGap < 1 && rowGap < 1) return false
  }
  const box = {
    x: bounds.originX + anchor.col * WORKSHOP_CELL_SIZE,
    y: bounds.originY + anchor.row * WORKSHOP_CELL_SIZE,
    size: WORKSHOP_CELL_SIZE * 2,
  }
  if (intersectsForegroundSafeZone(box, focal, bounds.width)) return false
  for (let dc = 0; dc < 2; dc += 1) {
    for (let dr = 0; dr < 2; dr += 1) {
      const cx = bounds.originX + (anchor.col + dc + 0.5) * WORKSHOP_CELL_SIZE
      const cy = bounds.originY + (anchor.row + dr + 0.5) * WORKSHOP_CELL_SIZE
      if (focalDistance(cx, cy, focal) < WORKSHOP_CLEAR_RADIUS + 0.04) return false
    }
  }
  return true
}

function pickShowcaseAnchors(
  bounds: GridBounds,
  focal: FocalEllipse,
): readonly { readonly col: number; readonly row: number }[] {
  if (bounds.cols < 6 || bounds.rows < 5) return []
  const midRow = Math.max(0, Math.floor((bounds.rows - 2) / 2))
  const candidates: readonly { readonly col: number; readonly row: number }[] =
    bounds.cols >= 9
      ? [
          { col: 1, row: 0 },
          { col: bounds.cols - 2, row: midRow },
          { col: 0, row: bounds.rows - 2 },
          { col: bounds.cols - 2, row: 0 },
        ]
      : [
          { col: 0, row: 0 },
          { col: bounds.cols - 2, row: 0 },
          { col: 0, row: Math.max(0, bounds.rows - 3) },
          { col: bounds.cols - 2, row: Math.max(0, bounds.rows - 3) },
        ]
  const chosen: { readonly col: number; readonly row: number }[] = []
  for (const anchor of candidates) {
    if (chosen.length >= 3) break
    if (canPlaceShowcase(anchor, bounds, focal, chosen)) chosen.push(anchor)
  }
  return chosen
}

function pickToneIndex(spriteId: PixelSpriteDefinition['id'], hash: number): number {
  if (spriteId === 'whale') return 0
  // 约 35% 普通格使用用户主题色，其余分散到 5 组低饱和辅色。
  if (hash % 100 < 35) return 0
  return 1 + (hash % 5)
}

function chooseNonAdjacentSprite(
  col: number,
  row: number,
  slotSprites: ReadonlyMap<string, PixelSpriteDefinition['id']>,
): PixelSpriteDefinition {
  const blocked = new Set<PixelSpriteDefinition['id']>()
  for (const [dc, dr] of [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ] as const) {
    const neighbor = slotSprites.get(`${String(col + dc)},${String(row + dr)}`)
    if (neighbor !== undefined) blocked.add(neighbor)
  }
  const baseIndex = gridHash(col, row, 17) % REGULAR_WORKSHOP_SPRITES.length
  for (let offset = 0; offset < REGULAR_WORKSHOP_SPRITES.length; offset += 1) {
    const candidate =
      REGULAR_WORKSHOP_SPRITES[(baseIndex + offset) % REGULAR_WORKSHOP_SPRITES.length]!
    if (!blocked.has(candidate.id)) return candidate
  }
  return REGULAR_WORKSHOP_SPRITES[baseIndex]!
}

interface GridBounds {
  readonly width: number
  readonly cols: number
  readonly rows: number
  readonly originX: number
  readonly originY: number
}

interface FocalEllipse {
  readonly x: number
  readonly y: number
  readonly rx: number
  readonly ry: number
}

function placeShowcaseCells(
  bounds: GridBounds,
  focal: FocalEllipse,
  occupied: Set<string>,
  slotSprites: Map<string, PixelSpriteDefinition['id']>,
): WorkshopCell[] {
  const cells: WorkshopCell[] = []
  pickShowcaseAnchors(bounds, focal).forEach((anchor, index) => {
    const spriteId = SHOWCASE_IDS[index % SHOWCASE_IDS.length]!
    const sprite = SPRITE_BY_ID.get(spriteId)!
    const hash = gridHash(anchor.col, anchor.row, 31)
    const size = WORKSHOP_CELL_SIZE * 2
    const x = bounds.originX + anchor.col * WORKSHOP_CELL_SIZE
    const y = bounds.originY + anchor.row * WORKSHOP_CELL_SIZE
    cells.push({
      key: `${String(anchor.col)},${String(anchor.row)}:2`,
      col: anchor.col,
      row: anchor.row,
      span: 2,
      x,
      y,
      size,
      sprite,
      pixelSize: 5,
      toneIndex: spriteId === 'whale' ? 0 : 1 + (index % 5),
      frameDurationMs: 560 + (hash % 280),
      phaseOffsetMs: hash % 3600,
      normalizedDist: focalDistance(x + size / 2, y + size / 2, focal),
    })
    for (let dc = 0; dc < 2; dc += 1) {
      for (let dr = 0; dr < 2; dr += 1) {
        const slot = `${String(anchor.col + dc)},${String(anchor.row + dr)}`
        occupied.add(slot)
        slotSprites.set(slot, spriteId)
      }
    }
  })
  return cells
}

function placeRegularCells(
  bounds: GridBounds,
  focal: FocalEllipse,
  occupied: ReadonlySet<string>,
  slotSprites: Map<string, PixelSpriteDefinition['id']>,
): WorkshopCell[] {
  const cells: WorkshopCell[] = []
  for (let row = 0; row < bounds.rows; row += 1) {
    for (let col = 0; col < bounds.cols; col += 1) {
      const slot = `${String(col)},${String(row)}`
      if (occupied.has(slot)) continue
      const x = bounds.originX + col * WORKSHOP_CELL_SIZE
      const y = bounds.originY + row * WORKSHOP_CELL_SIZE
      const dist = focalDistance(x + WORKSHOP_CELL_SIZE / 2, y + WORKSHOP_CELL_SIZE / 2, focal)
      if (dist < WORKSHOP_CLEAR_RADIUS) continue
      if (intersectsForegroundSafeZone({ x, y, size: WORKSHOP_CELL_SIZE }, focal, bounds.width)) {
        continue
      }
      if (gridHash(col, row, 7) % 100 >= 40) continue
      const sprite = chooseNonAdjacentSprite(col, row, slotSprites)
      const rhythmHash = gridHash(col, row, 53)
      slotSprites.set(slot, sprite.id)
      cells.push({
        key: `${slot}:1`,
        col,
        row,
        span: 1,
        x,
        y,
        size: WORKSHOP_CELL_SIZE,
        sprite,
        pixelSize: 3,
        toneIndex: pickToneIndex(sprite.id, gridHash(col, row, 97)),
        frameDurationMs: 520 + (rhythmHash % 361),
        phaseOffsetMs: rhythmHash % 4000,
        normalizedDist: dist,
      })
    }
  }
  return cells
}

/**
 * 为指定容器宽高生成确定性的像素工坊网格：对称居中偏移、中央焦点留白、
 * 宽窗外围 2～3 个不相邻 2×2 展示大格，以及约 40% 稀疏填充的 1×1 常规格。
 */
export function buildPixelWorkshopGrid(width: number, height: number): WorkshopGridLayout {
  const safeWidth = Math.max(0, Math.floor(width))
  const safeHeight = Math.max(0, Math.floor(height))
  const cols = Math.floor(safeWidth / WORKSHOP_CELL_SIZE)
  const rows = Math.floor(safeHeight / WORKSHOP_CELL_SIZE)
  const originX = Math.floor((safeWidth - cols * WORKSHOP_CELL_SIZE) / 2)
  const originY = Math.floor((safeHeight - rows * WORKSHOP_CELL_SIZE) / 2)
  const focal: FocalEllipse = {
    x: safeWidth * 0.5,
    y: safeHeight * 0.45,
    rx: Math.max(WORKSHOP_CELL_SIZE * 2, safeWidth * 0.48),
    ry: Math.max(WORKSHOP_CELL_SIZE * 1.6, safeHeight * 0.44),
  }
  const baseLayout = {
    width: safeWidth,
    height: safeHeight,
    cellSize: WORKSHOP_CELL_SIZE,
    cols,
    rows,
    originX: cols > 0 ? originX : 0,
    originY: rows > 0 ? originY : 0,
    focalX: focal.x,
    focalY: focal.y,
    focalRx: focal.rx,
    focalRy: focal.ry,
  }
  if (cols <= 0 || rows <= 0) return { ...baseLayout, cells: [] }

  const bounds: GridBounds = { width: safeWidth, cols, rows, originX, originY }
  const occupied = new Set<string>()
  const slotSprites = new Map<string, PixelSpriteDefinition['id']>()
  const showcase = placeShowcaseCells(bounds, focal, occupied, slotSprites)
  const regular = placeRegularCells(bounds, focal, occupied, slotSprites)
  return { ...baseLayout, cells: [...showcase, ...regular] }
}

function parseHexRgb(hex: string): readonly [number, number, number] {
  const cleaned = hex.trim().replace(/^#/u, '')
  if (/^[0-9a-f]{3}$/iu.test(cleaned)) {
    return [
      Number.parseInt(cleaned[0]! + cleaned[0]!, 16),
      Number.parseInt(cleaned[1]! + cleaned[1]!, 16),
      Number.parseInt(cleaned[2]! + cleaned[2]!, 16),
    ]
  }
  if (/^[0-9a-f]{6}$/iu.test(cleaned)) {
    return [
      Number.parseInt(cleaned.slice(0, 2), 16),
      Number.parseInt(cleaned.slice(2, 4), 16),
      Number.parseInt(cleaned.slice(4, 6), 16),
    ]
  }
  return [94, 124, 255]
}

function mixRgb(
  base: readonly [number, number, number],
  target: readonly [number, number, number],
  ratio: number,
): string {
  const r = Math.round(base[0] + (target[0] - base[0]) * ratio)
  const g = Math.round(base[1] + (target[1] - base[1]) * ratio)
  const b = Math.round(base[2] + (target[2] - base[2]) * ratio)
  return `rgb(${String(r)} ${String(g)} ${String(b)})`
}

function rgbToHex(rgb: readonly [number, number, number]): string {
  return `#${rgb.map(channel => channel.toString(16).padStart(2, '0')).join('')}`
}

const DARK_COMPANION_TONES: readonly WorkshopTone[] = [
  { primary: '#6bb8d6', secondary: '#a4d9ef', soft: '#4a7f99' },
  { primary: '#a692e0', secondary: '#cec2f4', soft: '#6c5fa3' },
  { primary: '#d9a468', secondary: '#f0cc9f', soft: '#8f6c45' },
  { primary: '#d98ca8', secondary: '#f1bbd0', soft: '#915c70' },
  { primary: '#6cc0a4', secondary: '#a3e2cb', soft: '#488570' },
]

const LIGHT_COMPANION_TONES: readonly WorkshopTone[] = [
  { primary: '#3d83a8', secondary: '#69a8c9', soft: '#8eb8cf' },
  { primary: '#7562b8', secondary: '#9a8ad4', soft: '#b3a8db' },
  { primary: '#b57b3d', secondary: '#d49f66', soft: '#d9ba96' },
  { primary: '#b35c7e', secondary: '#d182a1', soft: '#d9a5b9' },
  { primary: '#3b8f74', secondary: '#67b39a', soft: '#93c7b5' },
]

/**
 * 结合用户当前 `--accent` 主题色与明暗模式，解析像素工坊的 6 组色板、网格线和交互透明度。
 */
export function resolveWorkshopPalette(accentHex: string, isDark: boolean): WorkshopPalette {
  const accentRgb = parseHexRgb(accentHex)
  const normalizedAccent = rgbToHex(accentRgb)
  const accentTone: WorkshopTone = isDark
    ? {
        primary: mixRgb(accentRgb, [255, 255, 255], 0.14),
        secondary: mixRgb(accentRgb, [255, 255, 255], 0.42),
        soft: mixRgb(accentRgb, [36, 40, 52], 0.34),
      }
    : {
        primary: mixRgb(accentRgb, [20, 26, 42], 0.08),
        secondary: mixRgb(accentRgb, [255, 255, 255], 0.28),
        soft: mixRgb(accentRgb, [235, 239, 248], 0.48),
      }
  const [r, g, b] = accentRgb
  return {
    accent: normalizedAccent,
    isDark,
    tones: [accentTone, ...(isDark ? DARK_COMPANION_TONES : LIGHT_COMPANION_TONES)],
    gridLine: isDark ? 'rgb(255 255 255 / 0.055)' : 'rgb(24 32 52 / 0.068)',
    gridLineActive: `rgb(${String(r)} ${String(g)} ${String(b)} / ${isDark ? '0.34' : '0.32'})`,
    hoverFill: `rgb(${String(r)} ${String(g)} ${String(b)} / ${isDark ? '0.09' : '0.075'})`,
    hoverCorner: `rgb(${String(r)} ${String(g)} ${String(b)} / ${isDark ? '0.68' : '0.58'})`,
    rippleStroke: `rgb(${String(r)} ${String(g)} ${String(b)} / ${isDark ? '0.44' : '0.38'})`,
    restAlpha: isDark ? 0.36 : 0.4,
    hoverAlpha: 0.9,
    neighborAlpha: isDark ? 0.56 : 0.6,
  }
}
