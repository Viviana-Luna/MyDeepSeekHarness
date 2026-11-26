import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import {
  createStartupScreenDocument,
  createStartupScreenSnapshot,
  createStartupScreenUpdateScript,
} from '../src/main/startup/startup-screen.ts'

const images = { light: 'data:image/png;base64,AA==', dark: 'data:image/png;base64,AQ==' }

function createDocument() {
  return new JSDOM(createStartupScreenDocument(images, 'dark'), { runScripts: 'outside-only' })
}

describe('启动画面', () => {
  it('Windows 在右上角提供三个固定窗口按钮，启动期间禁用最大化', () => {
    const dom = new JSDOM(createStartupScreenDocument(images, 'light', 'win32'))
    const document = dom.window.document
    expect(document.documentElement.dataset.platform).toBe('win32')
    expect(
      [...document.querySelectorAll('button')].map(button => button.getAttribute('aria-label')),
    ).toEqual(['最小化窗口', '最大化窗口', '关闭窗口'])
    expect(
      (document.querySelector('[data-window-action="toggle-maximize"]') as HTMLButtonElement | null)
        ?.disabled,
    ).toBe(true)
    expect(document.querySelector('.launch-window button')).toBeNull()
    expect(document.querySelector('script')?.src).toBe('startup-window-controls.js')
    dom.window.close()
  })

  it('沿用已保存配色，横条与状态文字同步真实启动阶段', () => {
    const dom = createDocument()
    const document = dom.window.document
    expect(document.documentElement.dataset.colorScheme).toBe('dark')
    expect(document.querySelectorAll('.art')).toHaveLength(2)
    expect(document.querySelector('a, button')).toBeNull()
    expect(document.querySelectorAll('[role="progressbar"]')).toHaveLength(1)
    const progress = document.querySelector('[role="progressbar"]') as HTMLDivElement | null
    expect(progress?.getAttribute('aria-label')).toBe('启动进度')
    expect(progress?.getAttribute('aria-valuenow')).toBeNull()
    expect(document.body.textContent).not.toMatch(/让 DSH|本机启动|启动阶段/u)
    expect(document.querySelectorAll('[role="status"]')).toHaveLength(1)
    for (const [phase, label] of [
      ['checking', '正在启动'],
      ['installing', '正在启动'],
      ['starting', '正在加载插件'],
      ['workspace', '正在准备工作空间'],
      ['ready', '启动成功'],
    ] as const) {
      dom.window.eval(createStartupScreenUpdateScript(createStartupScreenSnapshot(phase)))
      expect(document.getElementById('startup-status')?.textContent).toBe(label)
      expect(progress?.getAttribute('aria-valuetext')).toBe(label)
      expect(progress?.hidden).toBe(phase === 'ready')
    }
    dom.window.close()
  })

  it('状态文字不能作为 HTML 执行', () => {
    const dom = createDocument()
    const label = '<img src=x onerror=alert(1)>'
    dom.window.eval(createStartupScreenUpdateScript({ phase: 'checking', label }))
    expect(dom.window.document.getElementById('startup-status')?.textContent).toBe(label)
    expect(dom.window.document.querySelector('#startup-status img')).toBeNull()
    expect(
      dom.window.document.getElementById('startup-progress')?.getAttribute('aria-valuetext'),
    ).toBe(label)
    dom.window.close()
  })
})
