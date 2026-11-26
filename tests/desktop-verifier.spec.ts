import { describe, expect, it } from 'vitest'
import { createFailedVerifyReport } from '../src/main/verification/desktop-verifier.ts'

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
})
