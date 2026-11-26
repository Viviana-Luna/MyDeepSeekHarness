/**
 * MyDSH MVP 纵向多画板交互控制器（Scrollable Gallery & Micro-Interaction Controller）
 * 支持页面自由上下滚动浏览全部界面画板、章节锚点高亮、独立窗口透镜滑动与光学主题实时切换。
 */

;(function setupMydshShowcase() {
  const BOOT_PHASES = {
    install: {
      text: '正在校验并原子安装离线核心…',
      meta: '28% · ~/.mydsh/runtime/0.4.0',
      pct: '28%',
      done: false,
    },
    plugins: {
      text: '正在加载 Cordis 运行时与业务插件…',
      meta: '64% · 12 个模块已签名核验',
      pct: '64%',
      done: false,
    },
    workspace: {
      text: '正在准备光学浮岛工作空间…',
      meta: '88% · 受限 IPC 契约已连接',
      pct: '88%',
      done: false,
    },
    ready: {
      text: '启动成功 · 欢迎回到 MyDSH',
      meta: '100% · 冷启动耗时 420ms',
      pct: '100%',
      done: true,
    },
  }

  /**
   * 切换第一画板（启动加载页）的四个进度阶段。
   */
  function applyBootPhase(phaseKey) {
    const info = BOOT_PHASES[phaseKey]
    if (!info) {
      return
    }
    const textEl = document.getElementById('boot-phase-text')
    const metaEl = document.getElementById('boot-phase-meta')
    const fillEl = document.getElementById('boot-progress-fill')
    const orbEl = document.getElementById('boot-pulse-orb')

    if (textEl) {
      textEl.textContent = info.text
    }
    if (metaEl) {
      metaEl.textContent = info.meta
    }
    if (fillEl) {
      fillEl.style.setProperty('--boot-progress', info.pct)
    }
    if (orbEl) {
      orbEl.setAttribute('data-done', info.done ? 'true' : 'false')
    }
    document.querySelectorAll('[data-boot-phase]').forEach(btn => {
      btn.classList.toggle('is-active', btn.getAttribute('data-boot-phase') === phaseKey)
    })
  }

  /**
   * 绑定顶部悬浮画廊目录的平滑滚动跳转与滚动监听高亮。
   */
  function bindScrollSpyAndNav() {
    document.querySelectorAll('[data-scroll-to]').forEach(btn => {
      btn.addEventListener('click', () => {
        const targetId = btn.getAttribute('data-scroll-to')
        const section = targetId ? document.getElementById(targetId) : null
        if (section) {
          section.scrollIntoView({ behavior: 'smooth', block: 'start' })
        }
      })
    })

    const sections = document.querySelectorAll('.artboard-section[id]')
    if (!('IntersectionObserver' in window) || sections.length === 0) {
      return
    }

    const observer = new IntersectionObserver(
      entries => {
        entries.forEach(entry => {
          if (!entry.isIntersecting) {
            return
          }
          const activeId = entry.target.id
          document.querySelectorAll('.dock-scene-btn[data-scroll-to]').forEach(btn => {
            btn.classList.toggle('is-active', btn.getAttribute('data-scroll-to') === activeId)
          })
        })
      },
      { rootMargin: '-25% 0px -55% 0px', threshold: 0.05 },
    )

    sections.forEach(sec => observer.observe(sec))
  }

  /**
   * 在同一分组容器内单选激活指定元素。
   */
  function selectOnlyInGroup(container, selector, activeEl) {
    container.querySelectorAll(selector).forEach(el => {
      el.classList.toggle('is-active', el === activeEl)
    })
  }

  /**
   * 同步全页深浅主题 DOM 属性与按钮文案。
   */
  function syncSchemeUI(scheme) {
    if (scheme === 'light') {
      document.documentElement.setAttribute('data-color-scheme', 'light')
    } else {
      document.documentElement.removeAttribute('data-color-scheme')
    }
    const label = document.getElementById('dock-theme-label')
    if (label) {
      label.textContent = scheme === 'light' ? '浅色晨海' : '深海暗色'
    }
    document.querySelectorAll('[data-set-scheme]').forEach(b => {
      b.classList.toggle('is-active', b.getAttribute('data-set-scheme') === scheme)
    })
  }

  /**
   * 绑定主题深浅色与 6 款星辉强调色实时切换。
   */
  function bindAppearanceControls() {
    document.querySelectorAll('[data-theme-toggle]').forEach(btn => {
      btn.addEventListener('click', () => {
        const isLight = document.documentElement.getAttribute('data-color-scheme') === 'light'
        syncSchemeUI(isLight ? 'dark' : 'light')
      })
    })

    document.querySelectorAll('[data-set-scheme]').forEach(btn => {
      btn.addEventListener('click', () => {
        const scheme = btn.getAttribute('data-set-scheme') || 'dark'
        syncSchemeUI(scheme)
      })
    })

    document.querySelectorAll('[data-accent-color]').forEach(btn => {
      btn.addEventListener('click', () => {
        const hex = btn.getAttribute('data-accent-color')
        const bright = btn.getAttribute('data-accent-bright') || hex
        if (!hex) {
          return
        }
        document.documentElement.style.setProperty('--accent', hex)
        document.documentElement.style.setProperty('--accent-bright', bright)
        document.querySelectorAll('[data-accent-color]').forEach(b => {
          b.classList.toggle('is-active', b.getAttribute('data-accent-color') === hex)
        })
      })
    })
  }

  /**
   * 绑定每个窗口内的侧栏模式轨透镜滑动与左右浮岛折叠把手。
   */
  function bindShellControls() {
    document.querySelectorAll('.mode-btn[data-mode-idx]').forEach(btn => {
      btn.addEventListener('click', () => {
        const track = btn.closest('.mode-rail__track')
        if (!track) {
          return
        }
        track.style.setProperty('--mode-index', btn.getAttribute('data-mode-idx') || '0')
        selectOnlyInGroup(track, '.mode-btn[data-mode-idx]', btn)
      })
    })

    document.querySelectorAll('[data-toggle-left]').forEach(handle => {
      handle.addEventListener('click', () => {
        const shell = handle.closest('.app-shell')
        if (!shell) {
          return
        }
        const next = shell.getAttribute('data-nav-collapsed') === 'true' ? 'false' : 'true'
        shell.setAttribute('data-nav-collapsed', next)
        setTimeout(
          () => window.MydshGlassEngine && window.MydshGlassEngine.refreshTabLens(false),
          220,
        )
      })
    })

    document.querySelectorAll('[data-toggle-right]').forEach(handle => {
      handle.addEventListener('click', () => {
        const shell = handle.closest('.app-shell')
        if (!shell) {
          return
        }
        const collapsed = shell.getAttribute('data-info-collapsed') === 'true'
        shell.setAttribute('data-info-collapsed', collapsed ? 'false' : 'true')
        shell.setAttribute('data-full-main', collapsed ? 'false' : 'true')
      })
    })
  }

  /**
   * 绑定启动阶段按钮、空状态起手卡、过程折叠抽屉、连接子开关与拨动开关。
   */
  function bindViewWidgets() {
    document.querySelectorAll('[data-boot-phase]').forEach(btn => {
      btn.addEventListener('click', () => {
        const phase = btn.getAttribute('data-boot-phase')
        if (phase) {
          applyBootPhase(phase)
        }
      })
    })

    document.querySelectorAll('[data-starter-prompt]').forEach(card => {
      card.addEventListener('click', () => {
        const promptText = card.getAttribute('data-starter-prompt') || ''
        const input = document.getElementById('zero-composer-input')
        if (input) {
          input.value = promptText
          input.focus()
        }
      })
    })

    document.querySelectorAll('.preset-pill').forEach(pill => {
      pill.addEventListener('click', () => {
        const group = pill.closest('.preset-capsule-track')
        if (group) {
          selectOnlyInGroup(group, '.preset-pill', pill)
        }
      })
    })

    document.querySelectorAll('[data-disclosure-toggle]').forEach(btn => {
      btn.addEventListener('click', () => {
        const bodyId = btn.getAttribute('data-disclosure-toggle')
        const body = bodyId ? document.getElementById(bodyId) : null
        if (body) {
          body.hidden = !body.hidden
        }
      })
    })

    document.querySelectorAll('.liquid-switch').forEach(sw => {
      sw.addEventListener('click', () => {
        const checked = sw.getAttribute('aria-checked') === 'true'
        sw.setAttribute('aria-checked', checked ? 'false' : 'true')
      })
    })
  }

  /**
   * 绑定独立 SSH 画板侧栏主机切换与独立数据库画板库表对象切换。
   */
  function bindConnectionSidebar() {
    document.querySelectorAll('[data-ssh-host]').forEach(item => {
      item.addEventListener('click', () => {
        const navPane = item.closest('.navigation-pane')
        if (navPane) {
          selectOnlyInGroup(navPane, '.host-nav-item', item)
        }
        const host = item.getAttribute('data-ssh-host') || 'prod-gateway-hk01'
        const userHost = item.getAttribute('data-ssh-user') || `deploy@${host}`
        const rtt = item.getAttribute('data-ssh-rtt') || '18ms'

        const titleEl = document.getElementById('ssh-active-target')
        const rttEl = document.getElementById('ssh-active-rtt')
        const tabEl = document.getElementById('ssh-tab-label')
        if (titleEl) {
          titleEl.textContent = userHost
        }
        if (rttEl) {
          rttEl.textContent = rtt
        }
        if (tabEl) {
          tabEl.textContent = `${host} (zsh)`
        }
        document.querySelectorAll('.ssh-prompt-user').forEach(el => {
          el.textContent = userHost
        })
      })
    })

    document.querySelectorAll('[data-db-table]').forEach(row => {
      row.addEventListener('click', () => {
        const tree = row.closest('.file-tree')
        if (tree) {
          selectOnlyInGroup(tree, '[data-db-table]', row)
        }
        const table = row.getAttribute('data-db-table') || 'session_events'
        const headTable = document.getElementById('db-active-table')
        const sqlTable = document.getElementById('db-sql-table')
        const tabLabel = document.getElementById('db-tab-label')
        if (headTable) {
          headTable.textContent = table
        }
        if (sqlTable) {
          sqlTable.textContent = table
        }
        if (tabLabel) {
          tabLabel.textContent = `${table}.sql`
        }
      })
    })
  }

  /**
   * 绑定模态对话框、待办抽屉、HUD 上下文构成浮窗与快捷键。
   */
  function bindModalsAndPopovers() {
    const hudBtn = document.getElementById('hud-context-btn')
    const hudPop = document.getElementById('hud-context-popover')
    if (hudBtn && hudPop) {
      hudBtn.addEventListener('click', ev => {
        ev.stopPropagation()
        const nextHidden = !hudPop.hidden
        hudPop.hidden = nextHidden
        hudBtn.setAttribute('aria-expanded', nextHidden ? 'false' : 'true')
      })
      document.addEventListener('click', () => {
        hudPop.hidden = true
        hudBtn.setAttribute('aria-expanded', 'false')
      })
    }

    const todoBtn = document.getElementById('todo-drawer-toggle')
    const todoList = document.getElementById('todo-drawer-list')
    if (todoBtn && todoList) {
      todoBtn.addEventListener('click', () => {
        todoList.hidden = !todoList.hidden
      })
    }

    document.querySelectorAll('[data-open-modal]').forEach(btn => {
      btn.addEventListener('click', () => {
        const modalId = btn.getAttribute('data-open-modal')
        const modal = modalId ? document.getElementById(modalId) : null
        if (modal) {
          modal.hidden = false
        }
      })
    })

    document.querySelectorAll('[data-close-modal]').forEach(btn => {
      btn.addEventListener('click', () => {
        const modal = btn.closest('.modal-backdrop')
        if (modal) {
          modal.hidden = true
        }
      })
    })

    document.querySelectorAll('.modal-backdrop').forEach(backdrop => {
      backdrop.addEventListener('click', ev => {
        if (ev.target === backdrop) {
          backdrop.hidden = true
        }
      })
    })

    window.addEventListener('keydown', ev => {
      if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'k') {
        ev.preventDefault()
        const modal = document.getElementById('search-modal')
        if (modal) {
          modal.hidden = !modal.hidden
        }
      } else if (ev.key === 'Escape') {
        document.querySelectorAll('.modal-backdrop').forEach(m => {
          m.hidden = true
        })
      }
    })
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (window.MydshGlassEngine) {
      window.MydshGlassEngine.init()
    }
    bindScrollSpyAndNav()
    bindAppearanceControls()
    bindShellControls()
    bindViewWidgets()
    bindConnectionSidebar()
    bindModalsAndPopovers()
    applyBootPhase('plugins')
  })
})()
