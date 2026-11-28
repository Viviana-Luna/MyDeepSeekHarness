/**
 * 提供商官方矢量标志：直接复用 `@lobehub/icons-static-svg` 收录的官方品牌 SVG，随前端离线打包。
 * 运行在 renderer；彩色官方标志以原色矢量图渲染，单色官方标志经 CSS 遮罩自适应明暗主题与强制色彩。
 */
import anthropicSvg from '@lobehub/icons-static-svg/icons/anthropic.svg'
import azureColorSvg from '@lobehub/icons-static-svg/icons/azure-color.svg'
import baichuanColorSvg from '@lobehub/icons-static-svg/icons/baichuan-color.svg'
import basetenSvg from '@lobehub/icons-static-svg/icons/baseten.svg'
import bedrockColorSvg from '@lobehub/icons-static-svg/icons/bedrock-color.svg'
import cerebrasSvg from '@lobehub/icons-static-svg/icons/cerebras.svg'
import claudeColorSvg from '@lobehub/icons-static-svg/icons/claude-color.svg'
import cloudflareColorSvg from '@lobehub/icons-static-svg/icons/cloudflare-color.svg'
import cohereColorSvg from '@lobehub/icons-static-svg/icons/cohere-color.svg'
import deepseekColorSvg from '@lobehub/icons-static-svg/icons/deepseek-color.svg'
import fireworksColorSvg from '@lobehub/icons-static-svg/icons/fireworks-color.svg'
import geminiColorSvg from '@lobehub/icons-static-svg/icons/gemini-color.svg'
import githubCopilotSvg from '@lobehub/icons-static-svg/icons/githubcopilot.svg'
import googleColorSvg from '@lobehub/icons-static-svg/icons/google-color.svg'
import groqSvg from '@lobehub/icons-static-svg/icons/groq.svg'
import huggingfaceColorSvg from '@lobehub/icons-static-svg/icons/huggingface-color.svg'
import hunyuanColorSvg from '@lobehub/icons-static-svg/icons/hunyuan-color.svg'
import kimiSvg from '@lobehub/icons-static-svg/icons/kimi.svg'
import lingColorSvg from '@lobehub/icons-static-svg/icons/ling-color.svg'
import metaColorSvg from '@lobehub/icons-static-svg/icons/meta-color.svg'
import minimaxColorSvg from '@lobehub/icons-static-svg/icons/minimax-color.svg'
import mistralColorSvg from '@lobehub/icons-static-svg/icons/mistral-color.svg'
import moonshotSvg from '@lobehub/icons-static-svg/icons/moonshot.svg'
import nvidiaColorSvg from '@lobehub/icons-static-svg/icons/nvidia-color.svg'
import ollamaSvg from '@lobehub/icons-static-svg/icons/ollama.svg'
import openaiSvg from '@lobehub/icons-static-svg/icons/openai.svg'
import opencodeSvg from '@lobehub/icons-static-svg/icons/opencode.svg'
import openrouterSvg from '@lobehub/icons-static-svg/icons/openrouter.svg'
import perplexityColorSvg from '@lobehub/icons-static-svg/icons/perplexity-color.svg'
import qwenColorSvg from '@lobehub/icons-static-svg/icons/qwen-color.svg'
import siliconcloudColorSvg from '@lobehub/icons-static-svg/icons/siliconcloud-color.svg'
import sparkColorSvg from '@lobehub/icons-static-svg/icons/spark-color.svg'
import stepfunColorSvg from '@lobehub/icons-static-svg/icons/stepfun-color.svg'
import togetherColorSvg from '@lobehub/icons-static-svg/icons/together-color.svg'
import typesafeAiSvg from '@lobehub/icons-static-svg/icons/typesafeai.svg'
import vercelSvg from '@lobehub/icons-static-svg/icons/vercel.svg'
import vertexaiColorSvg from '@lobehub/icons-static-svg/icons/vertexai-color.svg'
import volcengineColorSvg from '@lobehub/icons-static-svg/icons/volcengine-color.svg'
import wenxinColorSvg from '@lobehub/icons-static-svg/icons/wenxin-color.svg'
import xaiSvg from '@lobehub/icons-static-svg/icons/xai.svg'
import xiaomiMimoSvg from '@lobehub/icons-static-svg/icons/xiaomimimo.svg'
import yiSvg from '@lobehub/icons-static-svg/icons/yi.svg'
import zaiSvg from '@lobehub/icons-static-svg/icons/zai.svg'
import zhipuColorSvg from '@lobehub/icons-static-svg/icons/zhipu-color.svg'
import { Cpu } from 'lucide-react'
import type { CSSProperties } from 'react'
import { resolveProviderBrand, type ProviderBrandKey } from './model-provider-meta.ts'
import './provider-brand-icon.css'

/** 提供商标志组件属性。 */
export interface ProviderBrandIconProps {
  readonly providerId: string
  readonly displayName: string
  readonly baseURL?: string | null
  readonly size?: 'sm' | 'md' | 'lg'
}

interface BrandLogoAsset {
  readonly src: string
  readonly mode: 'color' | 'mono'
}

const BRAND_LOGOS: Readonly<Record<Exclude<ProviderBrandKey, 'custom'>, BrandLogoAsset>> = {
  deepseek: { src: deepseekColorSvg, mode: 'color' },
  google: { src: googleColorSvg, mode: 'color' },
  gemini: { src: geminiColorSvg, mode: 'color' },
  vertexai: { src: vertexaiColorSvg, mode: 'color' },
  openai: { src: openaiSvg, mode: 'mono' },
  anthropic: { src: anthropicSvg, mode: 'mono' },
  claude: { src: claudeColorSvg, mode: 'color' },
  zhipu: { src: zhipuColorSvg, mode: 'color' },
  zai: { src: zaiSvg, mode: 'mono' },
  qwen: { src: qwenColorSvg, mode: 'color' },
  moonshot: { src: moonshotSvg, mode: 'mono' },
  kimi: { src: kimiSvg, mode: 'mono' },
  minimax: { src: minimaxColorSvg, mode: 'color' },
  xai: { src: xaiSvg, mode: 'mono' },
  mistral: { src: mistralColorSvg, mode: 'color' },
  openrouter: { src: openrouterSvg, mode: 'mono' },
  ollama: { src: ollamaSvg, mode: 'mono' },
  volcengine: { src: volcengineColorSvg, mode: 'color' },
  azure: { src: azureColorSvg, mode: 'color' },
  bedrock: { src: bedrockColorSvg, mode: 'color' },
  cloudflare: { src: cloudflareColorSvg, mode: 'color' },
  fireworks: { src: fireworksColorSvg, mode: 'color' },
  githubcopilot: { src: githubCopilotSvg, mode: 'mono' },
  groq: { src: groqSvg, mode: 'mono' },
  huggingface: { src: huggingfaceColorSvg, mode: 'color' },
  meta: { src: metaColorSvg, mode: 'color' },
  nvidia: { src: nvidiaColorSvg, mode: 'color' },
  together: { src: togetherColorSvg, mode: 'color' },
  vercel: { src: vercelSvg, mode: 'mono' },
  cerebras: { src: cerebrasSvg, mode: 'mono' },
  baseten: { src: basetenSvg, mode: 'mono' },
  xiaomi: { src: xiaomiMimoSvg, mode: 'mono' },
  ling: { src: lingColorSvg, mode: 'color' },
  opencode: { src: opencodeSvg, mode: 'mono' },
  typesafe: { src: typesafeAiSvg, mode: 'mono' },
  siliconcloud: { src: siliconcloudColorSvg, mode: 'color' },
  perplexity: { src: perplexityColorSvg, mode: 'color' },
  cohere: { src: cohereColorSvg, mode: 'color' },
  stepfun: { src: stepfunColorSvg, mode: 'color' },
  baichuan: { src: baichuanColorSvg, mode: 'color' },
  hunyuan: { src: hunyuanColorSvg, mode: 'color' },
  spark: { src: sparkColorSvg, mode: 'color' },
  wenxin: { src: wenxinColorSvg, mode: 'color' },
  yi: { src: yiSvg, mode: 'mono' },
}

function buildMaskStyle(src: string): CSSProperties {
  // Data URI 在不同打包器下可能包含双引号，转义后可避免破坏 CSS url("...") 语法。
  const url = `url("${src.replaceAll('"', '%22')}")`
  return {
    maskImage: url,
    WebkitMaskImage: url,
  }
}

function resolveSizeClass(size: 'sm' | 'md' | 'lg'): string {
  if (size === 'lg') return 'models-provider-emblem models-provider-emblem--lg'
  if (size === 'sm') return 'models-provider-emblem models-provider-emblem--sm'
  return 'models-provider-emblem'
}

function resolveFallbackIconSize(size: 'sm' | 'md' | 'lg'): number {
  if (size === 'lg') return 21
  if (size === 'sm') return 14
  return 19
}

function renderBrandLogo(asset: BrandLogoAsset | null, size: 'sm' | 'md' | 'lg') {
  if (asset === null) {
    return <Cpu size={resolveFallbackIconSize(size)} strokeWidth={1.75} />
  }
  if (asset.mode === 'color') {
    return <img className="models-provider-emblem__img" src={asset.src} alt="" draggable={false} />
  }
  return <span className="models-provider-emblem__mask" style={buildMaskStyle(asset.src)} />
}

/** 根据提供商 ID、显示名与自定义端点域名渲染对应的官方品牌标志。 */
export function ProviderBrandIcon({
  providerId,
  displayName,
  baseURL,
  size = 'md',
}: ProviderBrandIconProps) {
  const brand = resolveProviderBrand(providerId, displayName, baseURL)
  const asset = brand.key === 'custom' ? null : BRAND_LOGOS[brand.key]

  return (
    <span
      className={resolveSizeClass(size)}
      data-brand={brand.key}
      data-brand-mode={asset?.mode ?? 'fallback'}
      aria-hidden="true"
    >
      {renderBrandLogo(asset, size)}
    </span>
  )
}
