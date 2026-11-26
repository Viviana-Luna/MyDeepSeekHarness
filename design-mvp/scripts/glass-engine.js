/**
 * MyDSH 液态玻璃光学引擎（Multi-Track Liquid Glass Spring & SDF Refraction Engine）
 * 为页面中所有顶栏会话标签轨道挂载独立的物理弹簧滑动透镜与 SVG SDF 边缘折射贴图。
 */

;(function setupMydshGlassEngine() {
  const controllers = []

  /**
   * 计算圆角矩形有向距离场（SDF），生成透镜边缘法线折射偏移。
   */
  function roundedBoxSdf(px, py, halfW, halfH) {
    const radius = Math.min(12, halfH)
    const qx = Math.abs(px) - halfW + radius
    const qy = Math.abs(py) - halfH + radius
    const outDist = Math.hypot(Math.max(qx, 0), Math.max(qy, 0))
    const inDist = Math.min(Math.max(qx, qy), 0)
    return outDist + inDist - radius
  }

  /**
   * 生成边缘折射位移贴图 DataURL，并注入所有标签透镜背景层。
   */
  function mountRefractionFilter() {
    const feImg = document.getElementById('mydsh-lens-feimage')
    const backdrops = document.querySelectorAll('.session-tab-lens__backdrop')
    if (!feImg || backdrops.length === 0) {
      return
    }
    const width = 180
    const height = 28
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      return
    }
    const img = ctx.createImageData(width, height)
    const halfW = width / 2 - 1
    const halfH = height / 2 - 1

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const px = x - width / 2
        const py = y - height / 2
        const dist = roundedBoxSdf(px, py, halfW, halfH)
        const bezel = Math.max(0, 1 + dist / 8)
        const factor = dist <= 0 ? Math.pow(bezel, 2.2) : 0
        const len = Math.hypot(px, py) || 1
        const nx = (-px / len) * factor
        const ny = (-py / len) * factor
        const idx = (y * width + x) * 4
        img.data[idx] = Math.round(128 + nx * 110)
        img.data[idx + 1] = Math.round(128 + ny * 110)
        img.data[idx + 2] = 128
        img.data[idx + 3] = 255
      }
    }

    ctx.putImageData(img, 0, 0)
    feImg.setAttribute('href', canvas.toDataURL())

    const filterCss = window.chrome
      ? 'url(#mydsh-liquid-lens-filter) blur(3px) saturate(1.45)'
      : 'blur(8px) saturate(1.4)'
    backdrops.forEach(el => {
      el.style.backdropFilter = filterCss
    })
  }

  /**
   * 执行单帧阻尼弹簧积分并写入透镜样式变量。
   */
  function advanceSpringFrame(state, lens, now) {
    const dt = Math.min(0.032, (now - state.lastTime) / 1000 || 0.016)
    state.lastTime = now
    const ax = 340 * (state.targetX - state.x) - 28 * state.vx
    const aw = 340 * (state.targetW - state.w) - 28 * state.vw
    state.vx += ax * dt
    state.x += state.vx * dt
    state.vw += aw * dt
    state.w += state.vw * dt

    const ratio = Math.min(1, Math.abs(state.vx) / 1400)
    lens.style.setProperty('--lens-x', `${state.x.toFixed(2)}px`)
    lens.style.setProperty('--lens-w', `${Math.max(60, state.w).toFixed(2)}px`)
    lens.style.setProperty('--lens-sx', (1 + ratio * 0.045).toFixed(4))
    lens.style.setProperty('--lens-sy', (1 - ratio * 0.035).toFixed(4))

    const settled =
      Math.abs(state.targetX - state.x) < 0.25 &&
      Math.abs(state.targetW - state.w) < 0.25 &&
      Math.abs(state.vx) < 2
    if (settled) {
      state.x = state.targetX
      state.w = state.targetW
      lens.style.setProperty('--lens-x', `${state.x}px`)
      lens.style.setProperty('--lens-w', `${state.w}px`)
      lens.style.setProperty('--lens-sx', '1')
      lens.style.setProperty('--lens-sy', '1')
      return true
    }
    return false
  }

  /**
   * 为单条顶栏标签轨道创建弹簧动力学控制器。
   */
  function createTrackController(track) {
    const lens = track.querySelector('.session-tab-lens')
    if (!lens) {
      return null
    }
    const state = {
      x: 3,
      vx: 0,
      w: 160,
      vw: 0,
      targetX: 3,
      targetW: 160,
      rafId: 0,
      lastTime: 0,
    }

    const step = now => {
      if (advanceSpringFrame(state, lens, now)) {
        state.rafId = 0
        return
      }
      state.rafId = requestAnimationFrame(step)
    }

    const sync = immediate => {
      const activeTab = track.querySelector('.work-tab.is-selected')
      if (!activeTab) {
        return
      }
      const trackRect = track.getBoundingClientRect()
      const tabRect = activeTab.getBoundingClientRect()
      if (trackRect.width <= 0 || tabRect.width <= 0) {
        return
      }
      state.targetX = tabRect.left - trackRect.left
      state.targetW = tabRect.width
      if (immediate) {
        state.x = state.targetX
        state.w = state.targetW
        state.vx = 0
        state.vw = 0
        lens.style.setProperty('--lens-x', `${state.x}px`)
        lens.style.setProperty('--lens-w', `${state.w}px`)
        return
      }
      if (!state.rafId) {
        state.lastTime = performance.now()
        state.rafId = requestAnimationFrame(step)
      }
    }

    track.querySelectorAll('.work-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        track.querySelectorAll('.work-tab').forEach(t => {
          t.classList.toggle('is-selected', t === tab)
        })
        sync(false)
      })
    })

    return { sync }
  }

  /**
   * 同步所有双胶囊液态玻璃滑块的显示比例与全局光学变量。
   */
  function applySliderRatio(kind, ratio) {
    document.querySelectorAll(`[data-liquid-slider="${kind}"]`).forEach(el => {
      el.style.setProperty('--slider-pct', `${(ratio * 100).toFixed(1)}%`)
    })
    if (kind === 'alpha') {
      const alpha = 0.68 + ratio * 0.32
      document.documentElement.style.setProperty('--canvas-alpha', alpha.toFixed(2))
      document.querySelectorAll('[data-alpha-output]').forEach(out => {
        out.textContent = `${Math.round(alpha * 100)}%`
      })
    } else if (kind === 'gap') {
      const gap = Math.round(4 + ratio * 10)
      document.documentElement.style.setProperty('--window-gap', `${gap}px`)
      document.querySelectorAll('[data-gap-output]').forEach(out => {
        out.textContent = `${gap}px`
      })
      requestAnimationFrame(() => controllers.forEach(c => c.sync(true)))
    }
  }

  /**
   * 初始化所有 Apple 双胶囊液态玻璃滑块拖拽交互。
   */
  function bindLiquidSliders() {
    document.querySelectorAll('[data-liquid-slider]').forEach(slider => {
      const kind = slider.getAttribute('data-liquid-slider')
      const updateFromX = clientX => {
        const rect = slider.getBoundingClientRect()
        const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
        if (kind) {
          applySliderRatio(kind, ratio)
        }
      }

      slider.addEventListener('pointerdown', ev => {
        slider.classList.add('is-dragging')
        slider.setPointerCapture(ev.pointerId)
        updateFromX(ev.clientX)
      })
      slider.addEventListener('pointermove', ev => {
        if (slider.classList.contains('is-dragging')) {
          updateFromX(ev.clientX)
        }
      })
      const stopDrag = () => slider.classList.remove('is-dragging')
      slider.addEventListener('pointerup', stopDrag)
      slider.addEventListener('pointercancel', stopDrag)
    })
  }

  function refreshAllTabLenses(immediate) {
    controllers.forEach(ctrl => ctrl.sync(immediate))
  }

  window.MydshGlassEngine = {
    refreshTabLens: refreshAllTabLenses,
    init() {
      mountRefractionFilter()
      document.querySelectorAll('.session-tabs-track').forEach(track => {
        const ctrl = createTrackController(track)
        if (ctrl) {
          controllers.push(ctrl)
        }
      })
      bindLiquidSliders()
      window.addEventListener('resize', () => refreshAllTabLenses(true))
      requestAnimationFrame(() => refreshAllTabLenses(true))
    },
  }
})()
