// Model capabilities. Limits come from each model's own documentation:
// Gemini 3.1 Flash Image: Google's image-generation guide and the Vertex model card.
// GPT Image 2.5: OpenAI's size rules as summarized by OrcaRouter's launch post.
// Identifiers are the ones OrcaRouter lists at GET /v1/models.

export const MAX_BATCH = 4

export type Family = 'gemini' | 'gpt'

export interface Ratio {
  w: number
  h: number
}

export const ratioLabel = (r: Ratio): string => `${r.w}:${r.h}`

export interface GeminiModel {
  family: 'gemini'
  id: string
  name: string
  maker: string
  note: string
  maxRefs: number
  ratios: readonly Ratio[]
  sizes: readonly string[]
  defaultSize: string
}

export interface GptModel {
  family: 'gpt'
  id: string
  name: string
  maker: string
  note: string
  maxRefs: number
  ratios: readonly Ratio[]
}

export type Model = GeminiModel | GptModel

const r = (w: number, h: number): Ratio => ({ w, h })

export const GEMINI_RATIOS: readonly Ratio[] = [
  r(1, 1), r(4, 5), r(5, 4), r(3, 4), r(4, 3), r(2, 3), r(3, 2),
  r(9, 16), r(16, 9), r(21, 9), r(1, 4), r(4, 1), r(1, 8), r(8, 1),
]

// GPT Image 2.5 accepts any ratio up to 3:1, these are the common ones.
export const GPT_RATIOS: readonly Ratio[] = [
  r(1, 1), r(4, 5), r(5, 4), r(3, 4), r(4, 3), r(2, 3), r(3, 2),
  r(9, 16), r(16, 9), r(9, 21), r(21, 9), r(1, 3), r(3, 1),
]

export const MODELS: readonly Model[] = [
  {
    family: 'gemini',
    id: 'google/gemini-3.1-flash-image-preview',
    name: 'Nano Banana 2',
    maker: 'Gemini 3.1 Flash Image',
    note: 'Fast, strong at text in images and mixing many references.',
    maxRefs: 14,
    ratios: GEMINI_RATIOS,
    // Google requires the uppercase K. "512" is the 0.5K tier, written without a unit.
    sizes: ['512', '1K', '2K', '4K'],
    defaultSize: '1K',
  },
  {
    family: 'gpt',
    id: 'gpt-image-2.5-flare',
    name: 'GPT Image 2.5 Flare',
    maker: 'OpenAI',
    note: 'The fast default for everyday generation.',
    maxRefs: 16,
    ratios: GPT_RATIOS,
  },
  {
    family: 'gpt',
    id: 'gpt-image-2.5-sunburst',
    name: 'GPT Image 2.5 Sunburst',
    maker: 'OpenAI',
    note: 'Slower and more precise, best when editing references.',
    maxRefs: 16,
    ratios: GPT_RATIOS,
  },
]

export const modelById = (id: string): Model | undefined => MODELS.find((m) => m.id === id)

export const GPT_QUALITIES = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type GptQuality = (typeof GPT_QUALITIES)[number]

export const GPT_BACKGROUNDS = ['auto', 'opaque', 'transparent'] as const
export type GptBackground = (typeof GPT_BACKGROUNDS)[number]

export const GPT_MODERATION = ['auto', 'low'] as const
export type GptModeration = (typeof GPT_MODERATION)[number]

export const GEMINI_THINKING = ['minimal', 'high'] as const
export type GeminiThinking = (typeof GEMINI_THINKING)[number]

// GPT Image 2.5 size rules.
export const GPT_LIMITS = {
  step: 16,
  maxEdge: 3840,
  maxRatio: 3,
  minPixels: 655_360,
  maxPixels: 8_294_400,
  // OpenAI labels anything above 2560x1440 as experimental.
  experimentalPixels: 2560 * 1440,
} as const

export const GPT_TIERS = ['1K', '2K', '4K'] as const
export type GptTier = (typeof GPT_TIERS)[number]

export interface Size {
  width: number
  height: number
}

export function gptSizeErrors(size: Size): string[] {
  const { width, height } = size
  const errors: string[] = []
  const L = GPT_LIMITS
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    return ['Width and height must be whole numbers above zero.']
  }
  if (width % L.step !== 0 || height % L.step !== 0) {
    errors.push(`Both sides must be multiples of ${L.step}.`)
  }
  if (Math.max(width, height) > L.maxEdge) {
    errors.push(`Neither side can be longer than ${L.maxEdge}px.`)
  }
  if (Math.max(width, height) > L.maxRatio * Math.min(width, height)) {
    errors.push(`The long side can be at most ${L.maxRatio} times the short side.`)
  }
  const pixels = width * height
  if (pixels < L.minPixels) {
    errors.push(`Too small: needs at least ${L.minPixels.toLocaleString('en-US')} pixels in total.`)
  } else if (pixels > L.maxPixels) {
    errors.push(`Too large: at most ${L.maxPixels.toLocaleString('en-US')} pixels in total.`)
  }
  return errors
}

const floorTo = (value: number, step: number): number => Math.floor(value / step) * step

// Picks a valid GPT size for a ratio and tier. 1K and 2K set the short side,
// 4K takes the largest area the limits allow. Sides go to the nearest multiple
// of 16, which keeps the ratio closest, and down instead when nearest would
// break a limit. Either way the result can be a few pixels off the exact ratio.
export function gptSizeFor(ratio: Ratio, tier: GptTier): Size {
  const L = GPT_LIMITS
  const k = ratio.w / ratio.h
  const wide = k >= 1
  const longOverShort = wide ? k : 1 / k

  let short: number
  if (tier === '4K') short = Math.sqrt(L.maxPixels / longOverShort)
  else short = tier === '1K' ? 1024 : 2048

  let long = short * longOverShort
  if (long > L.maxEdge) {
    long = L.maxEdge
    short = long / longOverShort
  }
  if (long * short > L.maxPixels) {
    const scale = Math.sqrt(L.maxPixels / (long * short))
    long *= scale
    short *= scale
  }
  const orient = (l: number, s: number): Size => (wide ? { width: l, height: s } : { width: s, height: l })
  const nearest = orient(Math.round(long / L.step) * L.step, Math.round(short / L.step) * L.step)
  if (gptSizeErrors(nearest).length === 0) return nearest
  return orient(floorTo(long, L.step), floorTo(short, L.step))
}

export function parseSize(text: string): Size | null {
  const match = /^\s*(\d{2,5})\s*[x×*,]\s*(\d{2,5})\s*$/i.exec(text)
  if (!match) return null
  return { width: Number(match[1]), height: Number(match[2]) }
}

export const sizeLabel = (s: Size): string => `${s.width}x${s.height}`
