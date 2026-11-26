import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  PRODUCT_BUNDLE_ID,
  PRODUCT_NAME,
  PRODUCT_SLUG,
  PRODUCT_UPDATE_REPOSITORY,
  PRODUCT_USER_DATA_DIRECTORY,
} from '../src/shared/product.ts'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const mainSource = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')

describe('MyDSH 正式产品身份', () => {
  it('运行时、package 与发行脚本共享稳定名称和 Bundle ID', () => {
    expect(PRODUCT_NAME).toBe('MyDSH')
    expect(PRODUCT_SLUG).toBe('mydsh')
    expect(PRODUCT_BUNDLE_ID).toBe('io.github.viviana-luna.mydsh')
    expect(PRODUCT_USER_DATA_DIRECTORY).toBe(PRODUCT_NAME)
    expect(PRODUCT_UPDATE_REPOSITORY).toBe('Viviana-Luna/MyDeepSeekHarness')
    expect(manifest.name).toBe(PRODUCT_SLUG)
    expect(manifest.productName).toBe(PRODUCT_NAME)
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+(?:-[\da-z.-]+)?$/iu)
    expect(manifest.repository).toBeUndefined()
  })

  it('主进程在创建窗口前取得单实例锁', () => {
    expect(mainSource.indexOf('app.requestSingleInstanceLock()')).toBeGreaterThan(0)
    expect(mainSource.indexOf('app.requestSingleInstanceLock()')).toBeLessThan(
      mainSource.indexOf('void main().catch'),
    )
    expect(mainSource).toContain("app.on('second-instance'")
  })
})
