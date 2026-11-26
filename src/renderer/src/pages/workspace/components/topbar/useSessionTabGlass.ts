import { createTabGlass, scaleTabGlass } from '../../../../shared/ui/tab-glass.ts'
import { useLayoutEffect, useRef, useState } from 'react'

/** 透镜与标签共用一次拖动；松手才提交顺序，点击仍由会话导航处理。 */
export function useSessionTabGlass(
  visible: boolean,
  selectedId: string | null,
  tabLayout: string,
  onMove: (id: string, index: number) => void,
  onDrag?: (
    id: string,
    x: number,
    y: number,
    phase: 'detach' | 'move' | 'drop' | 'cancel',
  ) => boolean,
) {
  const stripRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const materialRef = useRef<HTMLDivElement>(null)
  const defsRef = useRef<HTMLDivElement>(null)
  const lensRef = useRef<HTMLDivElement>(null)
  const [scrollState, setScrollState] = useState({
    overflow: false,
    canScrollLeft: false,
    canScrollRight: false,
  })
  const synchronize = useRef<(() => void) | null>(null)
  const reorder = useRef(onMove)
  reorder.current = onMove
  const dragAction = useRef(onDrag)
  dragAction.current = onDrag

  useLayoutEffect(() => {
    const strip = stripRef.current,
      root = rootRef.current,
      filtered = materialRef.current
    const defsHost = defsRef.current,
      lens = lensRef.current
    if (
      !visible ||
      strip === null ||
      root === null ||
      filtered === null ||
      defsHost === null ||
      lens === null
    )
      return
    const reduced = matchMedia('(prefers-reduced-motion: reduce)')
    const engine = createTabGlass({ container: root, filtered, defsHost, shadow: lens }, 150, 26)
    const regions = [...defsHost.querySelectorAll<SVGElement>('[data-lens]')]
    let x = 0,
      target = 0,
      velocity = 0,
      width = 150,
      contentWidth = 1
    let pressure = 0,
      pressureTarget = 0,
      bulge = 0,
      frame = 0,
      previous = 0
    let lastId: string | null = null,
      pointer = -1,
      offset = 0,
      moved = 0,
      startPointerX = 0
    let startPointerY = 0,
      lastPointerX = 0,
      lastPointerY = 0
    let dragged: HTMLButtonElement | null = null,
      fromIndex = -1,
      toIndex = -1
    let suppressClick = false,
      skipMotion = false,
      detached = false
    const tabs = () => [...root.querySelectorAll<HTMLButtonElement>('.session-tab')]
    const refreshScrollState = () => {
      const style = getComputedStyle(strip)
      // 按未放置滚动按钮时的完整轨道判断，避免放大窗口后按钮反过来阻止标签铺满。
      const trackWidth = (strip.parentElement ?? strip).getBoundingClientRect().width
      const availableWidth =
        trackWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight)
      const overflow = tabs().length * 96 > availableWidth + 1
      const next = {
        overflow,
        canScrollLeft: overflow && strip.scrollLeft > 1,
        canScrollRight: overflow && strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1,
      }
      setScrollState(current =>
        current.overflow === next.overflow &&
        current.canScrollLeft === next.canScrollLeft &&
        current.canScrollRight === next.canScrollRight
          ? current
          : next,
      )
    }
    // 原生监听允许阻止浏览器默认滚动；触控板横向输入保留方向，普通滚轮映射到横轴。
    const scrollSurface = strip.parentElement ?? strip
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey || strip.scrollWidth <= strip.clientWidth + 1) return
      const delta = Math.abs(event.deltaX) >= Math.abs(event.deltaY) ? event.deltaX : event.deltaY
      if (delta === 0) return
      const unit =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? 16
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? strip.clientWidth
            : 1
      event.preventDefault()
      strip.scrollBy({ left: delta * unit, behavior: 'instant' })
    }
    const reveal = (tab: HTMLElement) => {
      if (strip.scrollWidth <= strip.clientWidth + 1) return
      const bounds = strip.getBoundingClientRect(),
        item = tab.getBoundingClientRect()
      if (item.left < bounds.left + 12)
        strip.scrollBy({ left: item.left - bounds.left - 12, behavior: 'instant' })
      else if (item.right > bounds.right - 12)
        strip.scrollBy({ left: item.right - bounds.right + 12, behavior: 'instant' })
    }
    const focus = (event: FocusEvent) => {
      if (event.target instanceof HTMLElement) {
        const tab = event.target.closest<HTMLElement>('.session-tab-shell')
        if (tab !== null) reveal(tab)
      }
    }
    const units = () => [...root.querySelectorAll<HTMLElement>('[data-tab-unit]')]
    const unitFor = (tab: HTMLElement) => tab.closest<HTMLElement>('[data-tab-unit]')!
    const center = (item: HTMLElement) => {
      const unit = unitFor(item)
      const shell = item.parentElement
      return (
        unit.offsetLeft +
        (item === unit
          ? unit.offsetWidth / 2
          : (shell?.offsetLeft ?? 0) + (shell?.offsetWidth ?? 0) / 2)
      )
    }
    const paint = () => {
      const materialBounds = filtered.getBoundingClientRect()
      contentWidth = Math.max(1, materialBounds.width)
      // 标签中心相对 root，滤镜位置相对扩展后的材质盒；外沿由引擎换算回 root。
      const materialOffset = materialBounds.left - root.getBoundingClientRect().left
      // 保留弹簧的连续位移，把两端的越界量变成挤压；绘制外沿始终留在轨道内。
      // 中心随压缩后的半宽退让，因此圆头不会先越界再被滚动容器切平。
      const trackWidth = root.getBoundingClientRect().width
      const overrun = Math.max(0, width / 2 - x, x + width / 2 - trackWidth)
      const squeeze = reduced.matches
        ? 0
        : 0.08 * (1 - Math.exp(-overrun / Math.max(1, width * 0.04)))
      const scaleX = reduced.matches ? 1 : 1 - pressure * 0.01 - bulge * 0.03 - squeeze
      const scaleY = reduced.matches ? 1 : 1 - pressure * 0.02 + bulge * 0.06 + squeeze * 0.7
      const halfWidth = (width * scaleX) / 2
      const paintedX = Math.max(halfWidth, Math.min(trackWidth - halfWidth, x))
      engine.setPosition((paintedX - materialOffset) / contentWidth, 0.5)
      // 按绘制区域宽度归一化强度，使不同窗口中的材质形变保持一致。
      const strength = (0.018 + pressure * 0.004 + bulge * 0.003) * Math.min(1, 432 / contentWidth)
      engine.setOptions({
        strength,
        chromaticAberration: 0.16 + pressure * 0.04,
        specular: 0.7 + pressure * 0.1,
      })
      scaleTabGlass(lens, regions, scaleX, scaleY)
    }
    const draw = (time: number) => {
      const dt = previous === 0 ? 1 / 60 : Math.min((time - previous) / 1000, 0.025)
      previous = time
      if (pointer < 0) {
        velocity += (220 * (target - x) - 23 * velocity) * dt
        x += velocity * dt
      }
      pressure += (pressureTarget - pressure) * (1 - Math.exp(-22 * dt))
      const bulgeTarget = reduced.matches ? 0 : Math.min(1, Math.abs(velocity) / (width * 4))
      bulge += (bulgeTarget - bulge) * (1 - Math.exp(-20 * dt))
      const moving = pointer < 0 && (Math.abs(target - x) > 0.08 || Math.abs(velocity) > 0.5)
      if (moving) lens.dataset.moving = 'true'
      else delete lens.dataset.moving
      if (
        moving ||
        Math.abs(pressureTarget - pressure) > 0.002 ||
        Math.abs(bulgeTarget - bulge) > 0.002
      )
        frame = requestAnimationFrame(draw)
      else {
        if (pointer < 0) {
          x = target
          velocity = 0
        }
        pressure = pressureTarget
        bulge = 0
        frame = 0
        previous = 0
      }
      paint()
    }
    const wake = () => {
      if (reduced.matches) {
        cancelAnimationFrame(frame)
        frame = 0
        previous = 0
        x = target
        velocity = 0
        bulge = 0
        pressure = pressureTarget
        delete lens.dataset.moving
        paint()
      } else if (frame === 0) frame = requestAnimationFrame(draw)
    }
    const sync = () => {
      refreshScrollState()
      const active = root.querySelector<HTMLButtonElement>('.session-tab[aria-selected="true"]')
      lens.hidden = active === null
      if (active === null) {
        cancelAnimationFrame(frame)
        frame = 0
        previous = 0
        lastId = null
        return
      }
      const id = active.dataset.sessionTab ?? null
      // Windows 分数缩放下 offsetWidth/offsetLeft 会取整；静止几何使用同一套浮点坐标，
      // 否则末端半像素误差会被误认为持续挤压，透镜无法完全恢复。
      const activeBounds = (active.parentElement ?? active).getBoundingClientRect()
      const nextWidth = activeBounds.width
      const nextContentWidth = filtered.getBoundingClientRect().width
      const shapeResized = width !== nextWidth
      const resized = shapeResized || contentWidth !== nextContentWidth
      width = nextWidth
      contentWidth = Math.max(1, nextContentWidth)
      target = activeBounds.left + activeBounds.width / 2 - root.getBoundingClientRect().left
      // 位移图横向至少覆盖设备像素，避免宽标签的圆头被固定 512 列拉成台阶。
      // 生成器按四象限镜像，分辨率必须为偶数。
      const quality = Math.max(512, Math.ceil((width * devicePixelRatio) / 2) * 2)
      engine.setOptions({ width, quality })
      // 侧栏伸缩只改变容器宽度，保留透镜正在进行的滑动。
      if (lastId === null || (shapeResized && id === lastId) || skipMotion) {
        x = target
        velocity = 0
        bulge = 0
      }
      skipMotion = false
      if (id !== lastId || resized) {
        reveal(active.parentElement ?? active)
      }
      lastId = id
      wake()
      refreshScrollState()
    }
    const clearDrag = () => {
      for (const unit of units()) {
        unit.style.transform = ''
        delete unit.dataset.dragging
        delete unit.dataset.detached
      }
      for (const tab of tabs()) {
        const shell = tab.parentElement
        if (shell === null) continue
        shell.style.transform = ''
        delete shell.dataset.dragging
        delete shell.dataset.pressed
        delete shell.dataset.detached
      }
      delete root.dataset.reordering
      root.style.removeProperty('--tab-drop-left')
      root.style.removeProperty('--tab-drop-width')
    }
    const release = (cancelled: boolean) => {
      if (pointer < 0) return
      const captured = pointer
      pointer = -1
      pressureTarget = 0
      velocity = 0
      delete lens.dataset.pressed
      if (strip.hasPointerCapture(captured)) strip.releasePointerCapture(captured)
      suppressClick = moved > 4
      const id = dragged?.dataset.sessionTab
      const targetIndex = units()[toIndex] === undefined ? -1 : toIndex
      clearDrag()
      dragged = null
      const dropped =
        id !== undefined && detached
          ? dragAction.current?.(id, lastPointerX, lastPointerY, cancelled ? 'cancel' : 'drop')
          : false
      if (!cancelled && !detached && !dropped && moved > 4 && id !== undefined && targetIndex >= 0)
        reorder.current(id, targetIndex)
      sync()
    }
    const down = (event: PointerEvent) => {
      if (event.button !== 0 || !event.isPrimary || !(event.target instanceof Element)) return
      suppressClick = false
      detached = false
      const tab = event.target.closest<HTMLButtonElement>('.session-tab')
      if (tab === null) return
      dragged = tab
      fromIndex = units().indexOf(unitFor(tab))
      toIndex = fromIndex
      pointer = event.pointerId
      offset = event.clientX - root.getBoundingClientRect().left - center(unitFor(tab))
      moved = 0
      startPointerX = lastPointerX = event.clientX
      startPointerY = lastPointerY = event.clientY
      velocity = 0
      pressureTarget = tab.getAttribute('aria-selected') === 'true' ? 1 : 0
      if (pressureTarget) lens.dataset.pressed = 'true'
      if (tab.parentElement !== null) tab.parentElement.dataset.pressed = 'true'
      tab.focus()
      event.preventDefault()
      wake()
    }
    const move = (event: PointerEvent) => {
      if (event.pointerId !== pointer || dragged === null) return
      const options = units(),
        first = options[0],
        last = options.at(-1)
      if (first === undefined || last === undefined) return
      lastPointerX = event.clientX
      lastPointerY = event.clientY
      moved = Math.max(
        moved,
        Math.hypot(event.clientX - startPointerX, event.clientY - startPointerY),
      )
      if (moved <= 4) return
      // 达到拖动阈值后才捕获，保留普通点击的原始按钮目标。
      if (!strip.hasPointerCapture(pointer)) strip.setPointerCapture(pointer)
      if (!detached && event.clientY - startPointerY > 10) {
        detached = true
        clearDrag()
        unitFor(dragged).dataset.detached = 'true'
        if (dragged.dataset.sessionTab)
          dragAction.current?.(dragged.dataset.sessionTab, event.clientX, event.clientY, 'detach')
      }
      if (detached) {
        if (dragged.dataset.sessionTab)
          dragAction.current?.(dragged.dataset.sessionTab, event.clientX, event.clientY, 'move')
        event.preventDefault()
        return
      }
      const bounds = strip.getBoundingClientRect()
      if (event.clientX < bounds.left + 32) strip.scrollLeft -= 16
      else if (event.clientX > bounds.right - 32) strip.scrollLeft += 16
      const movingUnit = unitFor(dragged)
      const halfWidth = movingUnit.offsetWidth / 2
      const dragCenter = Math.max(
        first.offsetLeft + halfWidth,
        Math.min(
          last.offsetLeft + last.offsetWidth - halfWidth,
          event.clientX - root.getBoundingClientRect().left - offset,
        ),
      )
      toIndex = options.reduce(
        (best, tab, index) =>
          Math.abs(center(tab) - dragCenter) < Math.abs(center(options[best]!) - dragCenter)
            ? index
            : best,
        0,
      )
      root.dataset.reordering = 'true'
      const targetUnit = options[toIndex]!
      const marker =
        fromIndex < toIndex
          ? targetUnit.offsetLeft + targetUnit.offsetWidth - movingUnit.offsetWidth
          : targetUnit.offsetLeft
      root.style.setProperty('--tab-drop-left', `${marker}px`)
      root.style.setProperty('--tab-drop-width', `${movingUnit.offsetWidth}px`)
      options.forEach((unit, index) => {
        const shift =
          unit === movingUnit
            ? dragCenter - center(unit)
            : index > fromIndex && index <= toIndex
              ? -movingUnit.offsetWidth
              : index < fromIndex && index >= toIndex
                ? movingUnit.offsetWidth
                : 0
        unit.style.transform = `translateX(${shift}px)`
        if (unit === movingUnit) unit.dataset.dragging = 'true'
        const selected = unit.querySelector<HTMLElement>('.session-tab[aria-selected="true"]')
        if (selected) x = center(selected) + shift
      })
      paint()
      event.preventDefault()
    }
    const end = (event: PointerEvent) => {
      if (event.pointerId === pointer) release(event.type !== 'pointerup')
    }
    const click = (event: MouseEvent) => {
      if (suppressClick && event.detail > 0) {
        suppressClick = false
        event.preventDefault()
        event.stopPropagation()
      } else {
        suppressClick = false
        skipMotion = event.detail === 0
      }
    }
    const cancel = () => {
      release(true)
    }
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && pointer >= 0) {
        event.preventDefault()
        cancel()
      }
    }
    const resync = () => {
      if (pointer >= 0) return
      const style = getComputedStyle(strip)
      const availableWidth =
        strip.clientWidth -
        Number.parseFloat(style.paddingLeft) -
        Number.parseFloat(style.paddingRight)
      const tabWidth = Math.max(96, availableWidth / Math.max(1, tabs().length))
      root.style.setProperty('--session-tab-width', `${String(tabWidth)}px`)
      sync()
    }
    synchronize.current = resync
    resync()
    const observer = new ResizeObserver(resync)
    observer.observe(filtered)
    observer.observe(strip)
    strip.addEventListener('scroll', refreshScrollState, { passive: true })
    scrollSurface.addEventListener('wheel', wheel, { passive: false })
    strip.addEventListener('focusin', focus)
    reduced.addEventListener('change', wake)
    strip.addEventListener('pointerdown', down)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
    strip.addEventListener('lostpointercapture', end)
    strip.addEventListener('click', click, true)
    window.addEventListener('blur', cancel)
    window.addEventListener('resize', cancel)
    window.addEventListener('keydown', keydown)
    return () => {
      synchronize.current = null
      observer.disconnect()
      reduced.removeEventListener('change', wake)
      strip.removeEventListener('scroll', refreshScrollState)
      scrollSurface.removeEventListener('wheel', wheel)
      strip.removeEventListener('focusin', focus)
      strip.removeEventListener('pointerdown', down)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      strip.removeEventListener('lostpointercapture', end)
      strip.removeEventListener('click', click, true)
      window.removeEventListener('blur', cancel)
      window.removeEventListener('resize', cancel)
      window.removeEventListener('keydown', keydown)
      if (pointer >= 0 && strip.hasPointerCapture(pointer)) strip.releasePointerCapture(pointer)
      if (detached && dragged?.dataset.sessionTab)
        dragAction.current?.(dragged.dataset.sessionTab, lastPointerX, lastPointerY, 'cancel')
      cancelAnimationFrame(frame)
      engine.destroy()
      clearDrag()
      lens.style.transform = ''
      delete lens.dataset.moving
      delete lens.dataset.pressed
    }
  }, [visible])

  useLayoutEffect(() => {
    synchronize.current?.()
  }, [selectedId, tabLayout])
  const scrollByPage = (direction: -1 | 1) => {
    const strip = stripRef.current
    strip?.scrollBy({
      left: direction * Math.max(150, strip.clientWidth * 0.75),
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
    })
  }
  return { stripRef, rootRef, materialRef, defsRef, lensRef, ...scrollState, scrollByPage }
}
