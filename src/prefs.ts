// Settings that are safe to keep between visits: no key, no prompt, no images.
// Storage can be blocked or wiped, so every read falls back to the defaults.

import {
  GEMINI_THINKING,
  GPT_BACKGROUNDS,
  GPT_MODERATION,
  GPT_QUALITIES,
  GPT_TIERS,
  MAX_BATCH,
  MODELS,
  type GeminiThinking,
  type GptBackground,
  type GptModeration,
  type GptQuality,
  type GptTier,
} from './models.ts'

const PREFS_KEY = 'orca-ig.prefs.v1'

export type GptSizeMode = GptTier | 'custom'

export interface Prefs {
  modelId: string
  customIds: Record<string, string>
  geminiRatio: string
  gptRatio: string
  geminiSize: string
  gptSizeMode: GptSizeMode
  gptCustom: string
  count: number
  gptQuality: GptQuality
  gptBackground: GptBackground
  gptModeration: GptModeration
  geminiThinking: GeminiThinking
  theme: 'dark' | 'light'
  motion: 'system' | 'reduce'
  idleMinutes: number
}

export const IDLE_CHOICES = [5, 15, 30, 60, 0] as const

export const DEFAULT_PREFS: Prefs = {
  modelId: MODELS[0]!.id,
  customIds: {},
  geminiRatio: '1:1',
  gptRatio: '1:1',
  geminiSize: '1K',
  gptSizeMode: '1K',
  gptCustom: '1536x1024',
  count: 1,
  gptQuality: 'auto',
  gptBackground: 'auto',
  gptModeration: 'auto',
  geminiThinking: 'minimal',
  theme: 'dark',
  motion: 'system',
  idleMinutes: 15,
}

const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback

const RATIO_RE = /^(auto|\d{1,2}:\d{1,2})$/

export function loadPrefs(): Prefs {
  let raw: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}')
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>
  } catch {
    // Missing or unreadable storage: defaults.
  }
  const d = DEFAULT_PREFS
  const customIds: Record<string, string> = {}
  if (raw.customIds && typeof raw.customIds === 'object') {
    for (const m of MODELS) {
      const v = (raw.customIds as Record<string, unknown>)[m.id]
      if (typeof v === 'string' && v.length <= 128) customIds[m.id] = v
    }
  }
  const count = Number(raw.count)
  const idle = Number(raw.idleMinutes)
  return {
    modelId: pick(raw.modelId, MODELS.map((m) => m.id), d.modelId),
    customIds,
    geminiRatio: typeof raw.geminiRatio === 'string' && RATIO_RE.test(raw.geminiRatio) ? raw.geminiRatio : d.geminiRatio,
    gptRatio: typeof raw.gptRatio === 'string' && RATIO_RE.test(raw.gptRatio) ? raw.gptRatio : d.gptRatio,
    geminiSize: pick(raw.geminiSize, ['512', '1K', '2K', '4K'], d.geminiSize),
    gptSizeMode: pick<GptSizeMode>(raw.gptSizeMode, [...GPT_TIERS, 'custom'], d.gptSizeMode),
    gptCustom: typeof raw.gptCustom === 'string' && raw.gptCustom.length <= 20 ? raw.gptCustom : d.gptCustom,
    count: Number.isInteger(count) && count >= 1 && count <= MAX_BATCH ? count : d.count,
    gptQuality: pick(raw.gptQuality, GPT_QUALITIES, d.gptQuality),
    gptBackground: pick(raw.gptBackground, GPT_BACKGROUNDS, d.gptBackground),
    gptModeration: pick(raw.gptModeration, GPT_MODERATION, d.gptModeration),
    geminiThinking: pick(raw.geminiThinking, GEMINI_THINKING, d.geminiThinking),
    theme: pick(raw.theme, ['dark', 'light'], d.theme),
    motion: pick(raw.motion, ['system', 'reduce'], d.motion),
    idleMinutes: (IDLE_CHOICES as readonly number[]).includes(idle) ? idle : d.idleMinutes,
  }
}

export function savePrefs(p: Prefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p))
  } catch {
    // Storage blocked: settings last for this visit only.
  }
}
