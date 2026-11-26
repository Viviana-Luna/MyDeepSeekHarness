/**
 * 锚点弹出菜单的液态形变纯数学与轮廓生成：复刻 FlClash / prism_ui 的双弹簧展开、
 * 胶囊收方、抛物线冲量、液滴回吸与 SDF 平滑液桥轮廓（gooPairOutline）。
 * 运行在 renderer；纯函数且无 DOM 副作用，可直接由单测与动画控制器复用。
 */
import { stepSpring, type SpringConfig } from './elasticPressMath.ts'

/** 展开形变总时长（秒），对应 prism_ui `_openDuration`。 */
export const POPUP_OPEN_DURATION_S = 0.45

/** 缩回锚点总时长（秒），对应 prism_ui `_dismissDuration`。 */
export const POPUP_DISMISS_DURATION_S = 0.5

/** 展开主弹簧（stiffness: 400, dampingRatio: 0.754）。 */
export const POPUP_OPEN_SPRING: SpringConfig = { stiffness: 400, dampingRatio: 0.754 }

/** 圆角收方弹簧（stiffness: 324, dampingRatio: 0.75），延迟 70ms 启动。 */
export const POPUP_CORNERS_SPRING: SpringConfig = { stiffness: 324, dampingRatio: 0.75 }

/** 收回液滴回吸弹簧（stiffness: 165, dampingRatio: 0.8）。 */
export const POPUP_DROPLET_SPRING: SpringConfig = { stiffness: 165, dampingRatio: 0.8 }

const CORNERS_DELAY_S = 0.07
const CORNERS_REACH_PER_WIDTH = 0.48
const PLATTER_IN_CONTROL = 0.41
const DROPLET_SHARE = 0.25
const DROPLET_BLEND = 28
const RIM_DEPTH = 8
const OPEN_CONTENT_BLUR = 4
const OPEN_BLUR_BUMP = 1.9
const MAX_CONTENT_BLUR = 8
const DROPLET_CONTENT_OUT_S = 0.1
const CONTOUR_CELL_SIZE = 4
const CONTOUR_MAX_STEPS = 2400

/** 矩形坐标描述（均采用菜单容器局部坐标系）。 */
export interface MorphRect {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

/** 单帧液态菜单的几何、轮廓与内容模糊状态。 */
export interface PopupMorphFrame {
  readonly platter: MorphRect
  readonly platterRadius: number
  readonly droplet: MorphRect
  readonly progress: number
  readonly blend: number
  readonly svgPath: string
  readonly surfaceOpacity: number
  readonly strokeOpacity: number
  readonly contentOpacity: number
  readonly contentBlur: number
  readonly contentScale: number
}

/** 菜单闭合瞬间的起始帧快照，用于半途取消时无跳变衔接收回。 */
export interface PopupMorphSnapshot {
  readonly platter: MorphRect
  readonly platterRadius: number
  readonly droplet: MorphRect
  readonly progress: number
}

/** FlClash `riseAndFall` 抛物脉冲曲线：在 peak 秒升到 1 再自然回落。 */
export function riseAndFall(timeSeconds: number, peakSeconds: number, sharpness: number): number {
  if (timeSeconds <= 0 || peakSeconds <= 0) return 0
  const ratio = timeSeconds / peakSeconds
  return Math.pow(ratio, sharpness) * Math.exp(sharpness * (1 - ratio))
}

/** 在 `[0, t]` 内精确求值标准阻尼弹簧位置，直接复用闭式解析求解器。 */
function evaluateSpring(config: SpringConfig, timeSeconds: number): number {
  if (timeSeconds <= 0) return 0
  return stepSpring({ value: 0, velocity: 0 }, { ...config, target: 1, deltaSeconds: timeSeconds })
    .value
}

/** 计算展开阶段第 `timeSeconds` 秒的液态形变帧（`0 .. 0.45s`）。 */
export function computeOpeningMorphFrame(input: {
  readonly timeSeconds: number
  readonly anchor: MorphRect
  readonly card: MorphRect
  readonly cardRadius: number
}): PopupMorphFrame {
  const { timeSeconds, anchor, card, cardRadius } = input
  const progress = evaluateSpring(POPUP_OPEN_SPRING, timeSeconds)
  const cornerProgress = evaluateSpring(
    POPUP_CORNERS_SPRING,
    Math.max(0, timeSeconds - CORNERS_DELAY_S),
  )
  const cornersFactor = 1 - cornerProgress
  const anchorShortest = Math.max(1, Math.min(anchor.width, anchor.height))
  const anchorLongest = Math.max(anchor.width, anchor.height)
  const cardWidth = Math.max(1, card.width)
  const scale = lerp(PLATTER_IN_CONTROL * (anchorShortest / cardWidth), 1, progress)
  const height = lerp(cardWidth, card.height, progress)
  const anchorCenter = rectCenter(anchor)
  const cardCenter = rectCenter(card)
  const toCardY = cardCenter.y - anchorCenter.y
  const distance = Math.abs(toCardY)
  const dip =
    Math.sign(toCardY) *
    (Math.min(1, distance / 30) * 23 + 0.124 * distance) *
    riseAndFall(timeSeconds, 0.098, 3.3)
  const beyondW = Math.max(0, anchor.width - anchor.height) * clamp01(1 - progress)
  const beyondH = Math.max(0, anchor.height - anchor.width) * clamp01(1 - progress)
  const platter = rectFromCenter(
    lerp(anchorCenter.x, cardCenter.x, progress),
    lerp(anchorCenter.y, cardCenter.y, progress) + dip,
    Math.max(2, cardWidth * scale + beyondW),
    Math.max(2, height * scale + beyondH),
  )
  const rawCorners = cardRadius + cardWidth * CORNERS_REACH_PER_WIDTH * cornersFactor
  const platterRadius = clampRadius(Math.min(height / 2, rawCorners) * scale, platter)

  const droplet = computeOpeningDroplet(anchor, card, anchorLongest, progress)
  const settled = clamp01(progress)
  const svgPath = gooPairSvgPath(platter, platterRadius, droplet, DROPLET_BLEND)
  const bump = OPEN_BLUR_BUMP * riseAndFall(timeSeconds, 0.069, 2.1)
  const contentBlur = Math.hypot(OPEN_CONTENT_BLUR * (1 - settled), bump)

  return {
    platter,
    platterRadius,
    droplet,
    progress,
    blend: DROPLET_BLEND,
    svgPath,
    surfaceOpacity: Math.min(1, Math.max(0.15, settled * 1.4)),
    strokeOpacity: settled,
    contentOpacity: settled,
    contentBlur,
    contentScale: platter.width / cardWidth,
  }
}

/** 计算收回阶段第 `timeSeconds` 秒的液滴回吸帧（默认 `0.50s`）。 */
export function computeClosingMorphFrame(input: {
  readonly timeSeconds: number
  readonly totalDurationSeconds: number
  readonly start: PopupMorphSnapshot | null
  readonly anchor: MorphRect
  readonly card: MorphRect
  readonly cardRadius: number
}): PopupMorphFrame {
  const { timeSeconds, totalDurationSeconds, start, anchor, card, cardRadius } = input
  const duration = Math.max(0.05, totalDurationSeconds)
  const unit = clamp01(timeSeconds / duration)
  const flTime = unit * POPUP_DISMISS_DURATION_S
  const from = start?.platter ?? card
  const fromRadius = start?.platterRadius ?? cardRadius
  const anchorCenter = rectCenter(anchor)
  const fromCenter = rectCenter(from)
  const fromDroplet =
    start?.droplet ??
    rectFromCenter(
      lerp(anchorCenter.x, fromCenter.x, DROPLET_SHARE),
      lerp(anchorCenter.y, fromCenter.y, DROPLET_SHARE),
      anchor.width * DROPLET_SHARE,
      anchor.height * DROPLET_SHARE,
    )
  const ringing = 1 - easeInQuad(clamp01((flTime - 0.4) / 0.1))
  const progress = 1 + (evaluateSpring(POPUP_DROPLET_SPRING, flTime) - 1) * ringing
  const toCardY = fromCenter.y - anchorCenter.y
  const away = Math.sign(toCardY)
  const dip = Math.min(0.21 * Math.abs(toCardY), 22) * riseAndFall(flTime, 0.072, 2.4)
  const lift = Math.min(0.25 * Math.abs(toCardY), 19) * riseAndFall(flTime, 0.176, 4.9)
  const anchorShortest = Math.max(1, Math.min(anchor.width, anchor.height))
  const scale = lerp(
    1,
    (PLATTER_IN_CONTROL * anchorShortest) / Math.max(1, Math.max(from.width, from.height)),
    progress,
  )
  const beyondW = Math.max(0, anchor.width - anchor.height) * clamp01(progress)
  const beyondH = Math.max(0, anchor.height - anchor.width) * clamp01(progress)
  const platter = rectFromCenter(
    lerp(fromCenter.x, anchorCenter.x, progress),
    lerp(fromCenter.y, anchorCenter.y, progress) + away * dip * ringing,
    Math.max(2, from.width * scale + beyondW),
    Math.max(2, lerp(from.height, from.width, progress) * scale + beyondH),
  )
  const platterRadius = clampRadius(lerp(fromRadius, from.width / 2, progress) * scale, platter)
  const fromDropletCenter = rectCenter(fromDroplet)
  const droplet = rectFromCenter(
    lerp(fromDropletCenter.x, anchorCenter.x, progress),
    lerp(fromDropletCenter.y, anchorCenter.y, progress) - away * lift * ringing,
    Math.max(2, lerp(fromDroplet.width, anchor.width, progress)),
    Math.max(2, lerp(fromDroplet.height, anchor.height, progress)),
  )
  const absorbed = easeInOutQuad(clamp01((unit - 0.6) / 0.3))
  const blend = DROPLET_BLEND * Math.min(1, flTime / 0.05) * (1 - absorbed)
  const contentReveal =
    (start ? clamp01(start.progress) : 1) *
    (1 - easeOutQuad(clamp01(flTime / DROPLET_CONTENT_OUT_S)))

  return {
    platter,
    platterRadius,
    droplet,
    progress,
    blend,
    svgPath: gooPairSvgPath(platter, platterRadius, droplet, blend),
    surfaceOpacity: clamp01(1 - easeInQuad(clamp01((unit - 0.78) / 0.22))),
    strokeOpacity: clamp01(1 - unit * 1.1),
    contentOpacity: contentReveal,
    contentBlur: MAX_CONTENT_BLUR * (1 - contentReveal),
    contentScale: platter.width / Math.max(1, card.width),
  }
}

/** 计算圆角矩形的标准 SVG 路径，用于无融合或完全吞并时的快速绘制。 */
export function roundedRectSvgPath(rect: MorphRect, radius: number): string {
  const r = clampRadius(radius, rect)
  const { left: x, top: y, width: w, height: h } = rect
  if (r <= 0.1) {
    return `M ${fmt(x)} ${fmt(y)} H ${fmt(x + w)} V ${fmt(y + h)} H ${fmt(x)} Z`
  }
  return [
    `M ${fmt(x + r)} ${fmt(y)}`,
    `H ${fmt(x + w - r)}`,
    `A ${fmt(r)} ${fmt(r)} 0 0 1 ${fmt(x + w)} ${fmt(y + r)}`,
    `V ${fmt(y + h - r)}`,
    `A ${fmt(r)} ${fmt(r)} 0 0 1 ${fmt(x + w - r)} ${fmt(y + h)}`,
    `H ${fmt(x + r)}`,
    `A ${fmt(r)} ${fmt(r)} 0 0 1 ${fmt(x)} ${fmt(y + h - r)}`,
    `V ${fmt(y + r)}`,
    `A ${fmt(r)} ${fmt(r)} 0 0 1 ${fmt(x + r)} ${fmt(y)}`,
    'Z',
  ].join(' ')
}

/**
 * 计算主托盘与液滴在平滑液桥（smooth-min）作用下的 SVG 融合轮廓。
 * 当液滴完全被主托盘吞没时退回单一圆角矩形；分离时返回双轮廓；粘连时沿外缘追踪顺滑液桥。
 */
export function gooPairSvgPath(
  platter: MorphRect,
  platterRadius: number,
  droplet: MorphRect,
  blend: number,
): string {
  const safeR = clampRadius(platterRadius, platter)
  const pillR = Math.min(droplet.width, droplet.height) / 2
  if (gooPairDepth(platter, safeR, droplet, blend) >= 0) {
    return roundedRectSvgPath(platter, safeR)
  }
  if (gooPairDepth(droplet, pillR, platter, blend) >= 0) {
    return roundedRectSvgPath(droplet, pillR)
  }
  if (blend <= 0.5) {
    return `${roundedRectSvgPath(platter, safeR)} ${roundedRectSvgPath(droplet, pillR)}`
  }
  const field = (px: number, py: number) =>
    smoothMin(sdRoundedBox(px, py, platter, safeR), sdRoundedBox(px, py, droplet, pillR), blend)
  const pad = blend + CONTOUR_CELL_SIZE * 2
  const contour: ContourContext = {
    bounds: {
      originX:
        Math.floor((Math.min(platter.left, droplet.left) - pad) / CONTOUR_CELL_SIZE) *
        CONTOUR_CELL_SIZE,
      originY:
        Math.floor((Math.min(platter.top, droplet.top) - pad) / CONTOUR_CELL_SIZE) *
        CONTOUR_CELL_SIZE,
      cols: Math.ceil(
        (Math.max(platter.left + platter.width, droplet.left + droplet.width) -
          Math.min(platter.left, droplet.left) +
          pad * 2) /
          CONTOUR_CELL_SIZE,
      ),
      rows: Math.ceil(
        (Math.max(platter.top + platter.height, droplet.top + droplet.height) -
          Math.min(platter.top, droplet.top) +
          pad * 2) /
          CONTOUR_CELL_SIZE,
      ),
    },
    field,
    visited: new Set<number>(),
    visitedCells: new Set<number>(),
  }
  const loops: string[] = []
  const loopA = traceContourFromSeed(contour, rectCenter(platter))
  if (loopA !== null) loops.push(loopA)
  const loopB = traceContourFromSeed(contour, rectCenter(droplet))
  if (loopB !== null) loops.push(loopB)
  return loops.length > 0 ? loops.join(' ') : roundedRectSvgPath(platter, safeR)
}

/** FlClash 同款包容深度检查：判断液滴是否完全进入融合半径内部。 */
export function gooPairDepth(
  rect: MorphRect,
  radius: number,
  pill: MorphRect,
  blend: number,
): number {
  const right = pill.left + pill.width
  const bottom = pill.top + pill.height
  const maxDist = Math.max(
    sdRoundedBox(pill.left, pill.top, rect, radius),
    sdRoundedBox(right, pill.top, rect, radius),
    sdRoundedBox(pill.left, bottom, rect, radius),
    sdRoundedBox(right, bottom, rect, radius),
  )
  return -maxDist - blend
}

interface GridBounds {
  readonly originX: number
  readonly originY: number
  readonly cols: number
  readonly rows: number
}

interface ContourContext {
  readonly bounds: GridBounds
  readonly field: (x: number, y: number) => number
  readonly visited: Set<number>
  readonly visitedCells: Set<number>
}

interface CellBox {
  readonly x0: number
  readonly y0: number
  readonly x1: number
  readonly y1: number
}

interface Point2D {
  readonly x: number
  readonly y: number
}

function computeOpeningDroplet(
  anchor: MorphRect,
  card: MorphRect,
  anchorLongest: number,
  progress: number,
): MorphRect {
  const anchorCenter = rectCenter(anchor)
  const cardCenter = rectCenter(card)
  const inset = (anchorLongest * DROPLET_SHARE) / 2 + DROPLET_BLEND + RIM_DEPTH
  const sunkX = lerp(anchorCenter.x, cardCenter.x, DROPLET_SHARE)
  const sunkY = lerp(anchorCenter.y, cardCenter.y, DROPLET_SHARE)
  const innerWidth = card.width - inset * 2
  const innerHeight = card.height - inset * 2
  const targetX =
    innerWidth > 0
      ? clampRange(sunkX, card.left + inset, card.left + card.width - inset)
      : cardCenter.x
  const targetY =
    innerHeight > 0
      ? clampRange(sunkY, card.top + inset, card.top + card.height - inset)
      : cardCenter.y
  const factor = lerp(1, DROPLET_SHARE, progress)
  return rectFromCenter(
    lerp(anchorCenter.x, targetX, progress),
    lerp(anchorCenter.y, targetY, progress),
    Math.max(2, anchor.width * factor),
    Math.max(2, anchor.height * factor),
  )
}

function sdRoundedBox(px: number, py: number, rect: MorphRect, radius: number): number {
  const r = clampRadius(radius, rect)
  const cx = rect.left + rect.width / 2
  const cy = rect.top + rect.height / 2
  const qx = Math.abs(px - cx) - rect.width / 2 + r
  const qy = Math.abs(py - cy) - rect.height / 2 + r
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
}

function smoothMin(a: number, b: number, blend: number): number {
  const h = clamp01(0.5 + (0.5 * (b - a)) / blend)
  return b + (a - b) * h - blend * h * (1 - h)
}

// 边缘编号：0=上(TL->TR), 1=右(TR->BR), 2=下(BR->BL), 3=左(BL->TL)。
function traceContourFromSeed(contour: ContourContext, seed: Point2D): string | null {
  const { bounds, field, visitedCells } = contour
  const gx = clampInt(Math.floor((seed.x - bounds.originX) / CONTOUR_CELL_SIZE), 0, bounds.cols - 1)
  let gy = clampInt(Math.floor((seed.y - bounds.originY) / CONTOUR_CELL_SIZE), 0, bounds.rows - 1)
  while (
    gy > 0 &&
    field(bounds.originX + gx * CONTOUR_CELL_SIZE, bounds.originY + gy * CONTOUR_CELL_SIZE) < 0
  ) {
    gy -= 1
  }
  const startCell = locateBoundaryCell(contour, gx, gy)
  if (startCell === null) return null
  if (visitedCells.has(startCell.gy * bounds.cols + startCell.gx)) return null
  const points = walkBoundaryLoop(contour, startCell)
  return points.length >= 3 ? smoothClosedSvgPath(points) : null
}

function cellBoxOf(bounds: GridBounds, gx: number, gy: number): CellBox {
  const x0 = bounds.originX + gx * CONTOUR_CELL_SIZE
  const y0 = bounds.originY + gy * CONTOUR_CELL_SIZE
  return { x0, y0, x1: x0 + CONTOUR_CELL_SIZE, y1: y0 + CONTOUR_CELL_SIZE }
}

function locateBoundaryCell(
  contour: ContourContext,
  gx: number,
  gy: number,
): { gx: number; gy: number; inEdge: number } | null {
  const { bounds, field } = contour
  for (let row = gy; row < bounds.rows; row += 1) {
    for (const offset of [0, 1, -1]) {
      const col = gx + offset
      if (col < 0 || col >= bounds.cols) continue
      const { x0, y0, x1, y1 } = cellBoxOf(bounds, col, row)
      if (field(x0, y0) < 0 && field(x1, y0) >= 0) return { gx: col, gy: row, inEdge: 0 }
      if (field(x1, y0) < 0 && field(x1, y1) >= 0) return { gx: col, gy: row, inEdge: 1 }
      if (field(x1, y1) < 0 && field(x0, y1) >= 0) return { gx: col, gy: row, inEdge: 2 }
      if (field(x0, y1) < 0 && field(x0, y0) >= 0) return { gx: col, gy: row, inEdge: 3 }
    }
  }
  return null
}

function walkBoundaryLoop(
  contour: ContourContext,
  start: { gx: number; gy: number; inEdge: number },
): Point2D[] {
  const { bounds, visited, visitedCells } = contour
  const points: Point2D[] = []
  let { gx, gy, inEdge } = start
  for (let step = 0; step < CONTOUR_MAX_STEPS; step += 1) {
    const cellId = gy * bounds.cols + gx
    const key = cellId * 4 + inEdge
    if (visited.has(key)) return step === 0 ? [] : points
    visited.add(key)
    visitedCells.add(cellId)
    const outEdge = nextBoundaryEdge(contour, { gx, gy, inEdge })
    if (outEdge < 0) break
    points.push(bisectCellEdge(contour, { gx, gy, edge: outEdge }))
    const stepDir = STEP_DELTA[outEdge]!
    gx += stepDir.dx
    gy += stepDir.dy
    inEdge = (outEdge + 2) % 4
    if (gx < 0 || gy < 0 || gx >= bounds.cols || gy >= bounds.rows) break
    if (gx === start.gx && gy === start.gy && inEdge === start.inEdge) break
  }
  return points
}

const STEP_DELTA = [
  { dx: 0, dy: -1 },
  { dx: 1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: -1, dy: 0 },
] as const

// 内点在路径右侧的 Marching Squares 唯一出边查找表（mask: TL=8, TR=4, BR=2, BL=1）。
function nextBoundaryEdge(
  contour: ContourContext,
  cell: { gx: number; gy: number; inEdge: number },
): number {
  const { bounds, field } = contour
  const { x0, y0, x1, y1 } = cellBoxOf(bounds, cell.gx, cell.gy)
  const mask =
    (field(x0, y0) < 0 ? 8 : 0) |
    (field(x1, y0) < 0 ? 4 : 0) |
    (field(x1, y1) < 0 ? 2 : 0) |
    (field(x0, y1) < 0 ? 1 : 0)
  if (mask === 5) {
    const joined = field((x0 + x1) / 2, (y0 + y1) / 2) < 0
    if (cell.inEdge === 1) return joined ? 2 : 0
    return joined ? 0 : 2
  }
  if (mask === 10) {
    const joined = field((x0 + x1) / 2, (y0 + y1) / 2) < 0
    if (cell.inEdge === 0) return joined ? 1 : 3
    return joined ? 3 : 1
  }
  return SIMPLE_OUT_EDGE[mask] ?? -1
}

const SIMPLE_OUT_EDGE: Record<number, number> = {
  1: 2,
  2: 1,
  3: 1,
  4: 0,
  6: 0,
  7: 0,
  8: 3,
  9: 2,
  11: 1,
  12: 3,
  13: 2,
  14: 3,
}

function edgeVertices(box: CellBox, edge: number): [Point2D, Point2D] {
  const { x0, y0, x1, y1 } = box
  if (edge === 0)
    return [
      { x: x0, y: y0 },
      { x: x1, y: y0 },
    ]
  if (edge === 1)
    return [
      { x: x1, y: y0 },
      { x: x1, y: y1 },
    ]
  if (edge === 2)
    return [
      { x: x1, y: y1 },
      { x: x0, y: y1 },
    ]
  return [
    { x: x0, y: y1 },
    { x: x0, y: y0 },
  ]
}

function bisectCellEdge(
  contour: ContourContext,
  cell: { gx: number; gy: number; edge: number },
): Point2D {
  const { bounds, field } = contour
  const [a, b] = edgeVertices(cellBoxOf(bounds, cell.gx, cell.gy), cell.edge)
  let fa = field(a.x, a.y)
  let lo = a
  let hi = b
  if (fa > 0) {
    lo = b
    hi = a
    fa = field(lo.x, lo.y)
  }
  if (fa >= 0) return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
  for (let i = 0; i < 4; i += 1) {
    const mid = { x: (lo.x + hi.x) / 2, y: (lo.y + hi.y) / 2 }
    if (field(mid.x, mid.y) < 0) lo = mid
    else hi = mid
  }
  return { x: (lo.x + hi.x) / 2, y: (lo.y + hi.y) / 2 }
}

function smoothClosedSvgPath(points: readonly Point2D[]): string {
  const n = points.length
  const firstMid = midpoint(points[n - 1]!, points[0]!)
  const commands = [`M ${fmt(firstMid.x)} ${fmt(firstMid.y)}`]
  for (let i = 0; i < n; i += 1) {
    const control = points[i]!
    const next = points[(i + 1) % n]!
    const mid = midpoint(control, next)
    commands.push(`Q ${fmt(control.x)} ${fmt(control.y)} ${fmt(mid.x)} ${fmt(mid.y)}`)
  }
  commands.push('Z')
  return commands.join(' ')
}

function midpoint(a: Point2D, b: Point2D): Point2D {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

function rectCenter(rect: MorphRect): Point2D {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
}

function rectFromCenter(cx: number, cy: number, width: number, height: number): MorphRect {
  return { left: cx - width / 2, top: cy - height / 2, width, height }
}

function clampRadius(radius: number, rect: MorphRect): number {
  return Math.max(0, Math.min(radius, rect.width / 2, rect.height / 2))
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
}

function clampRange(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function lerp(from: number, to: number, factor: number): number {
  return from + (to - from) * factor
}

function easeInQuad(t: number): number {
  return t * t
}

function easeOutQuad(t: number): number {
  return 1 - (1 - t) * (1 - t)
}

function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
}

function fmt(value: number): string {
  return String(Math.round(value * 100) / 100)
}
