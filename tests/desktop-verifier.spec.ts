// @vitest-environment jsdom
/**
 * 桌面验收基础设施测试：覆盖失败报告结构与弹层入场动画稳定后再采纳点击坐标。
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildTrustedClickTargetScript,
  createFailedVerifyReport,
} from '../src/main/verification/desktop-verifier.ts'

function makeRect(left: number, top: number): DOMRect {
  return {
    left,
    top,
    width: 80,
    height: 32,
    right: left + 80,
    bottom: top + 32,
    x: left,
    y: top,
    toJSON: () => ({ left, top, width: 80, height: 32 }),
  } as DOMRect
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
})
