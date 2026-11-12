// Calls to OrcaRouter.
// GPT Image 2.5: POST /v1/images/generations (JSON), or /v1/images/edits
//   (multipart) when reference images are attached. One request returns n images.
// Gemini 3.1 Flash Image: POST /v1beta/models/{model}:generateContent, Google's
//   native shape. It returns one image per request, so a batch is parallel requests.

import {
  explainGeminiNoImage,
  explainHttpError,
  networkError,
  plainError,
  timeoutError,
  type FriendlyError,
} from './errors.ts'
import { base64ToImage, blobToBase64, extensionFor, type OutFormat, type RefImage } from './images.ts'
import { readKey } from './keyvault.ts'
import {
  ratioLabel,
  sizeLabel,
  type GeminiThinking,
  type GptBackground,
  type GptModeration,
  type GptQuality,
  type Ratio,
  type Size,
} from './models.ts'

export const API_ORIGIN = 'https://api.orcarouter.ai'
const TIMEOUT_SECONDS = 360
const MAX_PROMPT = 32_000

export interface GeminiParams {
  modelId: string
  prompt: string
  refs: readonly RefImage[]
  ratio: Ratio | null
  size: string
  thinking: GeminiThinking
}

export interface GptParams {
  modelId: string
  prompt: string
  refs: readonly RefImage[]
  count: number
  size: Size | 'auto'
  quality: GptQuality
  background: GptBackground
  moderation: GptModeration
}

export interface OutImage {
  blob: Blob | null
  // Read from the bytes. Anything but png means the provider ignored the PNG request.
  format: OutFormat
  // Set only when the provider answered with a link instead of bytes.
  remoteUrl: string
  revisedPrompt: string
}

export type Outcome =
  | { ok: true; images: OutImage[]; text: string; costUsd: number | null; requestId: string; creditsLow: boolean }
  | { ok: false; error: FriendlyError }

const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/

export function checkModelId(id: string): string {
  if (!MODEL_ID_RE.test(id) || id.includes('..') || id.includes('//')) {
    return 'Use letters, digits, dots, dashes, underscores and slashes only.'
  }
  return ''
}

class NoKeyError extends Error {}

function headers(json: boolean): Headers {
  const key = readKey()
  if (!key) throw new NoKeyError()
  const h = new Headers()
  h.set('Authorization', `Bearer ${key}`)
  h.set('X-OrcaRouter-Include-Cost', 'true')
  if (json) h.set('Content-Type', 'application/json')
  return h
}

export interface RawResponse {
  status: number
  body: unknown
  requestId: string
  creditsLow: boolean
}

// One fetch with a timeout, joined to the caller's cancel signal.
async function post(url: string, body: BodyInit, json: boolean, signal: AbortSignal): Promise<RawResponse | FriendlyError> {
  let reqHeaders: Headers
  try {
    reqHeaders = headers(json)
  } catch (e) {
    if (e instanceof NoKeyError) return plainError('No API key', 'The key was locked or cleared. Enter it again to continue.')
    throw e
  }

  const controller = new AbortController()
  let timedOut = false
  const timer = window.setTimeout(() => {
    timedOut = true
    controller.abort()
  }, TIMEOUT_SECONDS * 1000)
  const onCancel = (): void => controller.abort()
  if (signal.aborted) controller.abort()
  else signal.addEventListener('abort', onCancel, { once: true })

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: reqHeaders,
      body,
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
    })
    const text = await res.text()
    let parsed: unknown = null
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {
      parsed = { error: { message: text.slice(0, 300) } }
    }
    return {
      status: res.status,
      body: parsed,
      requestId: res.headers.get('X-Orca-Request-Id') ?? '',
      creditsLow: (res.headers.get('X-Credits-Low') ?? '').toLowerCase() === 'true',
    }
  } catch {
    if (signal.aborted) return plainError('Canceled', 'You stopped this request.', false)
    if (timedOut) return timeoutError(TIMEOUT_SECONDS)
    return networkError()
  } finally {
    window.clearTimeout(timer)
    signal.removeEventListener('abort', onCancel)
  }
}

const isFriendly = (v: RawResponse | FriendlyError): v is FriendlyError => 'title' in v

const rec = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

// ---- Gemini ----

// A Gemini batch is several requests carrying the same references, so each
// file is encoded once and the text reused. Keyed by the Blob, so it is freed
// with it.
const encoded = new WeakMap<Blob, Promise<string>>()
function encodeOnce(blob: Blob): Promise<string> {
  let p = encoded.get(blob)
  if (!p) {
    p = blobToBase64(blob)
    encoded.set(blob, p)
  }
  return p
}

export async function runGemini(p: GeminiParams, signal: AbortSignal): Promise<Outcome> {
  const parts: unknown[] = []
  for (const ref of p.refs) {
    parts.push({ inlineData: { mimeType: ref.blob.type || 'image/png', data: await encodeOnce(ref.blob) } })
  }
  parts.push({ text: p.prompt.slice(0, MAX_PROMPT) })

  const imageConfig: Record<string, string> = { imageSize: p.size }
  if (p.ratio) imageConfig.aspectRatio = ratioLabel(p.ratio)
  const generationConfig: Record<string, unknown> = { responseModalities: ['TEXT', 'IMAGE'], imageConfig }
  // Minimal is the model's default, so the field is only sent for High.
  if (p.thinking === 'high') generationConfig.thinkingConfig = { thinkingLevel: 'HIGH', includeThoughts: false }

  const body = JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig })
  const path = p.modelId.split('/').map(encodeURIComponent).join('/')
  const res = await post(`${API_ORIGIN}/v1beta/models/${path}:generateContent`, body, true, signal)
  if (isFriendly(res)) return { ok: false, error: res }
  if (res.status < 200 || res.status >= 300) return { ok: false, error: explainHttpError(res.status, res.body, res.requestId) }
  return parseGemini(res)
}

export function parseGemini(res: RawResponse): Outcome {
  const root = rec(res.body)
  const candidate = rec(arr(root.candidates)[0])
  const content = rec(candidate.content)
  const texts: string[] = []
  let image: OutImage | null = null
  for (const raw of arr(content.parts)) {
    const part = rec(raw)
    // Thinking can emit draft images and notes. Only the final answer counts.
    if (part.thought === true) continue
    const inline = rec(part.inlineData ?? part.inline_data)
    const data = str(inline.data)
    if (data) {
      const decoded = base64ToImage(data)
      if (decoded) image = { blob: decoded.blob, format: decoded.format, remoteUrl: '', revisedPrompt: '' }
    }
    const text = str(part.text).trim()
    if (text) texts.push(text)
  }
  const text = texts.join('\n\n').slice(0, 4000)
  if (!image) {
    const error = explainGeminiNoImage(str(candidate.finishReason), str(rec(root.promptFeedback).blockReason), text)
    error.requestId = res.requestId
    return { ok: false, error }
  }
  const costUsd = num(rec(root.usageMetadata).costUsd)
  return { ok: true, images: [image], text, costUsd, requestId: res.requestId, creditsLow: res.creditsLow }
}

// ---- GPT Image ----

function gptFields(p: GptParams, edit: boolean): Array<[string, string]> {
  const fields: Array<[string, string]> = [
    ['model', p.modelId],
    ['prompt', p.prompt.slice(0, MAX_PROMPT)],
    ['n', String(p.count)],
  ]
  // Defaults are left out so a model that lacks a parameter does not reject the call.
  if (p.size !== 'auto') fields.push(['size', sizeLabel(p.size)])
  if (p.quality !== 'auto') fields.push(['quality', p.quality])
  if (p.background !== 'auto') fields.push(['background', p.background])
  // PNG is lossless. It is asked for explicitly on every call, and whatever
  // format actually comes back is reported per image.
  fields.push(['output_format', 'png'])
  // The edits endpoint has no moderation parameter.
  if (!edit && p.moderation !== 'auto') fields.push(['moderation', p.moderation])
  return fields
}

export async function runGpt(p: GptParams, signal: AbortSignal): Promise<Outcome> {
  const edit = p.refs.length > 0
  const fields = gptFields(p, edit)
  let res: RawResponse | FriendlyError
  if (!edit) {
    const json: Record<string, string | number> = {}
    for (const [k, v] of fields) json[k] = k === 'n' ? Number(v) : v
    res = await post(`${API_ORIGIN}/v1/images/generations`, JSON.stringify(json), true, signal)
  } else {
    const form = new FormData()
    for (const [k, v] of fields) form.append(k, v)
    const field = p.refs.length === 1 ? 'image' : 'image[]'
    p.refs.forEach((ref, i) => {
      const type = ref.blob.type || 'image/png'
      form.append(field, ref.blob, `reference-${i + 1}.${extensionFor(type)}`)
    })
    res = await post(`${API_ORIGIN}/v1/images/edits`, form, false, signal)
  }
  if (isFriendly(res)) return { ok: false, error: res }
  if (res.status < 200 || res.status >= 300) return { ok: false, error: explainHttpError(res.status, res.body, res.requestId) }
  return parseGpt(res)
}

export function parseGpt(res: RawResponse): Outcome {
  const root = rec(res.body)
  const images: OutImage[] = []
  for (const raw of arr(root.data)) {
    const item = rec(raw)
    const revisedPrompt = str(item.revised_prompt).slice(0, 4000)
    const b64 = str(item.b64_json)
    if (b64) {
      const decoded = base64ToImage(b64)
      if (decoded) images.push({ blob: decoded.blob, format: decoded.format, remoteUrl: '', revisedPrompt })
      continue
    }
    const url = str(item.url)
    if (url.startsWith('https://')) images.push({ blob: null, format: 'unknown', remoteUrl: url, revisedPrompt })
  }
  if (images.length === 0) {
    const error = plainError('No image came back', 'OrcaRouter answered without any image data. Try again.', false)
    error.requestId = res.requestId
    return { ok: false, error }
  }
  const costUsd = num(rec(root.usage).cost_usd)
  return { ok: true, images, text: '', costUsd, requestId: res.requestId, creditsLow: res.creditsLow }
}

// ---- retry ----

// Runs a request, and retries once when OrcaRouter says it is busy (429, 503).
// onWait is called every second of the wait with the seconds left.
export async function withRetry(
  run: () => Promise<Outcome>,
  signal: AbortSignal,
  onWait: (secondsLeft: number) => void,
): Promise<Outcome> {
  const first = await run()
  if (first.ok || first.error.retryAfter === undefined || signal.aborted) return first
  let left = first.error.retryAfter
  const tick = (): Promise<boolean> =>
    new Promise((resolve) => {
      const onAbort = (): void => {
        window.clearTimeout(t)
        resolve(true)
      }
      const t = window.setTimeout(() => {
        signal.removeEventListener('abort', onAbort)
        resolve(false)
      }, 1000)
      signal.addEventListener('abort', onAbort, { once: true })
    })
  while (left > 0) {
    onWait(left)
    if (await tick()) return { ok: false, error: plainError('Canceled', 'You stopped this request.', false) }
    left--
  }
  onWait(0)
  return run()
}
