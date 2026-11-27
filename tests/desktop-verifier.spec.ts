// @vitest-environment jsdom
/**
 * 桌面验收基础设施测试：覆盖失败报告结构、弹层入场动画稳定、跳过退场弹层，
 * 以及等待期间节点塌缩 0×0 或替换后的动态重绑行为。
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildTrustedClickTargetScript,
  createFailedVerifyReport,
} from '../src/main/verification/desktop-verifier.ts'

function makeRect(left: number, top: number, width = 80, height = 32): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({ left, top, width, height }),
  } as DOMRect
}

function makeModalButton(options: {
  modalClass: string
  wrapClass?: string
  ariaLabel: string
  left: number
  top: number
  opacity?: string
}): { wrap: HTMLDivElement; modal: HTMLDivElement; button: HTMLButtonElement } {
  const wrap = document.createElement('div')
  wrap.className = options.wrapClass ?? 'ant-modal-wrap'
  const modal = document.createElement('div')
  modal.className = options.modalClass
  modal.style.opacity = options.opacity ?? '1'
  modal.getAnimations = () => []
  const footer = document.createElement('div')
  footer.className = 'ant-modal-footer'
  const button = document.createElement('button')
  button.setAttribute('aria-label', options.ariaLabel)
  button.checkVisibility = () => true
  button.getClientRects = () => [makeRect(options.left, options.top)] as unknown as DOMRectList
  button.getBoundingClientRect = () => makeRect(options.left, options.top)
  footer.append(button)
  modal.append(footer)
  wrap.append(modal)
  return { wrap, modal, button }
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('真实 Electron 验收基础设施', () => {
  it('失败报告保留发生阶段和可显示错误', () => {
    const report = createFailedVerifyReport('settings', new Error('设置验收失败'), true)
    expect(report).toMatchObject({
      verificationStage: 'settings',
      hostReady: true,
      error: '设置验收失败',
      blank: true,
      appMounted: false,
    })
  })

  it('点击 AntD 弹层按钮前等待入场类名与透明度落稳，不采纳准备态坐标', async () => {
    const modal = document.createElement('div')
    modal.className = 'ant-modal ant-zoom-appear ant-zoom-appear-prepare'
    modal.style.opacity = '0'
    modal.getAnimations = () => []
    const button = document.createElement('button')
    button.className = 'ant-btn-primary'
    modal.append(button)
    document.body.append(modal)

    let settled = false
    button.checkVisibility = () => true
    button.getClientRects = () =>
      [makeRect(settled ? 360 : 60, settled ? 284 : 84)] as unknown as DOMRectList
    button.getBoundingClientRect = () => makeRect(settled ? 360 : 60, settled ? 284 : 84)
    document.elementFromPoint = () => button

    setTimeout(() => {
      modal.className = 'ant-modal ant-zoom-appear ant-zoom-appear-start'
    }, 30)
    setTimeout(() => {
      settled = true
      modal.className = 'ant-modal'
      modal.style.opacity = '1'
    }, 90)

    const evaluate = new Function(
      `return ${buildTrustedClickTargetScript('.ant-btn-primary')}`,
    ) as () => Promise<{
      x: number
      y: number
    }>
    const point = await evaluate()
    expect(point).toEqual({ x: 400, y: 300 })
  })

  it('点击液态形变菜单项前等待 data-menu-morph 从 active 变为 settled', async () => {
    const menu = document.createElement('div')
    menu.setAttribute('data-anchored-menu', 'true')
    menu.dataset.menuMorph = 'active'
    menu.style.opacity = '1'
    menu.getAnimations = () => []
    const item = document.createElement('button')
    item.setAttribute('role', 'menuitem')
    menu.append(item)
    document.body.append(menu)

    let settled = false
    item.checkVisibility = () => true
    item.getClientRects = () =>
      [makeRect(settled ? 260 : 80, settled ? 184 : 64)] as unknown as DOMRectList
    item.getBoundingClientRect = () => makeRect(settled ? 260 : 80, settled ? 184 : 64)
    document.elementFromPoint = () => item

    setTimeout(() => {
      settled = true
      menu.dataset.menuMorph = 'settled'
    }, 60)

    const evaluate = new Function(
      `return ${buildTrustedClickTargetScript('[role="menuitem"]')}`,
    ) as () => Promise<{ x: number; y: number }>
    const point = await evaluate()
    expect(point).toEqual({ x: 300, y: 200 })
  })

  it('跳过处于 -leave 退场动画的旧弹窗，绑定到新打开的可见确认按钮', async () => {
    const leaving = makeModalButton({
      modalClass: 'ant-modal ant-zoom-leave ant-zoom-leave-active',
      ariaLabel: '确认取消暂存',
      left: 40,
      top: 40,
    })
    const leavingWrap = makeModalButton({
      wrapClass: 'ant-modal-wrap ant-fade-leave-start',
      modalClass: 'ant-modal',
      ariaLabel: '确认取消暂存',
      left: 120,
      top: 40,
    })
    document.body.append(leaving.wrap, leavingWrap.wrap)

    let replacementButton: HTMLButtonElement | null = null
    document.elementFromPoint = (x, y) => {
      if (replacementButton && x === 400 && y === 300) return replacementButton
      if (x === 80 && y === 56) return leaving.button
      return document.documentElement
    }

    setTimeout(() => {
      const fresh = makeModalButton({
        modalClass: 'ant-modal',
        ariaLabel: '确认取消暂存',
        left: 360,
        top: 284,
      })
      replacementButton = fresh.button
      document.body.append(fresh.wrap)
    }, 60)

    const evaluate = new Function(
      `return ${buildTrustedClickTargetScript('.ant-modal-footer button[aria-label="确认取消暂存"]')}`,
    ) as () => Promise<{ x: number; y: number }>
    const point = await evaluate()
    expect(point).toEqual({ x: 400, y: 300 })
  })

  it('等待弹层入场期间目标节点塌缩为 0×0 并卸载后，重新绑定到新打开的可见按钮', async () => {
    const stale = makeModalButton({
      modalClass: 'ant-modal ant-zoom-appear ant-zoom-appear-start',
      ariaLabel: '确认取消暂存',
      left: 60,
      top: 84,
      opacity: '0',
    })
    document.body.append(stale.wrap)

    let collapsed = false
    stale.button.checkVisibility = () => !collapsed
    stale.button.getBoundingClientRect = () => (collapsed ? makeRect(0, 0, 0, 0) : makeRect(60, 84))
    stale.button.getClientRects = () =>
      (collapsed ? [] : [makeRect(60, 84)]) as unknown as DOMRectList

    let replacementButton: HTMLButtonElement | null = null
    document.elementFromPoint = (x, y) => {
      if (replacementButton && x === 440 && y === 320) return replacementButton
      return document.documentElement
    }

    setTimeout(() => {
      collapsed = true
      stale.modal.className = 'ant-modal ant-zoom-leave ant-zoom-leave-active'
      stale.wrap.remove()
    }, 40)
    setTimeout(() => {
      const fresh = makeModalButton({
        modalClass: 'ant-modal',
        ariaLabel: '确认取消暂存',
        left: 400,
        top: 304,
      })
      replacementButton = fresh.button
      document.body.append(fresh.wrap)
    }, 90)

    const evaluate = new Function(
      `return ${buildTrustedClickTargetScript('.ant-modal-footer button[aria-label="确认取消暂存"]')}`,
    ) as () => Promise<{ x: number; y: number }>
    const point = await evaluate()
    expect(point).toEqual({ x: 440, y: 320 })
  })

  it('命中稳定探测期间旧按钮突然塌缩为 0×0 后不死测 (0,0)，立即重绑到新按钮', async () => {
    const stale = makeModalButton({
      modalClass: 'ant-modal',
      ariaLabel: '确认取消暂存',
      left: 100,
      top: 100,
    })
    document.body.append(stale.wrap)

    let hitProbes = 0
    let collapsed = false
    stale.button.getBoundingClientRect = () =>
      collapsed ? makeRect(0, 0, 0, 0) : makeRect(100, 100)

    let replacementButton: HTMLButtonElement | null = null
    document.elementFromPoint = (x, y) => {
      if (replacementButton && x === 500 && y === 400) return replacementButton
      if (!collapsed && x === 140 && y === 116) {
        hitProbes += 1
        if (hitProbes === 1) {
          collapsed = true
          stale.modal.className = 'ant-modal ant-zoom-leave ant-zoom-leave-active'
          const fresh = makeModalButton({
            modalClass: 'ant-modal',
            ariaLabel: '确认取消暂存',
            left: 460,
            top: 384,
          })
          replacementButton = fresh.button
          document.body.append(fresh.wrap)
        }
        return stale.button
      }
      return document.documentElement
    }

    const evaluate = new Function(
      `return ${buildTrustedClickTargetScript('.ant-modal-footer button[aria-label="确认取消暂存"]')}`,
    ) as () => Promise<{ x: number; y: number }>
    const point = await evaluate()
    expect(point).toEqual({ x: 500, y: 400 })
  })

  it('目标持续存活且被其他可见遮罩遮挡时，仍准确抛出遮挡诊断错误', async () => {
    const target = makeModalButton({
      modalClass: 'ant-modal',
      ariaLabel: '确认取消暂存',
      left: 360,
      top: 284,
    })
    const blocker = document.createElement('div')
    blocker.className = 'verify-blocker'
    document.body.append(target.wrap, blocker)
    document.elementFromPoint = () => blocker

    const evaluate = new Function(
      `return ${buildTrustedClickTargetScript('.ant-modal-footer button[aria-label="确认取消暂存"]')}`,
    ) as () => Promise<{ x: number; y: number }>
    await expect(evaluate()).rejects.toThrow('验收目标被其他元素遮挡：')
  })
})
