/**
 * 桌面 Computer Use 策略与坐标归一化纯函数：处理多屏/Retina/DPI 双向坐标映射、单窗口越界拦截、敏感应用黑名单与禁键守卫。
 * 不依赖 Electron 或原生句柄，可在 Node 单元测试中直接验证 macOS/Windows 全场景边界。
 */

/** 矩形边界（逻辑点坐标，原点位于主屏左上角，支持副屏负坐标）。 */
export interface LogicalRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** 逻辑显示器摘要。 */
export interface ComputerUseDisplayInfo {
  readonly id: number
  readonly label: string
  readonly bounds: LogicalRect
  readonly scaleFactor: number
  readonly primary: boolean
}

/** 原生可见窗口信息。 */
export interface ComputerUseWindowInfo {
  readonly windowId: number
  readonly pid: number
  readonly appName: string
  readonly bundleId: string
  readonly title: string
  readonly bounds: LogicalRect
  readonly layer: number
  readonly isFrontmost: boolean
}

/** 单次截图附带的无障碍语义控件引用（`@uN`），兼顾零像素偏移的后台直达操控。 */
export interface CapturedUiElementRef {
  readonly ref: string
  readonly role: string
  readonly title: string
  readonly value: string
  readonly editable: boolean
  readonly pressable: boolean
  readonly bounds: LogicalRect
  readonly systemCenter: { readonly x: number; readonly y: number }
  readonly imageCenter: { readonly x: number; readonly y: number }
}

/** 单次桌面截图对应的坐标映射上下文。 */
export interface CaptureCoordinateMapping {
  readonly captureId: string
  readonly displayId: number
  readonly scope: 'window' | 'display'
  readonly logicalOrigin: { readonly x: number; readonly y: number }
  readonly logicalSize: { readonly width: number; readonly height: number }
  readonly imageSize: { readonly width: number; readonly height: number }
  readonly scaleX: number
  readonly scaleY: number
  readonly windowClipBounds?: LogicalRect
  readonly capturedWindowBounds?: LogicalRect
  readonly windowId?: number
  readonly windowPid?: number
  readonly windowAppName?: string
  readonly elements?: readonly CapturedUiElementRef[]
  readonly createdAt: number
}

const BUILTIN_SELF_NAMES = ['mydsh', 'mydeepseekharness']

/** 判断某窗口是否命中敏感应用黑名单或属于 MyDSH 自身进程（防自锁保护）。 */
export function isWindowBlocked(input: {
  window: Pick<ComputerUseWindowInfo, 'pid' | 'appName' | 'bundleId' | 'title'>
  blockedApps: readonly string[]
  selfPid: number
}): { blocked: boolean; reason?: string } {
  if (input.window.pid === input.selfPid) {
    return { blocked: true, reason: '防自锁保护：禁止桌面操控点击或输入 MyDSH 自身窗口' }
  }
  const haystack =
    `${input.window.appName} ${input.window.bundleId} ${input.window.title}`.toLowerCase()
  for (const name of BUILTIN_SELF_NAMES) {
    if (
      input.window.appName.toLowerCase() === name ||
      input.window.bundleId.toLowerCase().includes(name)
    ) {
      return { blocked: true, reason: '防自锁保护：禁止桌面操控访问 MyDSH 自身应用窗口' }
    }
  }
  for (const rule of input.blockedApps) {
    const token = rule.trim().toLowerCase()
    if (!token) continue
    if (haystack.includes(token)) {
      return {
        blocked: true,
        reason: `SECURITY_BLOCK：目标窗口命中受保护敏感应用黑名单（${rule}），已禁止自动操控`,
      }
    }
  }
  return { blocked: false }
}

/** 根据显示器边界、可选窗口裁剪区与实际截图尺寸生成唯一 `CaptureCoordinateMapping`。 */
export function buildCaptureMapping(input: {
  captureId: string
  displayId: number
  scope: 'window' | 'display'
  displayBounds: LogicalRect
  windowClipBounds?: LogicalRect
  capturedWindowBounds?: LogicalRect
  windowId?: number
  windowPid?: number
  windowAppName?: string
  imageWidth: number
  imageHeight: number
}): CaptureCoordinateMapping {
  if (input.imageWidth < 1 || input.imageHeight < 1) {
    throw new Error('截图尺寸无效，无法建立坐标映射')
  }
  const logical = input.windowClipBounds ?? input.displayBounds
  if (logical.width < 1 || logical.height < 1) {
    throw new Error('目标显示区域逻辑尺寸无效')
  }
  return {
    captureId: input.captureId,
    displayId: input.displayId,
    scope: input.scope,
    logicalOrigin: { x: logical.x, y: logical.y },
    logicalSize: { width: logical.width, height: logical.height },
    imageSize: { width: input.imageWidth, height: input.imageHeight },
    scaleX: logical.width / input.imageWidth,
    scaleY: logical.height / input.imageHeight,
    ...(input.windowClipBounds ? { windowClipBounds: input.windowClipBounds } : {}),
    ...(input.capturedWindowBounds ? { capturedWindowBounds: input.capturedWindowBounds } : {}),
    ...(input.windowId !== undefined ? { windowId: input.windowId } : {}),
    ...(input.windowPid !== undefined ? { windowPid: input.windowPid } : {}),
    ...(input.windowAppName ? { windowAppName: input.windowAppName } : {}),
    createdAt: Date.now(),
  }
}

/** 按 Z 序自顶向下命中包含指定全局逻辑坐标 `(x, y)` 的最上层可见窗口。 */
export function findWindowAtPoint(
  windows: readonly ComputerUseWindowInfo[],
  x: number,
  y: number,
): ComputerUseWindowInfo | undefined {
  return windows.find(
    win =>
      x >= win.bounds.x &&
      x <= win.bounds.x + win.bounds.width &&
      y >= win.bounds.y &&
      y <= win.bounds.y + win.bounds.height,
  )
}

/** 判断目标窗口上的全局逻辑坐标 `(x, y)` 是否正被位于其上方的其他窗口遮挡。 */
export function isPointOccludedByAnotherWindow(
  windows: readonly ComputerUseWindowInfo[],
  targetWindowId: number,
  x: number,
  y: number,
): boolean {
  const top = findWindowAtPoint(windows, x, y)
  return top !== undefined && top.windowId !== targetWindowId
}

/** 当目标窗口在截图后发生整体平移时，按实时窗口原点差值自动补偿目标逻辑坐标。 */
export function compensateWindowMovement(
  point: { readonly x: number; readonly y: number },
  capturedBounds: LogicalRect | undefined,
  liveBounds: LogicalRect | undefined,
): { x: number; y: number } {
  if (!capturedBounds || !liveBounds) return { x: point.x, y: point.y }
  const dx = Math.round(liveBounds.x - capturedBounds.x)
  const dy = Math.round(liveBounds.y - capturedBounds.y)
  if (dx === 0 && dy === 0) return { x: point.x, y: point.y }
  return { x: point.x + dx, y: point.y + dy }
}

/** 将原生无障碍树节点映射为当前截图内的 `@uN` 控件清单，过滤越界节点。 */
export function buildUiElementRefs(
  nodes: readonly {
    role: string
    title: string
    value: string
    editable: boolean
    pressable: boolean
    bounds: LogicalRect
  }[],
  mapping: CaptureCoordinateMapping,
  maxItems = 60,
): CapturedUiElementRef[] {
  const out: CapturedUiElementRef[] = []
  for (const node of nodes) {
    if (out.length >= maxItems) break
    const cx = Math.round(node.bounds.x + node.bounds.width / 2)
    const cy = Math.round(node.bounds.y + node.bounds.height / 2)
    const inX =
      cx >= mapping.logicalOrigin.x && cx <= mapping.logicalOrigin.x + mapping.logicalSize.width
    const inY =
      cy >= mapping.logicalOrigin.y && cy <= mapping.logicalOrigin.y + mapping.logicalSize.height
    if (!inX || !inY) continue
    const ix = Math.round((cx - mapping.logicalOrigin.x) / mapping.scaleX)
    const iy = Math.round((cy - mapping.logicalOrigin.y) / mapping.scaleY)
    out.push({
      ref: `@u${out.length + 1}`,
      role: node.role.replace(/^AX/u, '').toLowerCase() || 'control',
      title: node.title,
      value: node.value,
      editable: node.editable,
      pressable: node.pressable,
      bounds: node.bounds,
      systemCenter: { x: cx, y: cy },
      imageCenter: { x: ix, y: iy },
    })
  }
  return out
}

/** 校验全局逻辑坐标仍位于实时授权窗口边界内，防止窗口缩小后越界点中下方应用。 */
export function assertPointInsideRect(
  point: { readonly x: number; readonly y: number },
  rect: LogicalRect,
): void {
  const minX = Math.floor(rect.x)
  const maxX = Math.ceil(rect.x + rect.width)
  const minY = Math.floor(rect.y)
  const maxY = Math.ceil(rect.y + rect.height)
  if (point.x < minX || point.x > maxX || point.y < minY || point.y > maxY) {
    throw new Error('WINDOW_SCOPE_VIOLATION：目标坐标超出已授权窗口实时边界，已拦截操作')
  }
}

/** 将 `@uN` 控件列表格式化为紧凑的多行语义索引，限制单字段长度防止超长文本框撑爆上下文。 */
export function formatUiElementSummary(refs: readonly CapturedUiElementRef[]): string {
  return refs
    .map(item => {
      const title = item.title.slice(0, 80)
      const valText = item.value.slice(0, 60)
      const label = title ? ` ${JSON.stringify(title)}` : ''
      const val = item.editable && valText ? ` value=${JSON.stringify(valText)}` : ''
      return `${item.ref} [${item.role}]${label}${val} (${item.imageCenter.x}, ${item.imageCenter.y})`
    })
    .join('\n')
}

/** 将模型基于截图传入的 `(x, y)` 换算为全局系统逻辑坐标，并在单窗口模式下严格拦截越界操作。 */
export function mapCapturePointToSystem(
  mapping: CaptureCoordinateMapping,
  imageX: number,
  imageY: number,
): { x: number; y: number } {
  if (!Number.isFinite(imageX) || !Number.isFinite(imageY)) {
    throw new Error('桌面操作坐标必须是有限数字')
  }
  if (
    imageX < 0 ||
    imageY < 0 ||
    imageX > mapping.imageSize.width ||
    imageY > mapping.imageSize.height
  ) {
    throw new Error(
      `COORDINATE_OUT_OF_RANGE：坐标 (${imageX}, ${imageY}) 超出截图尺寸 ${mapping.imageSize.width}x${mapping.imageSize.height}`,
    )
  }
  const rawX = mapping.logicalOrigin.x + imageX * mapping.scaleX
  const rawY = mapping.logicalOrigin.y + imageY * mapping.scaleY
  let sysX = Math.round(rawX)
  let sysY = Math.round(rawY)
  if (mapping.scope === 'window' && mapping.windowClipBounds) {
    const clip = mapping.windowClipBounds
    // 兼容含小数的原生窗口边界：将边界舍入误差钳制到窗口有效整型区间内，避免合法边角误报越界。
    const minX = Math.ceil(clip.x)
    const maxX = Math.floor(clip.x + clip.width)
    const minY = Math.ceil(clip.y)
    const maxY = Math.floor(clip.y + clip.height)
    if (minX <= maxX) sysX = Math.max(minX, Math.min(maxX, sysX))
    if (minY <= maxY) sysY = Math.max(minY, Math.min(maxY, sysY))
    assertPointInsideRect({ x: sysX, y: sysY }, clip)
  }
  return { x: sysX, y: sysY }
}

/** 计算窗口在指定显示器上的可见交集区域；无交集返回 null。 */
export function intersectRect(a: LogicalRect, b: LogicalRect): LogicalRect | null {
  const left = Math.max(a.x, b.x)
  const top = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.width, b.x + b.width)
  const bottom = Math.min(a.y + a.height, b.y + b.height)
  if (right - left < 8 || bottom - top < 8) return null
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/** 检测用户是否在两次 AI 注入动作之间大幅手动接管了鼠标（阈值默认 160 逻辑点）。 */
export function detectUserMouseOverride(
  lastInjected: { x: number; y: number } | null,
  current: { x: number; y: number },
  threshold = 160,
): boolean {
  if (!lastInjected) return false
  const distance = Math.hypot(current.x - lastInjected.x, current.y - lastInjected.y)
  return distance > threshold
}

/** 拦截锁屏、强制退出、任务管理器与急停快捷键等系统高危组合键。 */
export function assertSystemKeyComboAllowed(
  rawKey: string,
  extraModifiers: readonly string[] = [],
): void {
  const tokens = [...extraModifiers, ...rawKey.split('+')]
    .map(item => item.trim().toLowerCase())
    .filter(Boolean)
  if (tokens.length === 0) throw new Error('按键名称不能为空')
  const main = tokens.at(-1) ?? ''
  const mods = new Set(
    tokens.slice(0, -1).map(mod => {
      if (mod === 'cmd' || mod === 'command' || mod === 'super' || mod === 'win') return 'meta'
      if (mod === 'ctrl') return 'control'
      if (mod === 'option') return 'alt'
      return mod
    }),
  )
  const isEsc = main === 'escape' || main === 'esc'
  const isDel = main === 'delete' || main === 'del' || main === 'backspace'
  if (mods.has('control') && mods.has('alt') && isDel) {
    throw new Error('SECURITY_BLOCK：禁止发送系统安全组合键 Ctrl+Alt+Delete')
  }
  if (mods.has('meta') && mods.has('alt') && isEsc) {
    throw new Error('SECURITY_BLOCK：禁止发送 macOS 强制退出组合键 Command+Option+Escape')
  }
  if (mods.has('meta') && mods.has('control') && main === 'q') {
    throw new Error('SECURITY_BLOCK：禁止发送系统锁屏快捷键 Command+Control+Q')
  }
  if (
    mods.has('meta') &&
    !mods.has('shift') &&
    !mods.has('alt') &&
    !mods.has('control') &&
    main === 'l'
  ) {
    throw new Error('SECURITY_BLOCK：禁止发送系统锁屏或地址栏高危快捷键 Meta+L')
  }
  if ((mods.has('meta') || mods.has('control')) && mods.has('shift') && (isEsc || main === 'f12')) {
    throw new Error('SECURITY_BLOCK：禁止模拟急停快捷键或任务管理器组合键')
  }
  if (mods.has('control') && mods.has('alt') && main === 'power') {
    throw new Error('SECURITY_BLOCK：禁止发送系统电源控制组合键')
  }
}
