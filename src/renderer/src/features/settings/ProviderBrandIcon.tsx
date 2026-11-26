/**
 * 模型服务商官方矢量品牌标志：纯内联 SVG 实现主流大模型厂商标志，无外部网络依赖。
 * 运行在 renderer；使用 currentColor 自动适配明暗主题与 forced-colors 高对比度降级。
 */
import { Cpu } from 'lucide-react'
import type { ReactElement } from 'react'
import { resolveProviderBrand, type ProviderBrandKey } from './model-provider-meta.ts'

/** 品牌徽章组件属性。 */
export interface ProviderBrandIconProps {
  readonly providerId: string
  readonly displayName: string
  readonly baseURL?: string | null
  readonly size?: 'md' | 'lg'
}

interface GlyphProps {
  readonly size: number
}

function DeepSeekGlyph({ size }: GlyphProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M21.4 7.7c-.5-.3-1.2.1-1.9.7-.6.5-1.1.7-1.6.5-1.1-.4-2.4-.9-4-.9-3.9 0-6.8 2.4-8.1 5-.6-.2-1.4-.6-2-1.4-.4-.5-1.1-.4-1.3.2-.4 1.3.1 2.9 1.3 3.9-.3.7-.2 1.5.4 2.1 1.7 1.7 4.7 2.4 7.7 2.2 4.6-.3 8.1-3.3 8.8-7.4.3-1.7.4-3.1.9-4.1.2-.4.1-.7-.2-.8Z"
        fill="currentColor"
        fillOpacity="0.16"
        stroke="currentColor"
        strokeWidth="1.65"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M11.6 13.8c1.1 1.1 2.9 1.2 4.1.2"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <circle cx="15.3" cy="11.2" r="1.15" fill="currentColor" />
    </svg>
  )
}

function GoogleGeminiGlyph({ size }: GlyphProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 2.2C12.5 8 16 11.5 21.8 12 16 12.5 12.5 16 12 21.8 11.5 16 8 12.5 2.2 12 8 11.5 11.5 8 12 2.2Z"
        fill="currentColor"
      />
    </svg>
  )
}

function OpenAiGlyph({ size }: GlyphProps) {
  const angles = [0, 60, 120, 180, 240, 300]
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <g stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        {angles.map(angle => (
          <path
            key={angle}
            d="M12 12V5.8a3.2 3.2 0 0 1 5.4-2.3 3.2 3.2 0 0 1 .4 4.1L14.8 10.4"
            transform={`rotate(${angle} 12 12)`}
          />
        ))}
      </g>
    </svg>
  )
}

function AnthropicGlyph({ size }: GlyphProps) {
  const rays = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330]
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <g stroke="currentColor" strokeLinecap="round">
        {rays.map((angle, index) => (
          <line
            key={angle}
            x1="12"
            y1="12"
            x2="12"
            y2={index % 2 === 0 ? '3.1' : '5.2'}
            strokeWidth={index % 2 === 0 ? '1.85' : '1.45'}
            transform={`rotate(${angle} 12 12)`}
          />
        ))}
      </g>
      <circle cx="12" cy="12" r="2.1" fill="currentColor" />
    </svg>
  )
}

function ZhipuGlyph({ size }: GlyphProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4.5 5.5h15l-2.3 3.2H4.5V5.5Z" fill="currentColor" />
      <path d="M19.5 8.7 8.4 18.5H4.5l11.1-9.8h3.9Z" fill="currentColor" />
      <path d="M6.8 15.3h12.7v3.2H4.5l2.3-3.2Z" fill="currentColor" fillOpacity="0.86" />
    </svg>
  )
}

function QwenGlyph({ size }: GlyphProps) {
  const angles = [0, 60, 120, 180, 240, 300]
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <g stroke="currentColor" strokeWidth="1.55" strokeLinejoin="round">
        {angles.map(angle => (
          <path
            key={angle}
            d="M12 3.2 15.6 9.5 12 11.6 8.4 9.5 12 3.2Z"
            fill="currentColor"
            fillOpacity="0.14"
            transform={`rotate(${angle} 12 12)`}
          />
        ))}
      </g>
      <circle cx="12" cy="12" r="2" fill="currentColor" />
    </svg>
  )
}

function MoonshotGlyph({ size }: GlyphProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M17.2 15.6a7 7 0 0 1-8.8-8.8 7.3 7.3 0 1 0 8.8 8.8Z"
        fill="currentColor"
        fillOpacity="0.18"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinejoin="round"
      />
      <path
        d="M16.8 4.4c.2 1.4 1 2.2 2.4 2.4-1.4.2-2.2 1-2.4 2.4-.2-1.4-1-2.2-2.4-2.4 1.4-.2 2.2-1 2.4-2.4Z"
        fill="currentColor"
      />
    </svg>
  )
}

function MiniMaxGlyph({ size }: GlyphProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3.2" y="9" width="2.6" height="8" rx="1.3" fill="currentColor" />
      <rect x="7" y="5.5" width="2.6" height="13" rx="1.3" fill="currentColor" />
      <rect x="10.7" y="8" width="2.6" height="8.5" rx="1.3" fill="currentColor" />
      <rect x="14.4" y="5.5" width="2.6" height="13" rx="1.3" fill="currentColor" />
      <rect x="18.2" y="9" width="2.6" height="8" rx="1.3" fill="currentColor" />
    </svg>
  )
}

function XaiGlyph({ size }: GlyphProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M16.8 3.5h3.1L8.9 20.5H5.8L16.8 3.5Z" fill="currentColor" />
      <path d="M4.6 8.3h3.2l3.1 4.4-1.6 2.3-4.7-6.7Z" fill="currentColor" />
      <path d="M15.1 13.4 19.6 20.5h-3.2l-2.9-4.7 1.6-2.4Z" fill="currentColor" />
    </svg>
  )
}

function MistralGlyph({ size }: GlyphProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3.5" y="5" width="3.4" height="3.2" rx="0.5" fill="currentColor" />
      <rect x="17.1" y="5" width="3.4" height="3.2" rx="0.5" fill="currentColor" />
      <rect x="3.5" y="8.4" width="6.8" height="3.2" rx="0.5" fill="currentColor" />
      <rect x="13.7" y="8.4" width="6.8" height="3.2" rx="0.5" fill="currentColor" />
      <rect x="3.5" y="11.8" width="17" height="3.2" rx="0.5" fill="currentColor" />
      <rect x="3.5" y="15.2" width="3.4" height="3.6" rx="0.5" fill="currentColor" />
      <rect x="10.3" y="15.2" width="3.4" height="3.6" rx="0.5" fill="currentColor" />
      <rect x="17.1" y="15.2" width="3.4" height="3.6" rx="0.5" fill="currentColor" />
    </svg>
  )
}

function OpenRouterGlyph({ size }: GlyphProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4.2 12h4.2c2.1 0 3.1-4.5 6.2-4.5h4.2M8.4 12c2.1 0 3.1 4.5 6.2 4.5h4.2"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="m16.5 5 2.8 2.5-2.8 2.5M16.5 14l2.8 2.5-2.8 2.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="4.5" cy="12" r="1.8" fill="currentColor" />
    </svg>
  )
}

function OllamaGlyph({ size }: GlyphProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M8.4 9.5V5.4a1.6 1.6 0 0 1 3.1-.5l.5 2.4.5-2.4a1.6 1.6 0 0 1 3.1.5v4.1a5.4 5.4 0 0 1 1.9 4.1c0 3.1-2.5 5.4-5.5 5.4s-5.5-2.3-5.5-5.4a5.4 5.4 0 0 1 1.9-4.1Z"
        fill="currentColor"
        fillOpacity="0.14"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <circle cx="10" cy="13.2" r="1" fill="currentColor" />
      <circle cx="14" cy="13.2" r="1" fill="currentColor" />
      <path
        d="M10.7 15.7c.7.6 1.9.6 2.6 0"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  )
}

function VolcengineGlyph({ size }: GlyphProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12.2 3.4 4.2 19.2h5.2l2.8-5.7 2.8 5.7h4.8L12.2 3.4Z"
        fill="currentColor"
        fillOpacity="0.18"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path d="M12.2 8.2 15.2 14h-6l3-5.8Z" fill="currentColor" />
    </svg>
  )
}

function AzureGlyph({ size }: GlyphProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M10.8 4.2 4 18.8h4.5l4.4-9.8-2.1-4.8Z" fill="currentColor" fillOpacity="0.78" />
      <path d="M12.4 5.8 9.9 11.4l4.1 4.6-5.2.9L7.6 19.4H20L12.4 5.8Z" fill="currentColor" />
    </svg>
  )
}

function BedrockGlyph({ size }: GlyphProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 3.2 4.5 7.5v9L12 20.8l7.5-4.3v-9L12 3.2Z"
        fill="currentColor"
        fillOpacity="0.14"
        stroke="currentColor"
        strokeWidth="1.65"
        strokeLinejoin="round"
      />
      <path
        d="M4.5 7.5 12 11.8l7.5-4.3M12 11.8v9"
        stroke="currentColor"
        strokeWidth="1.65"
        strokeLinejoin="round"
      />
    </svg>
  )
}

const BRAND_GLYPHS: Readonly<
  Record<Exclude<ProviderBrandKey, 'custom'>, (props: GlyphProps) => ReactElement>
> = {
  deepseek: DeepSeekGlyph,
  google: GoogleGeminiGlyph,
  openai: OpenAiGlyph,
  anthropic: AnthropicGlyph,
  zhipu: ZhipuGlyph,
  qwen: QwenGlyph,
  moonshot: MoonshotGlyph,
  minimax: MiniMaxGlyph,
  xai: XaiGlyph,
  mistral: MistralGlyph,
  openrouter: OpenRouterGlyph,
  ollama: OllamaGlyph,
  volcengine: VolcengineGlyph,
  azure: AzureGlyph,
  bedrock: BedrockGlyph,
}

/** 根据提供方 ID、显示名与自定义端点域名渲染对应的官方品牌矢量徽章。 */
export function ProviderBrandIcon({
  providerId,
  displayName,
  baseURL,
  size = 'md',
}: ProviderBrandIconProps) {
  const brand = resolveProviderBrand(providerId, displayName, baseURL)
  const glyphSize = size === 'lg' ? 22 : 20
  const className =
    size === 'lg' ? 'models-provider-emblem models-provider-emblem--lg' : 'models-provider-emblem'
  const Glyph = brand.key === 'custom' ? null : BRAND_GLYPHS[brand.key]

  return (
    <span className={className} data-brand={brand.key} aria-hidden="true">
      {Glyph === null ? (
        <Cpu size={glyphSize - 1} strokeWidth={1.75} />
      ) : (
        <Glyph size={glyphSize} />
      )}
    </span>
  )
}
