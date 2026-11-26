/**
 * MyDSH MVP 克制型微像素动效与真实 Agent 对话流播放器
 *
 * 职责：
 * 1. 驱动画板 02 空会话圆角暗色玻璃内的 15×9 点阵星核微光波纹与指针涟漪；
 * 2. 驱动画板 03 真实 Agent 执行流动画：思考折叠条 -> 文件读写工具调用卡 -> 流式正文与计划审阅卡。
 */
;(function initMydshPixelStream() {
  const PATTERN_THINK_DONE = [0, 1, 0, 1, 1, 1, 0, 1, 0]
  const PATTERN_TOOL_DONE = [1, 0, 1, 0, 1, 0, 1, 0, 1]

  const PROSE_CHUNKS = [
    '已对比顶栏标签页与其余面板的样式实现：',
    '只需将顶栏的',
    '「沉降凹槽 + 顶部镜面受光透镜」',
    '提炼为全局共享 Token，',
    '并收敛三座浮岛、',
    '左侧 50px 模式导轨',
    '与底部指令舱的同心圆角，',
    '即可消除拼凑感。',
    '以下是分步实施计划：',
  ]

  /** 读取当前主题强调色 RGB 分量，使空状态点阵徽章随 6 种强调色联动 */
  function readAccentRgb() {
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
    if (raw.startsWith('#') && raw.length === 7) {
      const num = Number.parseInt(raw.slice(1), 16)
      if (!Number.isNaN(num)) {
        return [(num >> 16) & 255, (num >> 8) & 255, num & 255]
      }
    }
    return [94, 124, 255]
  }

  /** 确定性伪随机序列，用于思考/工具执行期的柔和微像素闪烁 */
  function stepNoise(index, tick) {
    const val = Math.sin(index * 19.13 + tick * 5.71) * 43758.5453
    return val - Math.floor(val)
  }

  /** 初始化页面中的 3×3 微像素点阵与行内 6 柱迷你脉冲节点 */
  function populateMicroPixelWidgets() {
    document.querySelectorAll('.pixel-dot-3x3').forEach(dotGrid => {
      dotGrid.innerHTML = ''
      const donePattern = dotGrid.dataset.kind === 'think' ? PATTERN_THINK_DONE : PATTERN_TOOL_DONE
      for (let i = 0; i < 9; i += 1) {
        const cell = document.createElement('i')
        if (donePattern[i]) cell.classList.add('is-lit')
        dotGrid.appendChild(cell)
      }
    })

    document.querySelectorAll('.mini-pixel-wave').forEach(wave => {
      wave.innerHTML = ''
      for (let i = 0; i < 6; i += 1) {
        const bar = document.createElement('i')
        bar.style.setProperty('--bar-h', `${4 + ((i * 2) % 6)}px`)
        wave.appendChild(bar)
      }
    })
  }

  /** 渲染画板 02 的 15×9 圆角暗色玻璃点阵小徽章 */
  function initZeroMatrixBeacon() {
    const canvas = document.getElementById('zero-matrix-canvas')
    if (!(canvas instanceof HTMLCanvasElement)) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const cols = 15
    const rows = 9
    const pointer = { x: -10, y: -10, active: false }

    canvas.addEventListener('pointermove', e => {
      const rect = canvas.getBoundingClientRect()
      pointer.x = ((e.clientX - rect.left) / rect.width) * cols
      pointer.y = ((e.clientY - rect.top) / rect.height) * rows
      pointer.active = true
    })
    canvas.addEventListener('pointerleave', () => {
      pointer.active = false
    })

    function drawFrame(now) {
      const t = now * 0.002
      const [ar, ag, ab] = readAccentRgb()
      ctx.clearRect(0, 0, canvas.width, canvas.height)

      for (let r = 0; r < rows; r += 1) {
        for (let c = 0; c < cols; c += 1) {
          const dist = Math.hypot(c - 7, r - 5)
          const wave = Math.max(0, Math.sin(dist * 0.95 - t) * 0.32)
          let alpha = 0.12 + wave * Math.max(0, 1 - dist / 8.2)

          if (c === 7 && r === 5) alpha = 0.98
          else if (Math.abs(c - 7) + Math.abs(r - 5) === 1) alpha = 0.72

          if (pointer.active) {
            const pDist = Math.hypot(c - pointer.x, r - pointer.y)
            if (pDist < 3) alpha = Math.min(1, alpha + (1 - pDist / 3) * 0.65)
          }

          ctx.fillStyle =
            c === 7 && r === 5
              ? 'rgba(244, 248, 255, 0.96)'
              : `rgba(${ar}, ${ag}, ${ab}, ${alpha.toFixed(3)})`
          ctx.fillRect(3.5 + c * 4.7, 3.5 + r * 4.6, 2.9, 2.9)
        }
      }
      requestAnimationFrame(drawFrame)
    }

    requestAnimationFrame(drawFrame)
  }

  /** 更新单个思考/工具卡片的运行态、3×3 微像素点阵与迷你脉冲高度 */
  function syncStepCardState(card, mode, tick) {
    if (!card) return
    const isRunning = mode === 'running'
    const isPending = mode === 'pending'
    card.classList.toggle('is-running', isRunning)
    card.dataset.stepHidden = isPending ? 'true' : 'false'

    const grid = card.querySelector('.pixel-dot-3x3')
    if (grid) {
      const donePattern = grid.dataset.kind === 'think' ? PATTERN_THINK_DONE : PATTERN_TOOL_DONE
      grid.querySelectorAll('i').forEach((cell, idx) => {
        let lit = Boolean(donePattern[idx])
        if (isPending) lit = false
        if (isRunning) lit = stepNoise(idx, tick) > 0.45
        cell.classList.toggle('is-lit', lit)
      })
    }

    if (isRunning) {
      card.querySelectorAll('.mini-pixel-wave i').forEach((bar, idx) => {
        const h = 3 + Math.round(stepNoise(idx + 3, tick) * 8)
        bar.style.setProperty('--bar-h', `${h}px`)
      })
    }
  }

  /** 更新助手流式回复正文的已显影词块与像素方块游标 */
  function renderStreamingProse(proseEl, visibleCount, isDone) {
    if (!proseEl) return
    if (visibleCount <= 0) {
      proseEl.innerHTML = '<span class="pixel-block-cursor" data-idle="false"></span>'
      return
    }
    const html = PROSE_CHUNKS.slice(0, visibleCount)
      .map((chunk, idx) => {
        const isFresh = !isDone && idx === visibleCount - 1
        const cls = isFresh ? 'tok-chunk is-fresh' : 'tok-chunk'
        return `<span class="${cls}">${chunk}</span>`
      })
      .join('')
    const cursor = `<span class="pixel-block-cursor" data-idle="${isDone ? 'true' : 'false'}"></span>`
    proseEl.innerHTML = `${html}${cursor}`
  }

  /** 恢复画板 03 对话流的流式生成完毕定格态 */
  function applySettledConversation(els) {
    syncStepCardState(els.thinkCard, 'done', 0)
    syncStepCardState(els.readCard, 'done', 0)
    syncStepCardState(els.editCard, 'done', 0)
    renderStreamingProse(els.prose, PROSE_CHUNKS.length, true)
    if (els.ring) els.ring.dataset.streaming = 'false'
    if (els.planCard) els.planCard.dataset.streamReveal = 'ready'
  }

  /** 推进单帧真实 Agent 步骤链（思考 -> 读取 -> 编辑预览 -> 正文流式输出） */
  function advanceConversationTick(els, tick) {
    const thinkMode = tick < 8 ? 'running' : 'done'
    let readMode = 'done'
    if (tick < 8) readMode = 'pending'
    else if (tick < 14) readMode = 'running'

    let editMode = 'done'
    if (tick < 14) editMode = 'pending'
    else if (tick < 20) editMode = 'running'

    syncStepCardState(els.thinkCard, thinkMode, tick)
    syncStepCardState(els.readCard, readMode, tick)
    syncStepCardState(els.editCard, editMode, tick)

    const proseTick = Math.max(0, tick - 16)
    const chunkCount = Math.min(
      PROSE_CHUNKS.length,
      Math.floor((proseTick / 16) * PROSE_CHUNKS.length),
    )
    renderStreamingProse(els.prose, chunkCount, false)
  }

  /** 绑定画板 03 的流式动画播放与滚入自动演示 */
  function initConversationFlowPlayer() {
    const prose = document.getElementById('live-stream-prose')
    if (!prose) return

    const els = {
      thinkCard: document.getElementById('step-think-card'),
      readCard: document.getElementById('step-read-card'),
      editCard: document.getElementById('step-edit-card'),
      prose,
      ring: document.getElementById('composer-stream-ring'),
      planCard: document.getElementById('stream-plan-card'),
    }

    let timerId = 0

    function playFlow() {
      window.clearInterval(timerId)
      let tick = 0
      const maxTicks = 34
      if (els.ring) els.ring.dataset.streaming = 'true'
      if (els.planCard) els.planCard.dataset.streamReveal = 'pending'

      timerId = window.setInterval(() => {
        tick += 1
        if (tick >= maxTicks) {
          window.clearInterval(timerId)
          applySettledConversation(els)
          return
        }
        advanceConversationTick(els, tick)
      }, 100)
    }

    applySettledConversation(els)

    document.querySelectorAll('[data-replay-stream]').forEach(btn => {
      btn.addEventListener('click', playFlow)
    })

    const section = document.getElementById('artboard-chat')
    if (section && 'IntersectionObserver' in window) {
      let playedOnce = false
      const observer = new IntersectionObserver(
        entries => {
          if (entries.some(e => e.isIntersecting) && !playedOnce) {
            playedOnce = true
            playFlow()
          }
        },
        { threshold: 0.35 },
      )
      observer.observe(section)
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    populateMicroPixelWidgets()
    initZeroMatrixBeacon()
    initConversationFlowPlayer()
  })
})()
