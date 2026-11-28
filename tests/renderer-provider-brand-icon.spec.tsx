// @vitest-environment jsdom
/**
 * 提供商官方标志组件测试：验证彩色官方 SVG、单色遮罩标志、紧凑尺寸与未知提供商回退表现。
 */
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ProviderBrandIcon } from '../src/renderer/src/features/settings/ProviderBrandIcon.tsx'

afterEach(() => {
  cleanup()
})

describe('ProviderBrandIcon 官方提供商标志', () => {
  it('彩色官方品牌渲染矢量 img，单色官方品牌渲染 CSS 遮罩，未知提供商回退通用图标', () => {
    const { container, rerender } = render(
      <ProviderBrandIcon providerId="deepseek-official" displayName="DeepSeek" />,
    )
    const deepseek = container.querySelector<HTMLElement>('.models-provider-emblem')
    expect(deepseek?.dataset.brand).toBe('deepseek')
    expect(deepseek?.dataset.brandMode).toBe('color')
    const deepseekImg = deepseek?.querySelector<HTMLImageElement>('img.models-provider-emblem__img')
    expect(deepseekImg?.getAttribute('src')).toBeTruthy()

    rerender(<ProviderBrandIcon providerId="google" displayName="google" size="lg" />)
    const google = container.querySelector<HTMLElement>('.models-provider-emblem--lg')
    expect(google?.dataset.brand).toBe('google')
    expect(google?.dataset.brandMode).toBe('color')
    expect(google?.querySelector('img.models-provider-emblem__img')).toBeTruthy()

    rerender(<ProviderBrandIcon providerId="openai" displayName="OpenAI" size="sm" />)
    const openai = container.querySelector<HTMLElement>('.models-provider-emblem--sm')
    expect(openai?.dataset.brand).toBe('openai')
    expect(openai?.dataset.brandMode).toBe('mono')
    const mask = openai?.querySelector<HTMLElement>('.models-provider-emblem__mask')
    expect(mask?.style.maskImage).toContain('url(')

    rerender(<ProviderBrandIcon providerId="private-llm" displayName="私有网关" />)
    const fallback = container.querySelector<HTMLElement>('.models-provider-emblem')
    expect(fallback?.dataset.brand).toBe('custom')
    expect(fallback?.dataset.brandMode).toBe('fallback')
    expect(fallback?.querySelector('svg')).toBeTruthy()
  })
})
