// End-to-end check of the production build, with OrcaRouter mocked.
// Run: npm run build && node tests/e2e/run.mjs
// The build carries the real Content-Security-Policy, so these runs also prove
// nothing the app needs is blocked by it.

import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

// Playwright is preinstalled globally here, so it is loaded through require,
// which finds global installs; an ESM import does not.
const { chromium, devices } = createRequire(import.meta.url)('playwright')

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, 'out')
mkdirSync(out, { recursive: true })
const PORT = 4179
const BASE = `http://localhost:${PORT}/`
const KEY = 'sk-orca-test-0123456789'

let failures = 0
const check = (cond, label) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}`)
  if (!cond) failures++
}

const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(PORT), '--strictPort'], { cwd: join(here, '../..'), stdio: 'pipe' })
// The server is a child process, so stop it on every way out, including a crash.
process.on('exit', () => server.kill())
process.on('uncaughtException', (e) => {
  console.error(e)
  process.exit(1)
})
process.on('unhandledRejection', (e) => {
  console.error(e)
  process.exit(1)
})
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('preview server did not start')), 20000)
  server.stdout.on('data', (d) => {
    if (String(d).includes(String(PORT))) {
      clearTimeout(t)
      resolve()
    }
  })
})

const browser = await chromium.launch()

// Small real images, made by the browser, used as fake API output and as uploads.
async function makeImages() {
  const page = await browser.newPage()
  const imgs = await page.evaluate(() => {
    const make = (w, h, type) => {
      const c = document.createElement('canvas')
      c.width = w
      c.height = h
      const g = c.getContext('2d')
      const grad = g.createLinearGradient(0, 0, w, h)
      grad.addColorStop(0, '#2a0b4d')
      grad.addColorStop(1, '#c58bff')
      g.fillStyle = grad
      g.fillRect(0, 0, w, h)
      return c.toDataURL(type).split(',')[1]
    }
    return { png: make(160, 90, 'image/png'), square: make(120, 120, 'image/png'), jpeg: make(160, 90, 'image/jpeg'), big: make(3000, 1500, 'image/png') }
  })
  await page.close()
  return imgs
}
const IMG = await makeImages()

function mock(page, behavior) {
  const log = []
  page.on('request', (r) => {
    if (r.url().startsWith('https://api.orcarouter.ai/')) log.push({ url: r.url(), method: r.method(), headers: r.headers(), body: r.postDataBuffer() })
  })
  page.route('https://api.orcarouter.ai/**', async (route) => {
    const req = route.request()
    const url = req.url()
    const cors = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'X-Orca-Request-Id,X-Credits-Low', 'x-orca-request-id': `req-${log.length}` }
    const res = await behavior({ url, body: req.postDataBuffer(), n: log.length })
    if (res.delay) await new Promise((r) => setTimeout(r, res.delay))
    try {
      await route.fulfill({ status: res.status ?? 200, headers: { ...cors, ...(res.headers ?? {}) }, contentType: 'application/json', body: JSON.stringify(res.json) })
    } catch {
      // The page aborted the request.
    }
  })
  return log
}

const geminiOk = (b64 = IMG.png) => ({
  json: { candidates: [{ content: { parts: [{ text: 'Here you go.' }, { inlineData: { mimeType: 'image/png', data: b64 } }] }, finishReason: 'STOP' }], usageMetadata: { costUsd: 0.151 } },
})
const gptOk = (n, b64 = IMG.png) => ({ json: { data: Array.from({ length: n }, () => ({ b64_json: b64 })), usage: { cost_usd: 0.04 } } })

async function newPage(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1, acceptDownloads: true, ...opts })
  const page = await ctx.newPage()
  const errors = []
  page.on('console', (m) => {
    // Chrome logs every non-2xx response itself. The mocked failures are on purpose.
    if (m.type() === 'error' && !m.text().startsWith('Failed to load resource: the server responded with a status of')) errors.push(m.text())
  })
  page.on('pageerror', (e) => errors.push(String(e)))
  return { ctx, page, errors }
}

async function enterKey(page, raw = `  ${KEY}  `) {
  await page.locator('#api-key').fill(raw)
  await page.getByRole('button', { name: 'Use key' }).click()
  await page.locator('#key-dialog').waitFor({ state: 'hidden' })
}

// ---------- 1. Gemini, key entry, key hygiene ----------
{
  const { ctx, page, errors } = await newPage()
  let geminiBodies = []
  const log = mock(page, ({ url, body }) => {
    if (url.includes(':generateContent')) {
      geminiBodies.push(JSON.parse(body.toString()))
      return geminiOk()
    }
    return { status: 404, json: { error: { message: 'nope' } } }
  })
  await page.goto(BASE)
  check(await page.locator('meta[http-equiv="Content-Security-Policy"]').count() === 1, 'build carries a CSP meta tag')
  check((await page.locator('html').getAttribute('data-theme')) === 'dark', 'dark theme by default')

  // aria-disabled keeps the button pressable, so pressing it explains what is missing.
  await page.locator('#generate').click({ force: true })
  check((await page.locator('#status-line').textContent()).includes('Write a prompt'), 'empty prompt is explained, not sent')

  await page.locator('#prompt').fill('A lighthouse in violet fog')
  await page.locator('.seg', { hasText: /^2$/ }).click()
  await page.getByRole('radio', { name: 'Aspect ratio 16:9' }).click()
  await page.locator('#generate').click()
  check(await page.locator('#key-dialog').isVisible(), 'generating without a key opens the key dialog')
  const keyAttrs = await page.locator('#api-key').evaluate((el) => ({ type: el.type, ac: el.getAttribute('autocomplete'), inForm: !!el.closest('form') }))
  check(keyAttrs.type === 'password' && keyAttrs.ac === 'off' && !keyAttrs.inForm, 'key field is a masked, non-form field with autocomplete off')
  await enterKey(page)
  await page.locator('.tile-frame.done').nth(1).waitFor()
  check(log.length === 2, 'Gemini batch of 2 sends 2 requests')
  check(log[0].headers.authorization === `Bearer ${KEY}`, 'pasted key is trimmed before use')
  check(log[0].headers['x-orcarouter-include-cost'] === 'true', 'cost reporting header sent')
  check(log[0].url === 'https://api.orcarouter.ai/v1beta/models/google/gemini-3.1-flash-image-preview:generateContent', 'Gemini native endpoint and model id')
  const gc = geminiBodies[0].generationConfig
  check(gc.imageConfig.aspectRatio === '16:9' && gc.imageConfig.imageSize === '1K', 'aspect ratio and size sent in imageConfig')
  check(!('thinkingConfig' in gc), 'thinking omitted at its default')
  check(geminiBodies[0].contents[0].parts.at(-1).text === 'A lighthouse in violet fog', 'prompt sent as the last part')
  check((await page.locator('.fmt').first().textContent()) === 'PNG', 'PNG result is labeled PNG')
  check((await page.locator('.batch-time').textContent()).includes('$0.302'), 'costs from both requests are summed')

  const leaks = await page.evaluate((key) => {
    const where = []
    const ls = JSON.stringify({ ...localStorage })
    const ss = JSON.stringify({ ...sessionStorage })
    if (ls.includes(key)) where.push('localStorage')
    if (ss.includes(key)) where.push('sessionStorage')
    if (document.cookie.includes(key)) where.push('cookie')
    if (document.documentElement.outerHTML.includes(key)) where.push('DOM')
    for (const i of document.querySelectorAll('input')) if (i.value.includes(key)) where.push(`input#${i.id}`)
    if (location.href.includes(key)) where.push('URL')
    return where
  }, KEY)
  check(leaks.length === 0, `key is not in storage, cookies, DOM, inputs or URL ${leaks.join(',')}`)

  // pagehide wipes the key (back-forward cache on a shared computer).
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })))
  check((await page.locator('#key-pill').textContent()).includes('Add API key'), 'pagehide wipes the key')

  await page.screenshot({ path: join(out, 'desktop-dark.png') })
  check(errors.length === 0, `no console errors (${errors.join(' | ')})`)
  await ctx.close()
}

// ---------- 2. GPT: sizes, n, references, non-PNG output kept as sent ----------
{
  const { ctx, page, errors } = await newPage()
  const bodies = []
  mock(page, ({ url, body }) => {
    if (url.endsWith('/v1/images/generations')) {
      const j = JSON.parse(body.toString())
      bodies.push({ kind: 'gen', j })
      return gptOk(j.n)
    }
    if (url.endsWith('/v1/images/edits')) {
      const text = body.toString('latin1')
      bodies.push({ kind: 'edit', text })
      const n = Number(/name="n"\r\n\r\n(\d+)/.exec(text)?.[1] ?? 1)
      return gptOk(n, IMG.jpeg)
    }
    return { status: 404, json: {} }
  })
  await page.goto(BASE)
  await page.getByRole('radio', { name: /GPT Image 2.5 Flare/ }).click()
  await page.getByRole('radio', { name: 'Aspect ratio 16:9' }).click()
  check((await page.locator('.size-readout').textContent()).includes('1824x1024'), '16:9 at 1K computes 1824x1024')
  await page.locator('.seg', { hasText: /^3$/ }).click()
  await page.locator('#prompt').fill('Product shot of a glass orca')
  await page.locator('#generate').click()
  await enterKey(page)
  await page.locator('.tile-frame.done').nth(2).waitFor()
  const g = bodies[0].j
  check(g.model === 'gpt-image-2.5-flare' && g.n === 3 && g.size === '1824x1024' && g.output_format === 'png', 'GPT request: model, n, size, output_format png')
  check(!('quality' in g) && !('background' in g) && !('moderation' in g), 'defaults are left out of the GPT request')

  // 4K for 16:9 should land exactly on 3840x2160.
  await page.locator('.resolution .seg', { hasText: '4K' }).click()
  check((await page.locator('.size-readout').textContent()).includes('3840x2160'), '16:9 at 4K computes 3840x2160')
  await page.locator('.resolution .seg', { hasText: 'Custom' }).click()
  check((await page.locator('#custom-w').getAttribute('inputmode')) === 'numeric' && (await page.locator('.size-row .times').textContent()) === 'x', 'custom size is two number fields with the x drawn between them')
  check((await page.locator('.ratio-chip[data-ratio="auto"]').count()) === 0, 'Custom mode leaves out the Auto shape')
  await page.getByRole('radio', { name: 'Aspect ratio 16:9' }).click()
  check((await page.locator('#custom-w').inputValue()) === '1824' && (await page.locator('#custom-h').inputValue()) === '1024', 'tapping a shape in Custom fills in its 1K size')
  check((await page.getByRole('radio', { name: 'Aspect ratio 16:9' }).getAttribute('aria-checked')) === 'true', 'the shape matching the typed size is marked')
  // A whole size pasted into one field is split across both.
  await page.locator('#custom-w').fill('1080x1920')
  check((await page.locator('#custom-w').inputValue()) === '1080' && (await page.locator('#custom-h').inputValue()) === '1920', 'a pasted 1080x1920 is split into width and height')
  check((await page.locator('#custom-size-errors').textContent()).includes('multiples of 16'), 'invalid custom size explains the 16px rule')
  check((await page.getByRole('radio', { name: 'Aspect ratio 16:9' }).getAttribute('aria-checked')) === 'false', 'no shape is marked for a size that matches none exactly')
  check((await page.locator('#generate').getAttribute('aria-disabled')) === 'true', 'invalid size blocks Generate')
  await page.locator('#custom-w').pressSequentially('x', { delay: 10 })
  check((await page.locator('#custom-w').inputValue()) === '1080', 'letters typed into a size field are dropped')
  await page.locator('#custom-w').fill('1152')
  await page.locator('#custom-h').fill('2048')
  check((await page.locator('#generate').getAttribute('aria-disabled')) === 'false', 'valid custom size unblocks Generate')

  // References: two uploads, one of them large enough to be scaled down.
  await page.locator('#ref-input').setInputFiles([
    { name: 'a.png', mimeType: 'image/png', buffer: Buffer.from(IMG.square, 'base64') },
    { name: 'big.png', mimeType: 'image/png', buffer: Buffer.from(IMG.big, 'base64') },
  ])
  await page.locator('.ref img').nth(1).waitFor()
  const bigDims = await page.locator('.ref img').evaluateAll((els) => els.map((e) => [e.getAttribute('width'), e.getAttribute('height')]))
  check(bigDims.some(([w, h]) => w === '2048' && h === '1024'), 'a 3000px reference is scaled to 2048px on the long side')
  check((await page.locator('.ref-count').textContent()) === '2 / 16', 'reference counter shows the GPT limit')
  await page.locator('.seg', { hasText: /^1$/ }).click()
  await page.locator('#generate').click()
  await page.locator('.batch').first().locator('.tile-frame.done').waitFor()
  const edit = bodies.find((b) => b.kind === 'edit').text
  check((edit.match(/name="image\[\]"/g) ?? []).length === 2, 'two references go out as image[] in multipart')
  check(edit.includes('name="output_format"\r\n\r\npng') && edit.includes('name="size"\r\n\r\n1152x2048'), 'edit asks for PNG at the custom size')
  check(!edit.includes('name="moderation"'), 'edits leave out moderation')

  const badge = await page.locator('.batch').first().locator('.fmt').textContent()
  check(badge.includes('JPEG, not PNG'), 'a JPEG result is flagged as not PNG')
  check((await page.locator('.batch').first().locator('.batch-note').textContent()).includes('came back as JPEG'), 'batch note explains the format mismatch')
  const dl = page.waitForEvent('download')
  await page.locator('.batch').first().getByRole('link', { name: /Download image 1/ }).click()
  const file = await dl
  const saved = readFileSync(await file.path())
  check(file.suggestedFilename().endsWith('.jpg'), `download keeps the real extension (${file.suggestedFilename()})`)
  check(saved.equals(Buffer.from(IMG.jpeg, 'base64')), 'downloaded bytes are exactly the bytes the API sent')

  // Too many references for Gemini.
  const extra = Array.from({ length: 13 }, (_, i) => ({ name: `r${i}.png`, mimeType: 'image/png', buffer: Buffer.from(IMG.square, 'base64') }))
  await page.locator('#ref-input').setInputFiles(extra)
  await page.locator('.ref img').nth(14).waitFor()
  await page.getByRole('radio', { name: /Nano Banana 2/ }).click()
  check((await page.locator('.ref-count').textContent()) === '15 / 14', 'switching to Gemini shows 15 / 14')
  check((await page.locator('#generate').getAttribute('title')).includes('Remove 1'), 'over the Gemini limit blocks Generate and says how many to remove')
  check(await page.locator('.ref.over').count() === 1, 'the reference past the limit is marked')
  check(errors.length === 0, `no console errors (${errors.join(' | ')})`)
  await ctx.close()
}

// ---------- 3. Errors and retry ----------
{
  const { ctx, page, errors } = await newPage()
  let calls = 0
  let mode = 'quota'
  mock(page, () => {
    calls++
    if (mode === 'quota') return { status: 402, json: { error: { message: 'insufficient quota', type: 'orcarouter_api_error', code: 'insufficient_user_quota' } } }
    if (mode === 'spend') return { status: 403, json: { error: { message: 'token cycle spend limit reached, resets at 2026-11-13T00:00:00Z', code: 'access_denied' } } }
    if (mode === 'busy') return calls === 1 ? { status: 429, json: { error: { message: 'slow down', code: 'free_rate_limited', metadata: { reason: 'err_free_rate', retry_after_seconds: 2 } } } } : geminiOk()
    if (mode === 'safety') return { json: { candidates: [{ content: { parts: [] }, finishReason: 'IMAGE_SAFETY' }] } }
    if (mode === 'slow') return { delay: 4000, ...geminiOk() }
    return { status: 401, json: { error: { message: 'Invalid API key', type: 'orcarouter_api_error', code: '' } } }
  })
  await page.goto(BASE)
  await page.locator('#prompt').fill('test')
  await page.locator('#generate').click()
  await enterKey(page)
  await page.locator('.tile-error').first().waitFor()
  check((await page.locator('.err-title').first().textContent()) === 'Out of credits', '402 insufficient_user_quota reads as out of credits')
  check((await page.locator('.err-id').first().textContent()).includes('req-'), 'request id shown for support')

  mode = 'spend'
  await page.locator('#generate').click()
  await page.locator('.batch').first().locator('.tile-error').waitFor()
  const spend = await page.locator('.batch').first().locator('.tile-error').textContent()
  check(spend.includes('Key spend limit reached') && spend.includes('2026-11-13T00:00:00Z'), '403 spend limit names the reset time')

  mode = 'busy'
  calls = 0
  await page.locator('#generate').click()
  await page.locator('.batch').first().locator('.tile-status', { hasText: 'retrying' }).waitFor({ timeout: 3000 })
  check(true, '429 shows a countdown while it waits to retry')
  await page.locator('.batch').first().locator('.tile-frame.done').waitFor({ timeout: 6000 })
  check(calls === 2, '429 is retried exactly once')

  mode = 'safety'
  await page.locator('#generate').click()
  await page.locator('.batch').first().locator('.tile-error').waitFor()
  check((await page.locator('.batch').first().locator('.err-title').textContent()) === 'Image blocked by Gemini', 'IMAGE_SAFETY finish reason explained')

  mode = 'slow'
  await page.locator('#generate').click()
  await page.waitForTimeout(2200)
  const ticking = await page.locator('.batch').first().locator('.tile-status .big').textContent()
  check(/^[1-9]s$/.test(ticking), `a developing tile shows elapsed seconds (${ticking})`)
  check((await page.locator('#generate').textContent()).includes('Stop'), 'Generate turns into Stop while running')
  await page.locator('#generate').click()
  await page.locator('.batch').first().locator('.tile-error').waitFor()
  check((await page.locator('.batch').first().locator('.err-title').textContent()) === 'Canceled', 'Stop cancels the request')

  mode = 'badkey'
  await page.locator('#generate').click()
  await page.locator('.batch').first().locator('.tile-error').waitFor()
  check((await page.locator('.batch').first().locator('.err-title').textContent()) === 'API key rejected', '401 reads as key rejected')
  check((await page.locator('#key-pill').textContent()).includes('Add API key'), 'a rejected key is cleared from memory')
  check(errors.length === 0, `no console errors (${errors.join(' | ')})`)
  await ctx.close()
}

// ---------- 4. Remember on this device, encrypted ----------
{
  const { ctx, page, errors } = await newPage()
  mock(page, () => geminiOk())
  await page.goto(BASE)
  await page.locator('#key-pill').click()
  await page.locator('#api-key').fill(KEY)
  await page.locator('label[for="mode-save"]').click()
  await page.locator('#passphrase').fill('short')
  await page.locator('#passphrase-2').fill('short')
  await page.getByRole('button', { name: 'Use key' }).click()
  check((await page.locator('.save-panel .warn').textContent()).includes('at least 10'), 'short passphrase refused')
  await page.locator('#passphrase').fill('correct horse battery')
  await page.locator('#passphrase-2').fill('correct horse battery')
  await page.getByRole('button', { name: 'Use key' }).click()
  await page.locator('#key-dialog').waitFor({ state: 'hidden', timeout: 10000 })
  const stored = await page.evaluate(() => localStorage.getItem('orca-ig.vault.v1'))
  check(!!stored && !stored.includes(KEY) && !stored.includes('sk-orca'), 'only ciphertext is stored')

  await page.reload()
  check((await page.locator('#key-pill').textContent()).includes('Unlock key'), 'after reload the saved key is locked')
  await page.locator('#key-pill').click()
  await page.locator('#unlock-pass').fill('wrong passphrase!')
  await page.getByRole('button', { name: 'Unlock', exact: true }).click()
  await page.locator('.unlock-box .warn').waitFor({ state: 'visible', timeout: 10000 })
  check((await page.locator('.unlock-box .warn').textContent()) === 'Wrong passphrase.', 'wrong passphrase reported')
  await page.locator('#unlock-pass').fill('correct horse battery')
  await page.getByRole('button', { name: 'Unlock', exact: true }).click()
  await page.locator('#key-dialog').waitFor({ state: 'hidden', timeout: 10000 })
  check((await page.locator('#key-pill').textContent()).includes('Key active'), 'right passphrase unlocks')

  // Clear session from settings.
  await page.locator('#prompt').fill('x')
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Clear this session' }).click()
  check((await page.locator('#prompt').inputValue()) === '' && (await page.locator('#key-pill').textContent()).includes('Unlock'), 'clear session empties the prompt and locks the key')
  check(errors.length === 0, `no console errors (${errors.join(' | ')})`)
  await ctx.close()
}

// ---------- 5. Idle lock ----------
{
  const { ctx, page } = await newPage()
  await page.clock.install()
  await page.goto(BASE)
  await page.locator('#key-pill').click()
  await enterKey(page)
  await page.clock.fastForward('14:00')
  check((await page.locator('#key-pill').textContent()).includes('Key active'), 'key still active after 14 idle minutes')
  await page.clock.fastForward('01:30')
  check((await page.locator('#key-pill').textContent()).includes('Add API key'), 'key locks itself after 15 idle minutes')
  await ctx.close()
}

// ---------- 5b. Partial GPT batch: retry keeps the images that came back ----------
{
  const { ctx, page, errors } = await newPage()
  const ns = []
  mock(page, ({ body }) => {
    const n = JSON.parse(body.toString()).n
    ns.push(n)
    return gptOk(ns.length === 1 ? n - 1 : n)
  })
  await page.goto(BASE)
  await page.getByRole('radio', { name: /GPT Image 2.5 Flare/ }).click()
  await page.locator('.seg', { hasText: /^3$/ }).click()
  await page.locator('#prompt').fill('three of them')
  await page.locator('#generate').click()
  await enterKey(page)
  await page.locator('.tile-error').waitFor()
  const before = await page.locator('.tile-open img').evaluateAll((els) => els.map((e) => e.src))
  check(before.length === 2 && (await page.locator('.err-title').textContent()) === 'Fewer images came back', 'a short GPT answer fills 2 tiles and marks the third')
  await page.getByRole('button', { name: 'Try again' }).click()
  await page.locator('.tile-frame.done').nth(2).waitFor()
  const after = await page.locator('.tile-open img').evaluateAll((els) => els.map((e) => e.src))
  check(ns[1] === 1, `the retry asks only for the missing image (n=${ns[1]})`)
  check(after.length === 3 && before.every((src) => after.includes(src)), 'the two images that came back are kept')
  check(errors.length === 0, `no console errors (${errors.join(' | ')})`)
  await ctx.close()
}

// ---------- 5c. A phone that paused the tab still locks on time ----------
{
  const { ctx, page } = await newPage()
  await page.clock.install()
  await page.goto(BASE)
  await page.locator('#key-pill').click()
  await enterKey(page)
  // setSystemTime moves the clock without running timers, like a frozen background tab.
  await page.clock.setSystemTime(Date.now() + 16 * 60_000)
  check((await page.locator('#key-pill').textContent()).includes('Key active'), 'frozen timer has not locked yet')
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  check((await page.locator('#key-pill').textContent()).includes('Add API key'), 'coming back to the tab after the deadline locks the key')
  await ctx.close()
}

// ---------- 6. Layout on phones and in light mode ----------
for (const [label, opts] of [
  ['phone-320', { viewport: { width: 320, height: 640 }, hasTouch: true, isMobile: true }],
  ['phone-360', { viewport: { width: 360, height: 740 }, hasTouch: true, isMobile: true }],
  ['iphone', devices['iPhone 13']],
  ['tablet', { viewport: { width: 820, height: 1180 }, hasTouch: true }],
]) {
  const { ctx, page, errors } = await newPage(opts)
  mock(page, () => geminiOk())
  await page.goto(BASE)
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  check(overflow <= 0, `${label}: no horizontal scroll (${overflow}px)`)
  const cut = await page.evaluate(() =>
    [...document.querySelectorAll('.seg, .primary, .ghost, .key-pill, .ratio-label, .model-name')]
      .filter((e) => e.offsetParent && e.scrollWidth > e.clientWidth + 1)
      .map((e) => e.textContent),
  )
  check(cut.length === 0, `${label}: no label cut short (${cut.join(', ')})`)
  const overlaps = await page.evaluate(() => {
    const boxes = [...document.querySelectorAll('.brand-mark, .brand-name, .key-pill, .top-actions .icon-btn')]
      // A visually hidden wordmark is a 1px box that is not drawn.
      .filter((e) => e.offsetParent && e.getBoundingClientRect().width > 2)
      .map((e) => [e.className, e.getBoundingClientRect()])
    const hits = []
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const [na, a] = boxes[i]
        const [nb, b] = boxes[j]
        if (a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom && b.top < a.bottom) hits.push(`${na} / ${nb}`)
      }
    return hits
  })
  check(overlaps.length === 0, `${label}: nothing in the top bar overlaps (${overlaps.join(', ')})`)
  const bar = await page.locator('.action-bar').boundingBox()
  const vh = page.viewportSize().height
  check(label === 'tablet' || Math.abs(bar.y + bar.height - vh) < 2, `${label}: Generate bar sits at the bottom of the screen`)
  await page.screenshot({ path: join(out, `${label}.png`) })
  if (label === 'iphone') {
    await page.locator('#key-pill').tap()
    await page.waitForTimeout(200)
    check(await page.evaluate(() => document.activeElement?.tagName !== 'INPUT'), 'on a phone the key dialog opens without focusing a field, so no keyboard')
    await page.getByRole('button', { name: 'Cancel' }).tap()
    await page.locator('#key-dialog').waitFor({ state: 'hidden' })
    await page.locator('.top-actions .icon-btn').last().tap()
    await page.getByRole('button', { name: 'Close' }).last().tap()
    await page.waitForTimeout(300)
    const stuck = await page.locator('.top-actions .icon-btn').last().evaluate((e) => getComputedStyle(e).backgroundColor)
    check(stuck === 'rgba(0, 0, 0, 0)', `a tapped button keeps no hover highlight on a phone (${stuck})`)
    await page.locator('#prompt').fill('Neon koi pond, top down')
    await page.locator('#generate').tap()
    await enterKey(page)
    await page.locator('.tile-frame.done').waitFor()
    await page.waitForTimeout(700)
    await page.screenshot({ path: join(out, 'iphone-result.png') })
    await page.evaluate(() => (document.documentElement.dataset.theme = 'light'))
    await page.screenshot({ path: join(out, 'iphone-light.png') })
  }
  check(errors.length === 0, `${label}: no console errors (${errors.join(' | ')})`)
  await ctx.close()
}

{
  const { ctx, page } = await newPage()
  mock(page, () => geminiOk())
  await page.goto(BASE)
  await page.getByRole('button', { name: /Switch to light theme/ }).click()
  check((await page.locator('html').getAttribute('data-theme')) === 'light', 'theme toggle switches to light')
  await page.reload()
  check((await page.locator('html').getAttribute('data-theme')) === 'light', 'light theme survives reload without a flash (set before first paint)')
  await page.locator('#prompt').fill('A lighthouse in violet fog')
  await page.locator('.seg', { hasText: /^2$/ }).click()
  await page.locator('#generate').click()
  await enterKey(page)
  await page.locator('.tile-frame.done').nth(1).waitFor()
  await page.waitForTimeout(600)
  await page.screenshot({ path: join(out, 'desktop-light.png') })
  check((await page.locator('.batch-note p').count()) === 1, 'a repeated model note shows once')
  await page.locator('#key-pill').click()
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(out, 'desktop-light-keydialog.png') })
  await page.getByRole('button', { name: 'Lock now' }).click()
  await page.locator('#key-pill').click()
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(out, 'desktop-light-keyentry.png') })
  await ctx.close()
}

// ---------- 7. Refuses to run in a frame ----------
{
  const { ctx, page } = await newPage()
  // Served from the same localhost origin: Chrome blocks a public page from framing localhost at all.
  await page.route(`${BASE}framer.html`, (r) => r.fulfill({ contentType: 'text/html', body: `<iframe src="${BASE}" width="800" height="600"></iframe>` }))
  await page.goto(`${BASE}framer.html`)
  const frame = page.frameLocator('iframe')
  await frame.locator('.noscript').waitFor()
  check((await frame.locator('.noscript').textContent()).includes('does not run inside other pages'), 'refuses to run inside a frame')
  check((await frame.locator('#prompt').count()) === 0, 'no controls render inside a frame')
  await ctx.close()
}

await browser.close()
server.kill()
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
process.exit(failures ? 1 : 0)
