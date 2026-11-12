// Turns an OrcaRouter failure into words a person can act on.
// Source: https://docs.orcarouter.ai/operations/errors
// Match on error.code first, then stable message prefixes, then the HTTP status.

export interface ApiErrorBody {
  message: string
  type: string
  code: string
  metadata: Record<string, unknown>
}

export interface FriendlyError {
  title: string
  detail: string
  // Seconds to wait before one automatic retry. Undefined means do not retry.
  retryAfter?: number
  // When true, the same request would fail again unchanged, so no retry button.
  final: boolean
  status: number
  code: string
  requestId: string
  upstreamMessage: string
}

const asRecord = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

const asString = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '')

// OrcaRouter's envelope is { error: { message, type, code, metadata } }.
// Gemini passthrough errors can use Google's { error: { message, status, code: 403 } } instead.
export function readErrorBody(raw: unknown): ApiErrorBody {
  const root = asRecord(raw)
  const err = asRecord(root.error ?? root)
  return {
    message: asString(err.message).slice(0, 1000),
    type: asString(err.type || err.status),
    code: typeof err.code === 'string' ? err.code : '',
    metadata: asRecord(err.metadata),
  }
}

const RETRY_FALLBACK_SECONDS = 8
const RETRY_CEILING_SECONDS = 60

function retryWait(meta: Record<string, unknown>): number | undefined {
  const seconds = Number(meta.retry_after_seconds)
  if (!Number.isFinite(seconds) || seconds <= 0) return RETRY_FALLBACK_SECONDS
  return seconds <= RETRY_CEILING_SECONDS ? Math.ceil(seconds) : undefined
}

export function explainHttpError(status: number, raw: unknown, requestId = ''): FriendlyError {
  const body = readErrorBody(raw)
  const msg = body.message
  const lower = msg.toLowerCase()
  const meta = body.metadata
  const base = { status, code: body.code, requestId, upstreamMessage: msg, final: true }
  const out = (title: string, detail: string, extra: Partial<FriendlyError> = {}): FriendlyError => ({
    ...base,
    title,
    detail,
    ...extra,
  })

  switch (body.code) {
    case 'insufficient_user_quota':
      return out('Out of credits', 'Your OrcaRouter workspace has no credit left. Top up in the OrcaRouter console, then try again.')
    case 'free_quota_exhausted':
      return out('Free calls used up', 'The free allowance for this model is gone. Add credits to keep generating.')
    case 'budget_exceeded':
      return out('Monthly budget reached', 'A workspace admin set a monthly budget for this member or agent and it is used up. Topping up does not lift it, an admin has to raise the budget.')
    case 'pre_consume_token_quota_failed':
      return out('This key hit its own quota', 'The key has a spending cap that is used up, even if the workspace still has credit. Raise the key\'s quota in the OrcaRouter console.')
    case 'model_not_found':
      return out('Model not available', 'This model is not available on your account right now. Try one of the other models.')
    case 'model_not_yet_available': {
      const alt = asString(meta.closest_live_alternative)
      const windowText = asString(meta.expected_window)
      return out('Model not live yet', `This model is announced but not serving yet${windowText ? ` (expected ${windowText})` : ''}.${alt ? ` The closest live model is ${alt}.` : ''}`)
    }
    case 'model_price_error':
      return out('Model pricing missing', 'OrcaRouter has no price set up for this model yet. Contact OrcaRouter support, or use another model.')
    case 'api_not_implemented':
      return out('Not supported for this model', 'OrcaRouter does not support this kind of request on this model. If you added reference images, try without them or switch models.')
    case 'bad_request_body':
      return out('Request could not be read', 'OrcaRouter could not parse the request. This is likely a bug in this app, please report it with the request id.')
    case 'prompt_blocked':
      return out('Prompt blocked', 'The provider\'s safety policy blocked this prompt before generating. Rephrase it and try again.')
    case 'sensitive_words_detected':
      return out('Prompt flagged', 'OrcaRouter\'s content filter rejected this prompt. Rephrase it and try again.')
    case 'guardrail_blocked':
      return out('Blocked by a workspace guardrail', 'A guardrail on your workspace blocked this request. The same prompt will be blocked again, so change it or ask an admin about the policy.')
    case 'free_rate_limited': {
      const reason = asString(meta.reason)
      if (reason === 'err_free_prompt_cap') {
        return out('Prompt too long for the free tier', 'Shorten the prompt. Retrying unchanged fails the same way.')
      }
      if (reason === 'err_free_access_denied') {
        return out('Free tier not unlocked', 'Link an established GitHub account in your OrcaRouter profile, or add credits.')
      }
      const wait = retryWait(meta)
      return out('Free tier is busy', 'The free rate window is full.', { final: false, retryAfter: wait })
    }
    case 'byok:key_unavailable':
      return out('Your provider key could not be used', 'OrcaRouter could not use your workspace\'s own provider key, and your settings forbid falling back to platform capacity. Check the BYOK key in the console.')
  }

  if (body.code.startsWith('violation_fee')) {
    return out('Content policy violation', 'The provider flagged this content. This is terminal and may carry a fee.')
  }

  if (status === 403) {
    if (lower.startsWith('token cycle spend limit reached')) {
      const reset = /resets at\s+(.+)$/i.exec(msg)?.[1]?.trim()
      return out('Key spend limit reached', `This key reached its recurring spend limit${reset ? `, it resets at ${reset}` : ''}. Topping up does not help, wait for the reset or raise the key's limit.`)
    }
    if (lower.includes('no access to model')) {
      return out('Key cannot use this model', 'This model is not on the key\'s allowed-model list. Add it in the OrcaRouter console, or use a different key.')
    }
    if (body.code === 'access_denied') {
      return out('Key not allowed here', 'The key is valid but this request is not permitted. The usual cause is an IP allowlist on the key, which a public network will not match.')
    }
    return out('Request refused', 'OrcaRouter refused this request with a 403.')
  }

  switch (status) {
    case 400:
      return out('Request rejected', 'OrcaRouter or the model rejected the settings. The message below says which part.')
    case 401:
      return out('API key rejected', 'OrcaRouter did not accept this key. Check that it is copied completely and still active in the console.')
    case 402:
      return out('Payment required', 'Your workspace is out of credits. Top up in the OrcaRouter console.')
    case 404:
      return out('Not found', 'OrcaRouter does not know this model or endpoint.')
    case 413:
      return out('Request too large', 'The reference images are too large together. Remove a few, or use smaller ones.')
    case 425:
      return out('Model not live yet', 'This model is announced but not serving yet.')
    case 429:
      return out('Rate limited', 'Too many requests at once.', { final: false, retryAfter: retryWait(meta) })
    case 500:
      return out('OrcaRouter error', 'Something failed on OrcaRouter\'s side. Try again in a moment.', { final: false })
    case 502:
      return out('Provider failed', 'Every upstream provider for this model failed. Try again in a moment.', { final: false })
    case 503:
      return out('Model temporarily unavailable', 'The model is unavailable upstream right now.', { final: false, retryAfter: RETRY_FALLBACK_SECONDS })
    case 504:
      return out('Provider timed out', 'The provider took too long to answer. Try again, or pick a lower quality or size.', { final: false })
  }
  return out(`Request failed (${status})`, 'OrcaRouter returned an unexpected status.', { final: status < 500 })
}

export function networkError(): FriendlyError {
  return {
    title: 'Could not reach OrcaRouter',
    detail: 'Check your connection. Some school, work and library networks block API sites.',
    final: false,
    status: 0,
    code: '',
    requestId: '',
    upstreamMessage: '',
  }
}

export function timeoutError(seconds: number): FriendlyError {
  return {
    title: 'Timed out',
    detail: `No answer after ${seconds} seconds. Higher quality and larger sizes take longer, try a lower setting.`,
    final: false,
    status: 0,
    code: '',
    requestId: '',
    upstreamMessage: '',
  }
}

export function plainError(title: string, detail: string, final = true, upstreamMessage = ''): FriendlyError {
  return { title, detail, final, status: 0, code: '', requestId: '', upstreamMessage }
}

// Gemini can answer 200 with no image: blocked prompt, safety stop, or text only.
export function explainGeminiNoImage(finishReason: string, blockReason: string, text: string): FriendlyError {
  if (blockReason) {
    return plainError('Prompt blocked by Gemini', `Gemini refused the prompt (${blockReason}). Rephrase it and try again.`, true, text)
  }
  switch (finishReason) {
    case 'IMAGE_SAFETY':
    case 'SAFETY':
    case 'PROHIBITED_CONTENT':
    case 'BLOCKLIST':
    case 'SPII':
      return plainError('Image blocked by Gemini', `Gemini's safety filter stopped the image (${finishReason}). Rephrase the prompt or change the references.`, true, text)
    case 'RECITATION':
    case 'IMAGE_RECITATION':
      return plainError('Too close to existing work', 'Gemini stopped because the result was too close to existing material. Make the prompt more original.', true, text)
    case 'MAX_TOKENS':
      return plainError('Ran out of room', 'Gemini hit its output limit before finishing the image. Try a smaller size.', false, text)
  }
  return plainError(
    'No image came back',
    text ? 'Gemini answered with text only. Its reply is below.' : `Gemini returned no image${finishReason ? ` (${finishReason})` : ''}. Try again, or make the prompt more explicit about drawing an image.`,
    false,
    text,
  )
}
