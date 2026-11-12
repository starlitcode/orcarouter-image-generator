import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseGemini, parseGpt, checkModelId, type RawResponse } from '../../src/api.ts'
import { explainHttpError, readErrorBody } from '../../src/errors.ts'
import { sniffFormat, base64ToImage } from '../../src/images.ts'
import { checkKey } from '../../src/keyvault.ts'
import { GEMINI_RATIOS, GPT_RATIOS, GPT_TIERS, gptSizeErrors, gptSizeFor, parseSize } from '../../src/models.ts'

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const JPEG_HEAD = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]).toString('base64')
const raw = (body: unknown, status = 200): RawResponse => ({ status, body, requestId: 'req-1', creditsLow: false })

test('GPT size rules match the documented limits', () => {
  assert.deepEqual(gptSizeErrors({ width: 1024, height: 1024 }), [])
  assert.deepEqual(gptSizeErrors({ width: 3840, height: 2160 }), [])
  assert.deepEqual(gptSizeErrors({ width: 3072, height: 1024 }), [])
  assert.match(gptSizeErrors({ width: 1080, height: 1920 })[0]!, /multiples of 16/)
  assert.match(gptSizeErrors({ width: 512, height: 512 }).join(), /Too small/)
  assert.match(gptSizeErrors({ width: 4096, height: 2160 }).join(), /3840/)
  assert.match(gptSizeErrors({ width: 3840, height: 1024 }).join(), /3 times/)
})

test('every GPT ratio and tier gives a valid size', () => {
  for (const r of GPT_RATIOS) {
    for (const t of GPT_TIERS) {
      const s = gptSizeFor(r, t)
      assert.deepEqual(gptSizeErrors(s), [], `${r.w}:${r.h} ${t} -> ${s.width}x${s.height}`)
      assert.ok(Math.abs(s.width / s.height - r.w / r.h) < 0.01, `${r.w}:${r.h} ${t} ratio drift`)
    }
  }
  assert.deepEqual(gptSizeFor({ w: 3, h: 2 }, '1K'), { width: 1536, height: 1024 })
  assert.deepEqual(gptSizeFor({ w: 16, h: 9 }, '4K'), { width: 3840, height: 2160 })
})

test('Gemini ratios include the 3.1 Flash extremes', () => {
  const labels = GEMINI_RATIOS.map((r) => `${r.w}:${r.h}`)
  for (const l of ['1:8', '8:1', '1:4', '4:1', '21:9']) assert.ok(labels.includes(l), l)
})

test('custom size parsing', () => {
  assert.deepEqual(parseSize(' 1536 x 1024 '), { width: 1536, height: 1024 })
  assert.deepEqual(parseSize('2048×1152'), { width: 2048, height: 1152 })
  assert.equal(parseSize('big'), null)
})

test('pasted keys are trimmed, and broken ones refused', () => {
  assert.equal(checkKey('  sk-orca-abc123\n').key, 'sk-orca-abc123')
  assert.equal(checkKey('sk-orca-abc 123').ok, false)
  assert.equal(checkKey('sk-orca-ab​c').ok, false)
  assert.equal(checkKey('').ok, false)
  const other = checkKey('sk-or-v1-abc')
  assert.equal(other.ok, true)
  assert.match(other.warning, /sk-orca-/)
})

test('model ids that could break the URL path are refused', () => {
  assert.equal(checkModelId('google/gemini-3.1-flash-image-preview'), '')
  assert.equal(checkModelId('gpt-image-2.5-flare'), '')
  assert.notEqual(checkModelId('../v1/secrets'), '')
  assert.notEqual(checkModelId('a:generateContent?x=1'), '')
  assert.notEqual(checkModelId('a//b'), '')
})

test('OrcaRouter error codes become actionable messages', () => {
  const e = (status: number, error: object) => explainHttpError(status, { error }, 'rid')
  assert.equal(e(402, { code: 'insufficient_user_quota', message: 'x' }).title, 'Out of credits')
  assert.equal(e(403, { code: 'budget_exceeded', message: 'monthly budget reached for this member' }).title, 'Monthly budget reached')
  assert.equal(e(403, { code: 'pre_consume_token_quota_failed', message: 'token quota is not enough' }).title, 'This key hit its own quota')
  assert.equal(e(403, { code: '', message: 'This token has no access to model gpt-image-2.5-flare' }).title, 'Key cannot use this model')
  assert.equal(e(403, { code: 'access_denied', message: 'ip not allowed' }).title, 'Key not allowed here')
  const spend = e(403, { code: 'access_denied', message: 'token cycle spend limit reached, resets at 2026-11-13T00:00:00Z' })
  assert.equal(spend.title, 'Key spend limit reached')
  assert.match(spend.detail, /2026-11-13T00:00:00Z/)
  const nya = e(425, { code: 'model_not_yet_available', metadata: { closest_live_alternative: 'openai/gpt-image-2' } })
  assert.match(nya.detail, /openai\/gpt-image-2/)
  assert.equal(e(400, { code: 'guardrail_blocked' }).final, true)
  assert.equal(e(401, { message: 'Invalid API key' }).title, 'API key rejected')
  assert.equal(e(429, { message: 'slow' }).retryAfter, 8)
  assert.equal(e(429, { code: 'free_rate_limited', metadata: { reason: 'err_free_rate', retry_after_seconds: 3 } }).retryAfter, 3)
  assert.equal(e(429, { code: 'free_rate_limited', metadata: { reason: 'err_free_rate', retry_after_seconds: 3600 } }).retryAfter, undefined)
  assert.equal(e(400, { code: 'free_rate_limited', metadata: { reason: 'err_free_prompt_cap' } }).final, true)
  assert.equal(e(503, { code: 'byok:key_unavailable' }).title, 'Your provider key could not be used')
  assert.equal(e(503, { message: 'down' }).retryAfter, 8)
  assert.equal(e(502, {}).retryAfter, undefined)
})

test('error bodies of any shape are read safely', () => {
  assert.equal(readErrorBody(null).message, '')
  assert.equal(readErrorBody('oops').message, '')
  assert.equal(readErrorBody({ error: { message: 'Denied', status: 'PERMISSION_DENIED', code: 403 } }).type, 'PERMISSION_DENIED')
})

test('image format is read from the bytes, not the label', () => {
  assert.equal(sniffFormat(Buffer.from(PNG_1PX, 'base64')), 'png')
  assert.equal(sniffFormat(Buffer.from(JPEG_HEAD, 'base64')), 'jpeg')
  assert.equal(sniffFormat(Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1')), 'webp')
  assert.equal(sniffFormat(Buffer.from('hello')), 'unknown')
  assert.equal(base64ToImage('not base64!!'), null)
})

test('Gemini: final image kept, thought images skipped, label ignored', async () => {
  const out = parseGemini(raw({
    candidates: [{ content: { parts: [
      { thought: true, inlineData: { mimeType: 'image/png', data: JPEG_HEAD } },
      { text: 'Done.' },
      { inline_data: { mime_type: 'image/png', data: JPEG_HEAD } },
    ] } }],
    usageMetadata: { costUsd: '0.151' },
  }))
  assert.ok(out.ok)
  if (!out.ok) return
  assert.equal(out.images.length, 1)
  assert.equal(out.images[0]!.format, 'jpeg', 'declared PNG but bytes are JPEG')
  assert.equal(out.text, 'Done.')
  assert.equal(out.costUsd, 0.151)
  const bytes = Buffer.from(await out.images[0]!.blob!.arrayBuffer())
  assert.ok(bytes.equals(Buffer.from(JPEG_HEAD, 'base64')), 'bytes untouched')
})

test('Gemini: no image explains the finish reason', () => {
  const blocked = parseGemini(raw({ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }))
  assert.ok(!blocked.ok && blocked.error.title === 'Prompt blocked by Gemini')
  const safety = parseGemini(raw({ candidates: [{ content: { parts: [] }, finishReason: 'IMAGE_SAFETY' }] }))
  assert.ok(!safety.ok && safety.error.title === 'Image blocked by Gemini')
  const textOnly = parseGemini(raw({ candidates: [{ content: { parts: [{ text: 'I cannot draw that.' }] }, finishReason: 'STOP' }] }))
  assert.ok(!textOnly.ok && textOnly.error.upstreamMessage === 'I cannot draw that.')
})

test('GPT: b64 images parsed with their real format, http links refused', () => {
  const out = parseGpt(raw({ data: [{ b64_json: PNG_1PX }, { b64_json: JPEG_HEAD }, { url: 'http://insecure.example/x.png' }], usage: { cost_usd: 0.08 } }))
  assert.ok(out.ok)
  if (!out.ok) return
  assert.deepEqual(out.images.map((i) => i.format), ['png', 'jpeg'])
  assert.equal(out.costUsd, 0.08)
  const empty = parseGpt(raw({ data: [] }))
  assert.ok(!empty.ok)
})
