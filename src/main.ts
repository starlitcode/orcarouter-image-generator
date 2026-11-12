import '@fontsource-variable/bricolage-grotesque/wght.css'
import '@fontsource-variable/jetbrains-mono/wght.css'
import './styles.css'

import { checkModelId, runGemini, runGpt, withRetry, type OutImage, type Outcome } from './api.ts'
import { append, clear, h, icon, type IconName } from './dom.ts'
import type { FriendlyError } from './errors.ts'
import {
  ACCEPTED_TYPES,
  extensionForFormat,
  formatLabel,
  prepareRef,
  RefError,
  releaseRef,
  type OutFormat,
  type RefImage,
} from './images.ts'
import * as vault from './keyvault.ts'
import {
  GEMINI_THINKING,
  GPT_BACKGROUNDS,
  GPT_LIMITS,
  GPT_MODERATION,
  GPT_QUALITIES,
  GPT_TIERS,
  MAX_BATCH,
  MODELS,
  gptSizeErrors,
  gptSizeFor,
  modelById,
  parseSize,
  ratioLabel,
  sizeLabel,
  type Model,
  type Ratio,
  type Size,
} from './models.ts'
import { IDLE_CHOICES, loadPrefs, savePrefs, type GptSizeMode, type Prefs } from './prefs.ts'

// ---------- state ----------

const prefs: Prefs = loadPrefs()
let refs: RefImage[] = []
let refsLoading = 0
let prompt = ''
let running: Batch | null = null
let pendingAfterKey: (() => void) | null = null

const MAX_REFS_ANY = Math.max(...MODELS.map((m) => m.maxRefs))

const currentModel = (): Model => modelById(prefs.modelId) ?? MODELS[0]!
const modelIdFor = (m: Model): string => (prefs.customIds[m.id] ?? '').trim() || m.id

function persist(): void {
  savePrefs(prefs)
}

const parseRatio = (text: string): Ratio | null => {
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(text)
  return m ? { w: Number(m[1]), h: Number(m[2]) } : null
}

function selectedRatio(model: Model): Ratio | null {
  const text = model.family === 'gemini' ? prefs.geminiRatio : prefs.gptRatio
  const r = parseRatio(text)
  if (!r) return null
  return model.ratios.some((x) => x.w === r.w && x.h === r.h) ? r : model.ratios[0]!
}

function gptSize(model: Model): Size | 'auto' | null {
  const ratio = selectedRatio(model)
  if (prefs.gptSizeMode === 'custom') return parseSize(prefs.gptCustom)
  if (!ratio) return 'auto'
  return gptSizeFor(ratio, prefs.gptSizeMode)
}

// ---------- theme and motion ----------

const root = document.documentElement

function applyTheme(): void {
  root.dataset.theme = prefs.theme
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', prefs.theme === 'light' ? '#fbf9ff' : '#0c0a14')
}

function applyMotion(): void {
  if (prefs.motion === 'reduce') root.dataset.motion = 'reduce'
  else delete root.dataset.motion
}

applyTheme()
applyMotion()
vault.setIdleMinutes(prefs.idleMinutes)

// ---------- small building blocks ----------

function button(label: string | Node, attrs: Record<string, string | boolean | undefined> = {}, onClick?: (e: MouseEvent) => void): HTMLButtonElement {
  const b = h('button', { type: 'button', ...attrs }, label)
  if (onClick) b.addEventListener('click', onClick)
  return b
}

function iconButton(name: IconName, label: string, onClick: (e: MouseEvent) => void, cls = 'icon-btn'): HTMLButtonElement {
  const b = button(icon(name), { class: cls, 'aria-label': label, title: label }, onClick)
  return b
}

// A row of mutually exclusive buttons with aria-pressed.
interface Segmented<T extends string> {
  el: HTMLElement
  set(value: T): void
  setDisabled(disabled: boolean): void
}

function segmented<T extends string>(
  label: string,
  options: readonly { value: T; text: string; title?: string }[],
  value: T,
  onChange: (v: T) => void,
): Segmented<T> {
  const el = h('div', { class: 'segmented', role: 'group', 'aria-label': label })
  const buttons = options.map((o) => {
    const b = button(o.text, { class: 'seg', title: o.title, 'data-value': o.value }, () => {
      set(o.value)
      onChange(o.value)
    })
    el.append(b)
    return b
  })
  const set = (v: T): void => buttons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === v)))
  set(value)
  return {
    el,
    set,
    setDisabled: (d) => buttons.forEach((b) => (b.disabled = d)),
  }
}

function field(labelText: string, control: HTMLElement, hint?: HTMLElement | string, forId?: string): HTMLElement {
  return h(
    'div',
    { class: 'field' },
    h('label', { class: 'label', for: forId }, labelText),
    control,
    hint ? (typeof hint === 'string' ? h('p', { class: 'hint' }, hint) : hint) : null,
  )
}

function select<T extends string | number>(id: string, options: readonly { value: T; text: string }[], value: T, onChange: (v: T) => void): HTMLSelectElement {
  const s = h('select', { id, class: 'select' })
  for (const o of options) s.append(h('option', { value: String(o.value), selected: o.value === value }, o.text))
  s.addEventListener('change', () => {
    const picked = options.find((o) => String(o.value) === s.value)
    if (picked) onChange(picked.value)
  })
  return s
}

// ---------- toasts ----------

const toastRegion = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' })

function toast(message: string, tone: 'info' | 'warn' = 'info'): void {
  const t = h('div', { class: `toast toast-${tone}` }, h('span', {}, message))
  const close = (): void => {
    t.classList.add('leaving')
    window.setTimeout(() => t.remove(), 160)
  }
  t.append(iconButton('x', 'Dismiss', close, 'icon-btn small'))
  toastRegion.append(t)
  window.setTimeout(close, 7000)
}

// ---------- top bar ----------

const keyPill = button('', { class: 'key-pill', id: 'key-pill' }, () => openKeyDialog())
const themeBtn = iconButton('moon', 'Switch theme', () => {
  prefs.theme = prefs.theme === 'dark' ? 'light' : 'dark'
  persist()
  applyTheme()
  renderThemeBtn()
})
const settingsBtn = iconButton('gear', 'Settings', () => openSettings())

function renderThemeBtn(): void {
  const next = prefs.theme === 'dark' ? 'light' : 'dark'
  themeBtn.replaceChildren(icon(next === 'light' ? 'sun' : 'moon'))
  themeBtn.setAttribute('aria-label', `Switch to ${next} theme`)
  themeBtn.title = `Switch to ${next} theme`
}

function renderKeyPill(): void {
  keyPill.replaceChildren()
  if (vault.hasKey()) {
    const ms = vault.msUntilLock()
    const mins = Math.ceil(ms / 60_000)
    keyPill.dataset.state = 'active'
    append(keyPill, h('span', { class: 'dot', 'aria-hidden': 'true' }), h('span', {}, 'Key active'))
    if (ms > 0) {
      const text = ms < 60_000 ? `${Math.ceil(ms / 1000)}s` : `${mins}m`
      append(keyPill, h('span', { class: 'pill-meta mono', title: 'Locks itself after this much idle time' }, text))
    }
    keyPill.setAttribute('aria-label', `API key active${ms > 0 ? `, locks in ${mins} minutes without activity` : ''}. Open key options.`)
  } else if (vault.hasSavedKey()) {
    keyPill.dataset.state = 'saved'
    append(keyPill, icon('lock', 16), h('span', {}, 'Unlock key'))
    keyPill.setAttribute('aria-label', 'Saved key is locked. Unlock it.')
  } else {
    keyPill.dataset.state = 'none'
    append(keyPill, icon('key', 16), h('span', {}, 'Add API key'))
    keyPill.setAttribute('aria-label', 'Add your OrcaRouter API key')
  }
}

const topbar = h(
  'header',
  { class: 'topbar' },
  h(
    'h1',
    { class: 'brand' },
    h('span', { class: 'brand-mark', 'aria-hidden': 'true' }),
    h('span', { class: 'brand-name' }, 'Darkroom'),
    h('span', { class: 'brand-sub' }, 'image generator for OrcaRouter'),
  ),
  h('div', { class: 'top-actions' }, keyPill, themeBtn, settingsBtn),
)

// ---------- rail: model ----------

const modelGroup = h('div', { class: 'model-list', role: 'radiogroup', 'aria-label': 'Model' })

function renderModels(): void {
  clear(modelGroup)
  for (const m of MODELS) {
    const checked = m.id === prefs.modelId
    const card = h(
      'button',
      { type: 'button', class: 'model-card', role: 'radio', 'aria-checked': String(checked), tabindex: checked ? '0' : '-1', 'data-id': m.id },
      h('span', { class: 'model-name' }, m.name),
      h('span', { class: 'model-maker' }, m.maker),
      h('span', { class: 'model-note' }, m.note),
      h('span', { class: 'model-refs mono' }, `${m.maxRefs} refs`),
    )
    card.addEventListener('click', () => chooseModel(m.id))
    card.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
      e.preventDefault()
      const i = MODELS.findIndex((x) => x.id === prefs.modelId)
      const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1
      const next = MODELS[(i + step + MODELS.length) % MODELS.length]!
      chooseModel(next.id)
      modelGroup.querySelector<HTMLElement>(`[data-id="${CSS.escape(next.id)}"]`)?.focus()
    })
    modelGroup.append(card)
  }
}

function chooseModel(id: string): void {
  if (prefs.modelId === id) return
  prefs.modelId = id
  persist()
  renderModels()
  renderShape()
  renderOptions()
  renderRefs()
  validate()
}

// ---------- rail: prompt ----------

const promptBox = h('textarea', {
  id: 'prompt',
  class: 'prompt',
  rows: 5,
  maxlength: 32000,
  placeholder: 'What should the image show?',
  spellcheck: 'true',
})
promptBox.addEventListener('input', () => {
  prompt = promptBox.value
  validate()
})
promptBox.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault()
    startGenerate()
  }
})

// ---------- rail: references ----------

const fileInput = h('input', { type: 'file', accept: ACCEPTED_TYPES.join(','), multiple: true, class: 'visually-hidden', id: 'ref-input', tabindex: '-1' })
const refGrid = h('div', { class: 'ref-grid' })
const refCount = h('span', { class: 'ref-count mono' })
const refWarn = h('p', { class: 'hint warn', hidden: true })
const dropzone = button(
  h('span', { class: 'drop-inner' }, icon('plus', 20), h('span', {}, 'Add images'), h('span', { class: 'drop-sub' }, 'Drop, paste or pick. PNG, JPEG, WebP.')),
  { class: 'dropzone' },
  () => fileInput.click(),
)

fileInput.addEventListener('change', () => {
  if (fileInput.files) void addFiles([...fileInput.files])
  fileInput.value = ''
})

async function addFiles(files: File[]): Promise<void> {
  const images = files.filter((f) => f.type.startsWith('image/'))
  if (images.length === 0) return
  const room = MAX_REFS_ANY - refs.length - refsLoading
  const taking = images.slice(0, Math.max(0, room))
  if (taking.length < images.length) toast(`Up to ${MAX_REFS_ANY} reference images. ${images.length - taking.length} not added.`, 'warn')
  refsLoading += taking.length
  renderRefs()
  validate()
  const rejected: string[] = []
  await Promise.all(
    taking.map(async (file) => {
      try {
        const ref = await prepareRef(file, file.name || 'pasted image')
        refs = [...refs, ref]
      } catch (e) {
        rejected.push(`${file.name || 'An image'} ${e instanceof RefError ? e.message : 'could not be added'}`)
      } finally {
        refsLoading--
      }
    }),
  )
  if (rejected.length) toast(rejected.join('. ') + '.', 'warn')
  renderRefs()
  validate()
}

function removeRef(id: string): void {
  const ref = refs.find((r) => r.id === id)
  if (ref) releaseRef(ref)
  refs = refs.filter((r) => r.id !== id)
  renderRefs()
  validate()
}

function renderRefs(): void {
  const model = currentModel()
  clear(refGrid)
  refs.forEach((ref, i) => {
    const over = i >= model.maxRefs
    refGrid.append(
      h(
        'figure',
        { class: `ref${over ? ' over' : ''}`, title: ref.name },
        h('img', { src: ref.url, alt: `Reference ${i + 1}: ${ref.name}`, width: ref.width, height: ref.height, decoding: 'async' }),
        h('span', { class: 'ref-index mono', 'aria-hidden': 'true' }, String(i + 1)),
        iconButton('x', `Remove reference ${i + 1}`, () => removeRef(ref.id), 'icon-btn small ref-remove'),
      ),
    )
  })
  for (let i = 0; i < refsLoading; i++) refGrid.append(h('div', { class: 'ref loading', 'aria-label': 'Loading image' }))
  refCount.textContent = `${refs.length} / ${model.maxRefs}`
  refCount.classList.toggle('over', refs.length > model.maxRefs)
  const extra = refs.length - model.maxRefs
  refWarn.hidden = extra <= 0
  refWarn.textContent = extra > 0 ? `${model.name} takes up to ${model.maxRefs}. Remove ${extra}, the faded ones would not be sent.` : ''
  dropzone.hidden = refs.length + refsLoading >= MAX_REFS_ANY
}

// ---------- rail: shape ----------

const ratioGrid = h('div', { class: 'ratio-grid', role: 'radiogroup', 'aria-label': 'Aspect ratio' })
const resolutionSlot = h('div', { class: 'resolution' })
const sizeReadout = h('p', { class: 'hint size-readout' })
const customInput = h('input', {
  id: 'custom-size',
  class: 'input mono',
  inputmode: 'numeric',
  autocomplete: 'off',
  spellcheck: 'false',
  placeholder: '1536x1024',
  'aria-describedby': 'custom-size-errors',
})
const customErrors = h('ul', { class: 'hint warn errors', id: 'custom-size-errors' })
customInput.addEventListener('input', () => {
  prefs.gptCustom = customInput.value
  persist()
  renderSizeReadout()
  validate()
})

function ratioChip(ratio: Ratio | null, checked: boolean, onPick: () => void): HTMLButtonElement {
  const label = ratio ? ratioLabel(ratio) : 'Auto'
  const shape = h('span', { class: 'ratio-shape', 'aria-hidden': 'true' })
  if (ratio) {
    const box = 20
    const k = ratio.w / ratio.h
    shape.style.width = `${Math.max(3, k >= 1 ? box : box * k)}px`
    shape.style.height = `${Math.max(3, k >= 1 ? box / k : box)}px`
  } else {
    shape.classList.add('auto')
  }
  const b = button(h('span', { class: 'ratio-frame' }, shape), {
    class: 'ratio-chip',
    role: 'radio',
    'aria-checked': String(checked),
    'aria-label': ratio ? `Aspect ratio ${label}` : 'Automatic aspect ratio',
  }, onPick)
  b.append(h('span', { class: 'ratio-label mono' }, label))
  return b
}

function renderShape(): void {
  const model = currentModel()
  const ratio = selectedRatio(model)
  clear(ratioGrid)
  const pick = (r: Ratio | null): void => {
    const text = r ? ratioLabel(r) : 'auto'
    if (model.family === 'gemini') prefs.geminiRatio = text
    else prefs.gptRatio = text
    persist()
    renderShape()
    validate()
  }
  ratioGrid.append(ratioChip(null, ratio === null, () => pick(null)))
  for (const r of model.ratios) ratioGrid.append(ratioChip(r, !!ratio && r.w === ratio.w && r.h === ratio.h, () => pick(r)))

  clear(resolutionSlot)
  if (model.family === 'gemini') {
    const seg = segmented(
      'Resolution',
      model.sizes.map((s) => ({ value: s, text: s === '512' ? '0.5K' : s })),
      model.sizes.includes(prefs.geminiSize) ? prefs.geminiSize : model.defaultSize,
      (v) => {
        prefs.geminiSize = v
        persist()
        renderSizeReadout()
      },
    )
    resolutionSlot.append(seg.el)
  } else {
    const options: { value: GptSizeMode; text: string }[] = [...GPT_TIERS.map((t) => ({ value: t, text: t })), { value: 'custom', text: 'Custom' }]
    const seg = segmented('Resolution', options, prefs.gptSizeMode, (v) => {
      prefs.gptSizeMode = v
      persist()
      renderShape()
      validate()
    })
    resolutionSlot.append(seg.el)
    if (prefs.gptSizeMode === 'custom') {
      customInput.value = prefs.gptCustom
      resolutionSlot.append(field('Width x height', customInput, undefined, 'custom-size'), customErrors)
    } else if (ratio === null) {
      seg.setDisabled(true)
    }
  }
  resolutionSlot.append(sizeReadout)
  renderSizeReadout()
}

function renderSizeReadout(): void {
  const model = currentModel()
  clear(customErrors)
  if (model.family === 'gemini') {
    const ratio = selectedRatio(model)
    sizeReadout.textContent = ratio
      ? `${ratioLabel(ratio)} at ${prefs.geminiSize === '512' ? '0.5K' : prefs.geminiSize}.`
      : 'Auto lets Gemini pick the shape, usually from the first reference image.'
    return
  }
  const size = gptSize(model)
  if (size === 'auto') {
    sizeReadout.textContent = 'Auto lets the model pick the size.'
    return
  }
  if (size === null) {
    sizeReadout.textContent = 'Type a size like 1536x1024.'
    return
  }
  const errors = gptSizeErrors(size)
  for (const e of errors) customErrors.append(h('li', {}, e))
  if (errors.length) {
    sizeReadout.textContent = ''
    return
  }
  const pixels = size.width * size.height
  const experimental = pixels > GPT_LIMITS.experimentalPixels
  sizeReadout.replaceChildren(
    h('span', { class: 'mono strong' }, sizeLabel(size)),
    ` (${(pixels / 1_000_000).toFixed(1)} MP)`,
    experimental ? h('span', { class: 'tag' }, 'experimental') : '',
  )
  if (experimental) sizeReadout.title = 'OpenAI marks sizes above 2560x1440 as experimental.'
  else sizeReadout.removeAttribute('title')
}

// ---------- rail: count ----------

const countSeg = segmented(
  'Number of images',
  Array.from({ length: MAX_BATCH }, (_, i) => ({ value: String(i + 1), text: String(i + 1) })),
  String(prefs.count),
  (v) => {
    prefs.count = Number(v)
    persist()
    validate()
  },
)

// ---------- rail: more options ----------

const optionsBody = h('div', { class: 'options-body' })
const moreOptions = h(
  'details',
  { class: 'more' },
  h('summary', {}, h('span', {}, 'More options'), h('span', { class: 'summary-meta' })),
  optionsBody,
)

const modelIdInput = h('input', { id: 'model-id', class: 'input mono', autocomplete: 'off', spellcheck: 'false', maxlength: 128 })
const modelIdError = h('p', { class: 'hint warn', hidden: true })
modelIdInput.addEventListener('input', () => {
  const m = currentModel()
  const v = modelIdInput.value.trim()
  if (v === '' || v === m.id) delete prefs.customIds[m.id]
  else prefs.customIds[m.id] = v
  persist()
  validate()
})

function renderOptions(): void {
  const model = currentModel()
  clear(optionsBody)
  if (model.family === 'gpt') {
    optionsBody.append(
      field('Quality', segmented('Quality', GPT_QUALITIES.map((q) => ({ value: q, text: q })), prefs.gptQuality, (v) => {
        prefs.gptQuality = v
        persist()
        renderSummary()
      }).el, 'xhigh and max take longer and use more tokens.'),
      field('Background', segmented('Background', GPT_BACKGROUNDS.map((b) => ({ value: b, text: b })), prefs.gptBackground, (v) => {
        prefs.gptBackground = v
        persist()
        renderSummary()
      }).el),
      field('Moderation', segmented('Moderation', GPT_MODERATION.map((b) => ({ value: b, text: b })), prefs.gptModeration, (v) => {
        prefs.gptModeration = v
        persist()
        renderSummary()
      }).el, 'Applies to new images. Edits with reference images always use the default.'),
    )
  } else {
    optionsBody.append(
      field('Thinking', segmented('Thinking', GEMINI_THINKING.map((t) => ({ value: t, text: t })), prefs.geminiThinking, (v) => {
        prefs.geminiThinking = v
        persist()
        renderSummary()
      }).el, 'High plans the image first. Slower, better for complex scenes and text.'),
    )
  }
  modelIdInput.value = modelIdFor(model)
  optionsBody.append(
    field('Model id', modelIdInput, h('p', { class: 'hint' }, `Sent to OrcaRouter as is. Leave as ${model.id} unless it was renamed.`), 'model-id'),
    modelIdError,
    h('p', { class: 'hint' }, 'Images are always requested as PNG, which is lossless.'),
  )
  renderSummary()
}

function renderSummary(): void {
  const model = currentModel()
  const meta = moreOptions.querySelector('.summary-meta')
  if (!meta) return
  const bits =
    model.family === 'gpt'
      ? [prefs.gptQuality !== 'auto' && prefs.gptQuality, prefs.gptBackground !== 'auto' && prefs.gptBackground, prefs.gptModeration !== 'auto' && 'moderation low']
      : [prefs.geminiThinking === 'high' && 'thinking high']
  if (prefs.customIds[model.id]) bits.push('custom id')
  meta.textContent = bits.filter(Boolean).join(' · ')
}

// ---------- rail: action bar ----------

const generateBtn = button(h('span', { class: 'gen-label' }, 'Generate'), { class: 'primary generate', id: 'generate' }, () => {
  if (running) running.controller.abort()
  else startGenerate()
})
const statusLine = h('p', { class: 'status-line', id: 'status-line', 'aria-live': 'polite' })
const shortcutHint = h('span', { class: 'kbd-hint' }, h('kbd', {}, 'Ctrl'), '+', h('kbd', {}, 'Enter'))
const actionBar = h('div', { class: 'action-bar' }, statusLine, h('div', { class: 'action-row' }, generateBtn, countSeg.el))
countSeg.el.classList.add('count-seg')
countSeg.el.setAttribute('title', 'Number of images')

function blockReason(): string {
  const model = currentModel()
  if (!prompt.trim()) return 'Write a prompt first.'
  if (refsLoading > 0) return 'Wait for the reference images to finish loading.'
  if (refs.length > model.maxRefs) return `${model.name} takes up to ${model.maxRefs} reference images. Remove ${refs.length - model.maxRefs}.`
  const idError = checkModelId(modelIdFor(model))
  if (idError) return `Model id: ${idError}`
  if (model.family === 'gpt') {
    const size = gptSize(model)
    if (size === null) return 'Type a custom size like 1536x1024.'
    if (size !== 'auto') {
      const errors = gptSizeErrors(size)
      if (errors.length) return `Size: ${errors[0]}`
    }
  }
  return ''
}

function validate(): void {
  const reason = running ? '' : blockReason()
  const idError = checkModelId(modelIdFor(currentModel()))
  modelIdError.hidden = !idError
  modelIdError.textContent = idError
  generateBtn.classList.toggle('stop', !!running)
  generateBtn.setAttribute('aria-disabled', String(!!reason))
  const label = generateBtn.querySelector('.gen-label')
  if (label) label.textContent = running ? 'Stop' : prefs.count > 1 ? `Generate ${prefs.count}` : 'Generate'
  generateBtn.title = running ? 'Stop this batch' : reason || 'Generate (Ctrl+Enter)'
  if (!running) statusLine.textContent = reason && prompt.trim() ? reason : ''
  statusLine.classList.toggle('warn', !!reason)
}

// ---------- the rail ----------

const rail = h(
  'aside',
  { class: 'rail', 'aria-label': 'Generation settings' },
  h('div', { class: 'rail-scroll' },
    h('section', { class: 'block' }, h('h2', { class: 'block-title' }, 'Model'), modelGroup),
    h('section', { class: 'block' }, h('label', { class: 'block-title', for: 'prompt' }, 'Prompt'), promptBox, h('p', { class: 'hint' }, shortcutHint, ' to generate')),
    h('section', { class: 'block' },
      h('div', { class: 'block-head' }, h('h2', { class: 'block-title' }, 'Reference images'), refCount),
      refGrid,
      dropzone,
      fileInput,
      refWarn,
      h('p', { class: 'hint' }, 'Images over 2048px are scaled down before upload.'),
    ),
    h('section', { class: 'block' }, h('h2', { class: 'block-title' }, 'Shape'), ratioGrid, resolutionSlot),
    h('section', { class: 'block' }, moreOptions),
  ),
  actionBar,
)

// Drag and drop onto the rail.
rail.addEventListener('dragover', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return
  e.preventDefault()
  rail.classList.add('dragging')
})
rail.addEventListener('dragleave', (e) => {
  if (e.target === rail || !rail.contains(e.relatedTarget as Node | null)) rail.classList.remove('dragging')
})
rail.addEventListener('drop', (e) => {
  rail.classList.remove('dragging')
  if (!e.dataTransfer?.files.length) return
  e.preventDefault()
  void addFiles([...e.dataTransfer.files])
})

// Pasting an image anywhere adds it as a reference, except into the key fields.
document.addEventListener('paste', (e) => {
  const target = e.target as HTMLElement | null
  if (target?.closest('[data-secret]')) return
  const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'))
  if (files.length === 0) return
  e.preventDefault()
  void addFiles(files)
})

// ---------- results ----------

interface Tile {
  el: HTMLElement
  frame: HTMLElement
  status: HTMLElement
  started: number
  waiting: number
  done: boolean
  image: (OutImage & { url: string; width: number; height: number }) | null
}

interface Batch {
  id: string
  el: HTMLElement
  meta: HTMLElement
  tiles: Tile[]
  controller: AbortController
  started: number
  costs: number[]
  modelName: string
  modelShort: string
  note: HTMLElement
}

const results = h('section', { class: 'results', 'aria-label': 'Results' })
const resultsList = h('div', { class: 'batches' })
const emptyState = h(
  'div',
  { class: 'empty' },
  h('div', { class: 'empty-frame', 'aria-hidden': 'true' }, icon('image', 28)),
  h('p', { class: 'empty-title' }, 'Nothing developed yet'),
  h('p', { class: 'empty-text' }, 'Pick a model, write a prompt and press Generate. Images stay in this tab only, download the ones you want to keep.'),
)
results.append(emptyState, resultsList)

const formatTime = (ms: number): string => {
  const s = Math.floor(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

function tileAspect(tile: Tile, w: number, h_: number): void {
  tile.frame.style.aspectRatio = `${w} / ${h_}`
}

function makeTile(ratio: { w: number; h: number }): Tile {
  const status = h('div', { class: 'tile-status' })
  const frame = h('div', { class: 'tile-frame pending' }, h('div', { class: 'sweep', 'aria-hidden': 'true' }), status)
  const el = h('div', { class: 'tile' }, frame)
  const tile: Tile = { el, frame, status, started: Date.now(), waiting: 0, done: false, image: null }
  tileAspect(tile, ratio.w, ratio.h)
  renderTileStatus(tile)
  return tile
}

function renderTileStatus(tile: Tile): void {
  if (tile.done) return
  const elapsed = formatTime(Date.now() - tile.started)
  clear(tile.status)
  if (tile.waiting > 0) {
    append(tile.status, h('span', { class: 'mono big' }, `${tile.waiting}s`), h('span', {}, 'Busy, retrying once'))
  } else {
    append(tile.status, h('span', { class: 'mono big' }, elapsed), h('span', {}, 'Developing'))
  }
}

function filename(batch: Batch, index: number, format: OutFormat): string {
  const d = new Date(batch.started)
  const pad = (n: number): string => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  return `darkroom-${batch.modelShort}-${stamp}-${index + 1}.${extensionForFormat(format)}`
}

function formatBadge(format: OutFormat): HTMLElement {
  if (format === 'png') return h('span', { class: 'fmt mono', title: 'Lossless PNG, as requested' }, 'PNG')
  return h(
    'span',
    { class: 'fmt mono off', title: `The provider sent ${formatLabel(format)} instead of PNG. The file is kept exactly as it arrived.` },
    icon('warn', 12),
    format === 'unknown' ? 'not PNG' : `${format.toUpperCase()}, not PNG`,
  )
}

function fillTile(batch: Batch, tile: Tile, index: number, out: OutImage, text: string): void {
  tile.done = true
  const url = out.blob ? URL.createObjectURL(out.blob) : out.remoteUrl
  const img = h('img', { src: url, alt: `Generated image ${index + 1}`, decoding: 'async', referrerpolicy: 'no-referrer' })
  tile.image = { ...out, url, width: 0, height: 0 }
  img.addEventListener('load', () => {
    if (!tile.image) return
    tile.image.width = img.naturalWidth
    tile.image.height = img.naturalHeight
    tileAspect(tile, img.naturalWidth, img.naturalHeight)
    dims.textContent = `${img.naturalWidth}x${img.naturalHeight}`
  })
  const dims = h('span', { class: 'mono dim' })
  const openBtn = button(img, { class: 'tile-open', 'aria-label': `Open image ${index + 1}` }, () => openViewer(batch, tile, index, text))
  const actions = h('div', { class: 'tile-actions' })
  if (out.blob) {
    actions.append(
      h('a', { class: 'icon-btn', href: url, download: filename(batch, index, out.format), 'aria-label': `Download image ${index + 1}`, title: 'Download' }, icon('download')),
      iconButton('reuse', 'Use as reference', () => void useAsRef(out.blob!, index)),
    )
  } else {
    actions.append(h('a', { class: 'icon-btn', href: url, target: '_blank', rel: 'noopener noreferrer', 'aria-label': 'Open the provider link', title: 'Open link' }, icon('expand')))
  }
  tile.frame.className = 'tile-frame done'
  tile.frame.replaceChildren(openBtn)
  tile.el.append(h('div', { class: 'tile-bar' }, h('span', { class: 'tile-meta' }, formatBadge(out.format), dims), actions))
}

function failTile(tile: Tile, error: FriendlyError, retry: (() => void) | null): void {
  tile.done = true
  tile.frame.className = 'tile-frame error'
  const body = h(
    'div',
    { class: 'tile-error', role: 'alert' },
    h('p', { class: 'err-title' }, error.title),
    h('p', { class: 'err-detail' }, error.detail),
    error.upstreamMessage ? h('p', { class: 'err-upstream mono' }, error.upstreamMessage) : null,
    error.requestId ? h('p', { class: 'err-id mono' }, `Request ${error.requestId}`) : null,
  )
  const actions = h('div', { class: 'err-actions' })
  if (error.status === 401 || error.title === 'No API key') {
    actions.append(button('Enter key', { class: 'ghost small' }, () => openKeyDialog()))
  }
  if (!error.final && retry && error.title !== 'Canceled') actions.append(button('Try again', { class: 'ghost small' }, retry))
  if (actions.childElementCount) body.append(actions)
  tile.frame.replaceChildren(body)
}

async function useAsRef(blob: Blob, index: number): Promise<void> {
  if (refs.length + refsLoading >= MAX_REFS_ANY) {
    toast(`Already at ${MAX_REFS_ANY} reference images.`, 'warn')
    return
  }
  const type = blob.type
  const file = new File([blob], `generated-${index + 1}.${type === 'image/jpeg' ? 'jpg' : type === 'image/webp' ? 'webp' : 'png'}`, { type })
  await addFiles([file])
  if (window.matchMedia('(max-width: 899px)').matches) refGrid.scrollIntoView({ behavior: 'smooth', block: 'center' })
}

function removeBatch(batch: Batch): void {
  if (running === batch) batch.controller.abort()
  for (const t of batch.tiles) if (t.image?.blob) URL.revokeObjectURL(t.image.url)
  batch.el.remove()
  batches = batches.filter((b) => b !== batch)
  emptyState.hidden = batches.length > 0
}

let batches: Batch[] = []
let batchCounter = 0

function renderBatchMeta(batch: Batch): void {
  const done = batch.tiles.every((t) => t.done)
  const total = batch.costs.reduce((a, b) => a + b, 0)
  const parts = [done ? formatTime(Date.now() - batch.started) : '']
  if (batch.costs.length) parts.push(`$${total < 0.01 ? total.toFixed(4) : total.toFixed(3)}`)
  batch.meta.textContent = parts.filter(Boolean).join(' · ')
}

// ---------- generate ----------

function startGenerate(): void {
  if (running) return
  const reason = blockReason()
  if (reason) {
    statusLine.textContent = reason
    statusLine.classList.add('warn')
    if (!prompt.trim()) promptBox.focus()
    return
  }
  if (!vault.hasKey()) {
    pendingAfterKey = startGenerate
    openKeyDialog()
    return
  }
  void generate()
}

async function generate(): Promise<void> {
  const model = currentModel()
  const count = prefs.count
  const sendRefs = refs.slice(0, model.maxRefs)
  const modelId = modelIdFor(model)
  const ratio = selectedRatio(model)
  // Settings are fixed at press time, so a retry repeats the same request.
  const geminiSize = prefs.geminiSize
  const geminiThinking = prefs.geminiThinking

  let tileRatio = ratio ?? { w: 1, h: 1 }
  let sizeText = ''
  const gSize = model.family === 'gpt' ? gptSize(model) : null
  if (model.family === 'gemini') {
    sizeText = `${ratio ? ratioLabel(ratio) : 'auto'} · ${prefs.geminiSize === '512' ? '0.5K' : prefs.geminiSize}`
  } else if (gSize && gSize !== 'auto') {
    tileRatio = { w: gSize.width, h: gSize.height }
    sizeText = sizeLabel(gSize)
  } else {
    sizeText = 'auto size'
  }

  const controller = new AbortController()
  const tiles = Array.from({ length: count }, () => makeTile(tileRatio))
  const meta = h('span', { class: 'batch-time mono' })
  const note = h('p', { class: 'batch-note', hidden: true })
  const batchEl = h('article', { class: 'batch', 'aria-busy': 'true' })
  const batch: Batch = {
    id: `b${++batchCounter}`,
    el: batchEl,
    meta,
    tiles,
    controller,
    started: Date.now(),
    costs: [],
    modelName: model.name,
    modelShort: model.id.split('/').pop()!.replace(/[^a-z0-9.-]/gi, ''),
    note,
  }
  const promptText = prompt.trim()
  append(
    batchEl,
    h(
      'header',
      { class: 'batch-head' },
      h('div', { class: 'batch-info' },
        h('p', { class: 'batch-prompt', title: promptText }, promptText),
        h('p', { class: 'batch-specs' },
          h('span', {}, model.name),
          h('span', { class: 'mono' }, sizeText),
          sendRefs.length ? h('span', {}, `${sendRefs.length} ref${sendRefs.length > 1 ? 's' : ''}`) : null,
          meta,
        ),
      ),
      iconButton('trash', 'Remove this batch', () => removeBatch(batch), 'icon-btn small'),
    ),
    note,
    h('div', { class: `tiles count-${count}` }, ...tiles.map((t) => t.el)),
  )
  batches = [batch, ...batches]
  resultsList.prepend(batchEl)
  emptyState.hidden = true
  running = batch
  validate()
  statusLine.textContent = ''
  if (window.matchMedia('(max-width: 899px)').matches) batchEl.scrollIntoView({ behavior: 'smooth', block: 'start' })

  const onOutcome = (outcome: Outcome, indexes: number[], retry: () => void): void => {
    if (outcome.ok) {
      if (outcome.costUsd !== null) batch.costs.push(outcome.costUsd)
      if (outcome.creditsLow) creditsLowNotice()
      indexes.forEach((i, k) => {
        const img = outcome.images[k]
        if (img) fillTile(batch, tiles[i]!, i, img, outcome.text)
        else failTile(tiles[i]!, { title: 'Fewer images came back', detail: `The provider returned ${outcome.images.length} of ${indexes.length}.`, final: false, status: 0, code: '', requestId: outcome.requestId, upstreamMessage: '' }, retry)
      })
      if (outcome.text && model.family === 'gemini') showNote(batch, outcome.text)
    } else {
      if (outcome.error.status === 401) vault.lock()
      for (const i of indexes) failTile(tiles[i]!, outcome.error, retry)
    }
    renderBatchMeta(batch)
  }

  // Read at call time, because a retry gives the batch a new controller.
  const sig = (): AbortSignal => batch.controller.signal
  const tasks: Promise<void>[] = []

  if (model.family === 'gemini') {
    const runOne = (i: number): Promise<void> => {
      const tile = tiles[i]!
      const signal = sig()
      return withRetry(
        () => runGemini({ modelId, prompt: promptText, refs: sendRefs, ratio, size: geminiSize, thinking: geminiThinking }, signal),
        signal,
        (left) => {
          tile.waiting = left
          renderTileStatus(tile)
        },
      ).then((outcome) => onOutcome(outcome, [i], () => retryTiles(batch, [i], () => runOne(i))))
    }
    for (let i = 0; i < count; i++) tasks.push(runOne(i))
  } else {
    const all = tiles.map((_, i) => i)
    const params = {
      modelId,
      prompt: promptText,
      refs: sendRefs,
      count,
      size: gSize ?? 'auto',
      quality: prefs.gptQuality,
      background: prefs.gptBackground,
      moderation: prefs.gptModeration,
    } as const
    const runBatch = (indexes: number[]): Promise<void> => {
      const signal = sig()
      return withRetry(() => runGpt({ ...params, count: indexes.length }, signal), signal, (left) => {
        for (const i of indexes) {
          tiles[i]!.waiting = left
          renderTileStatus(tiles[i]!)
        }
      }).then((outcome) => onOutcome(outcome, indexes, () => retryTiles(batch, indexes, () => runBatch(indexes))))
    }
    tasks.push(runBatch(all))
  }

  await Promise.all(tasks)
  finishBatch(batch)
}

// Retrying a failed tile reuses the batch, so the result lands where the failure was.
function retryTiles(batch: Batch, indexes: number[], run: () => Promise<void>): void {
  if (running) {
    toast('Wait for the current batch to finish, or stop it.', 'warn')
    return
  }
  if (!vault.hasKey()) {
    pendingAfterKey = () => retryTiles(batch, indexes, run)
    openKeyDialog()
    return
  }
  batch.controller = new AbortController()
  for (const i of indexes) {
    const old = batch.tiles[i]!
    const fresh = makeTile({ w: 1, h: 1 })
    fresh.frame.style.aspectRatio = old.frame.style.aspectRatio
    old.el.replaceWith(fresh.el)
    batch.tiles[i] = fresh
  }
  running = batch
  batch.el.setAttribute('aria-busy', 'true')
  validate()
  void run().then(() => finishBatch(batch))
}

// The run functions read tiles by index from the batch, so a retry swaps the
// array entry above and the closure picks up the fresh tile.
function finishBatch(batch: Batch): void {
  if (running === batch) running = null
  batch.el.setAttribute('aria-busy', 'false')
  renderBatchMeta(batch)
  const off = batch.tiles.filter((t) => t.image && t.image.format !== 'png')
  if (off.length) {
    const kinds = [...new Set(off.map((t) => formatLabel(t.image!.format)))].join(' and ')
    showNote(batch, `${off.length === 1 ? 'One image' : `${off.length} images`} came back as ${kinds}, not the PNG that was requested. The ${off.length === 1 ? 'file is' : 'files are'} kept exactly as sent.`, true)
  }
  validate()
}

function showNote(batch: Batch, text: string, warn = false): void {
  // Parallel Gemini requests often answer with the same line, so each text shows once.
  if ([...batch.note.children].some((c) => c.textContent === text)) return
  const p = h('p', { class: warn ? 'warn' : '' }, warn ? icon('warn', 14) : null, text)
  batch.note.append(p)
  batch.note.hidden = false
}

let creditsWarned = false
function creditsLowNotice(): void {
  if (creditsWarned) return
  creditsWarned = true
  toast('OrcaRouter says your credits are running low.', 'warn')
}

// ---------- dialogs ----------

// Opens with a fade. Closing marks it, waits for the fade, then closes.
function showDialog(d: HTMLDialogElement): void {
  d.classList.remove('closing')
  if (!d.open) d.showModal()
}

function closeDialog(d: HTMLDialogElement): void {
  if (!d.open || d.classList.contains('closing')) return
  d.classList.add('closing')
  const done = (): void => {
    d.classList.remove('closing')
    d.close()
  }
  const reduce = root.dataset.motion === 'reduce' || window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (reduce) done()
  else window.setTimeout(done, 130)
}

function wireDialog(d: HTMLDialogElement): void {
  d.addEventListener('cancel', (e) => {
    e.preventDefault()
    closeDialog(d)
  })
  // Close on a click that both starts and ends on the backdrop.
  let downOnBackdrop = false
  d.addEventListener('pointerdown', (e) => (downOnBackdrop = e.target === d))
  d.addEventListener('click', (e) => {
    if (downOnBackdrop && e.target === d) closeDialog(d)
    downOnBackdrop = false
  })
}

// ---------- key dialog ----------

const keyDialog = h('dialog', { class: 'dialog', id: 'key-dialog', 'aria-labelledby': 'key-title' })
wireDialog(keyDialog)
keyDialog.addEventListener('close', () => {
  wipeSecretFields()
  pendingAfterKey = null
})

const secretInputs: HTMLInputElement[] = []

// Attributes that keep password managers and autofill away from the key, so a
// shared computer's browser never offers to save it.
function secretInput(id: string, placeholder: string, autocomplete = 'off'): HTMLInputElement {
  const input = h('input', {
    id,
    type: 'password',
    class: 'input mono',
    autocomplete,
    autocapitalize: 'off',
    autocorrect: 'off',
    spellcheck: 'false',
    placeholder,
    'data-secret': '',
    'data-1p-ignore': '',
    'data-lpignore': 'true',
    'data-bwignore': '',
    'data-form-type': 'other',
  })
  secretInputs.push(input)
  return input
}

function wipeSecretFields(): void {
  for (const i of secretInputs) {
    i.value = ''
    i.type = 'password'
  }
}

function revealToggle(input: HTMLInputElement): HTMLButtonElement {
  const b = iconButton('eye', 'Show', () => {
    const show = input.type === 'password'
    input.type = show ? 'text' : 'password'
    b.replaceChildren(icon(show ? 'eyeOff' : 'eye'))
    b.setAttribute('aria-label', show ? 'Hide' : 'Show')
    b.title = show ? 'Hide' : 'Show'
  }, 'icon-btn reveal')
  b.setAttribute('aria-controls', input.id)
  return b
}

function idleText(): string {
  const m = vault.getIdleMinutes()
  return m > 0 ? `It locks itself after ${m} minutes without activity.` : 'Auto-lock is off, so it stays until you lock it or close the tab.'
}

function openKeyDialog(): void {
  wipeSecretFields()
  secretInputs.length = 0
  clear(keyDialog)
  if (vault.hasKey()) renderKeyActive()
  else renderKeyEntry()
  showDialog(keyDialog)
}

function dialogHead(title: string, onClose: () => void): HTMLElement {
  return h('div', { class: 'dialog-head' }, h('h2', { id: 'key-title', class: 'dialog-title' }, title), iconButton('x', 'Close', onClose))
}

function renderKeyActive(): void {
  const saved = vault.hasSavedKey()
  append(
    keyDialog,
    dialogHead('API key', () => closeDialog(keyDialog)),
    h('div', { class: 'dialog-body' },
      h('p', {}, 'Your key is loaded in this tab. ', idleText()),
      saved ? h('p', { class: 'hint' }, 'An encrypted copy is also saved on this device.') : null,
    ),
    h('div', { class: 'dialog-actions' },
      saved ? button('Remove saved copy', { class: 'ghost danger' }, () => {
        vault.forgetSaved()
        openKeyDialog()
      }) : null,
      button('Lock now', { class: 'primary' }, () => {
        vault.lock()
        closeDialog(keyDialog)
      }),
    ),
  )
}

function renderKeyEntry(): void {
  const saved = vault.hasSavedKey()
  const remember = vault.canRemember()

  const keyInput = secretInput('api-key', 'sk-orca-...')
  const keyMsg = h('p', { class: 'hint', id: 'api-key-msg' })
  keyInput.setAttribute('aria-describedby', 'api-key-msg')

  const passA = secretInput('passphrase', 'At least 10 characters', 'new-password')
  const passB = secretInput('passphrase-2', 'Type it again', 'new-password')
  const passMsg = h('p', { class: 'hint warn', hidden: true })

  const modeMemory = h('input', { type: 'radio', name: 'key-mode', id: 'mode-memory', value: 'memory', checked: true })
  const modeSave = h('input', { type: 'radio', name: 'key-mode', id: 'mode-save', value: 'save', disabled: !remember })
  const savePanel = h('div', { class: 'save-panel', hidden: true },
    field('Passphrase', h('div', { class: 'secret-row' }, passA, revealToggle(passA)), undefined, 'passphrase'),
    field('Confirm passphrase', h('div', { class: 'secret-row' }, passB, revealToggle(passB)), undefined, 'passphrase-2'),
    passMsg,
    h('p', { class: 'hint' }, 'The passphrase is never stored. If you forget it, remove the saved key and enter the API key again.'),
  )
  const syncMode = (): void => {
    savePanel.hidden = !modeSave.checked
  }
  modeMemory.addEventListener('change', syncMode)
  modeSave.addEventListener('change', syncMode)

  const submitBtn = button('Use key', { class: 'primary' })
  const working = (on: boolean, text: string): void => {
    submitBtn.disabled = on
    submitBtn.textContent = on ? text : 'Use key'
  }

  const submit = async (): Promise<void> => {
    const check = vault.checkKey(keyInput.value)
    if (!check.ok) {
      keyMsg.textContent = check.error
      keyMsg.classList.add('warn')
      keyInput.focus()
      return
    }
    if (modeSave.checked) {
      if (passA.value.length < vault.MIN_PASSPHRASE) {
        passMsg.hidden = false
        passMsg.textContent = `Use at least ${vault.MIN_PASSPHRASE} characters. A short passphrase can be guessed by anyone who copies the saved data.`
        passA.focus()
        return
      }
      if (passA.value !== passB.value) {
        passMsg.hidden = false
        passMsg.textContent = 'The two passphrases do not match.'
        passB.focus()
        return
      }
      working(true, 'Encrypting')
      try {
        await vault.saveEncrypted(check.key, passA.value)
      } catch {
        working(false, '')
        passMsg.hidden = false
        passMsg.textContent = 'Could not save on this device. The key was not stored.'
        return
      }
    }
    // The fields are emptied before anything else happens with the key.
    wipeSecretFields()
    vault.useKey(check.key)
    const next = pendingAfterKey
    pendingAfterKey = null
    closeDialog(keyDialog)
    if (check.warning) toast(check.warning, 'warn')
    next?.()
  }
  submitBtn.addEventListener('click', () => void submit())
  for (const i of [keyInput, passA, passB]) {
    i.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        void submit()
      }
    })
  }

  const body = h('div', { class: 'dialog-body' })

  if (saved) {
    const unlockInput = secretInput('unlock-pass', 'Passphrase', 'current-password')
    const unlockMsg = h('p', { class: 'hint warn', hidden: true })
    const unlockBtn = button('Unlock', { class: 'primary' })
    const unlock = async (): Promise<void> => {
      if (!unlockInput.value) return
      unlockBtn.disabled = true
      unlockBtn.textContent = 'Unlocking'
      try {
        const key = await vault.unlockSaved(unlockInput.value)
        wipeSecretFields()
        vault.useKey(key)
        const next = pendingAfterKey
        pendingAfterKey = null
        closeDialog(keyDialog)
        next?.()
      } catch (e) {
        unlockMsg.hidden = false
        unlockMsg.textContent = e instanceof Error ? e.message : 'Could not unlock.'
        unlockInput.select()
      } finally {
        unlockBtn.disabled = false
        unlockBtn.textContent = 'Unlock'
      }
    }
    unlockBtn.addEventListener('click', () => void unlock())
    unlockInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        void unlock()
      }
    })
    append(
      body,
      h('div', { class: 'unlock-box' },
        field('Unlock the key saved on this device', h('div', { class: 'secret-row' }, unlockInput, revealToggle(unlockInput), unlockBtn), undefined, 'unlock-pass'),
        unlockMsg,
        button('Remove saved key from this device', { class: 'link danger' }, () => {
          vault.forgetSaved()
          openKeyDialog()
        }),
      ),
      h('p', { class: 'divider' }, h('span', {}, 'or enter a key')),
    )
  }

  append(
    body,
    field('OrcaRouter API key', h('div', { class: 'secret-row' }, keyInput, revealToggle(keyInput)), keyMsg, 'api-key'),
    h('fieldset', { class: 'modes' },
      h('legend', { class: 'label' }, 'Where to keep it'),
      h('label', { class: 'mode', for: 'mode-memory' }, modeMemory, h('span', {},
        h('strong', {}, 'This tab only'),
        h('span', { class: 'mode-text' }, 'Held in memory. Gone when you reload or close the tab. Use this on public or shared computers.'),
      )),
      h('label', { class: `mode${remember ? '' : ' disabled'}`, for: 'mode-save' }, modeSave, h('span', {},
        h('strong', {}, 'Remember on this device'),
        h('span', { class: 'mode-text' }, remember
          ? 'Saved encrypted with a passphrase you choose. Only on your own computer.'
          : 'Unavailable here: this needs an https page and working site storage.'),
      )),
    ),
    savePanel,
    h('p', { class: 'hint' }, idleText(), ' The key is sent only to api.orcarouter.ai, straight from this browser. This page has no server of its own.'),
  )
  keyMsg.textContent = 'Find it in the OrcaRouter console under API keys.'

  append(
    keyDialog,
    dialogHead(saved ? 'Unlock your key' : 'Add your API key', () => closeDialog(keyDialog)),
    body,
    h('div', { class: 'dialog-actions' }, button('Cancel', { class: 'ghost' }, () => closeDialog(keyDialog)), submitBtn),
  )
  window.setTimeout(() => (saved ? document.getElementById('unlock-pass') : keyInput)?.focus(), 30)
}

// ---------- settings dialog ----------

const settingsDialog = h('dialog', { class: 'dialog', id: 'settings-dialog', 'aria-labelledby': 'settings-title' })
wireDialog(settingsDialog)

function openSettings(): void {
  clear(settingsDialog)
  const theme = segmented('Theme', [{ value: 'dark', text: 'Dark' }, { value: 'light', text: 'Light' }] as const, prefs.theme, (v) => {
    prefs.theme = v
    persist()
    applyTheme()
    renderThemeBtn()
  })
  const motion = segmented('Motion', [{ value: 'system', text: 'Match device' }, { value: 'reduce', text: 'Reduce' }] as const, prefs.motion, (v) => {
    prefs.motion = v
    persist()
    applyMotion()
  })
  const idle = select(
    'idle-select',
    IDLE_CHOICES.map((m) => ({ value: m, text: m === 0 ? 'Never (own device only)' : `After ${m} minutes idle` })),
    prefs.idleMinutes,
    (v) => {
      prefs.idleMinutes = v
      persist()
      vault.setIdleMinutes(v)
    },
  )
  append(
    settingsDialog,
    h('div', { class: 'dialog-head' }, h('h2', { id: 'settings-title', class: 'dialog-title' }, 'Settings'), iconButton('x', 'Close', () => closeDialog(settingsDialog))),
    h('div', { class: 'dialog-body' },
      field('Theme', theme.el),
      field('Motion', motion.el, 'Reduce turns off the loading sweep and dialog fades.'),
      field('Lock the key', idle, 'Locking clears the key from memory. A saved key needs its passphrase again.', 'idle-select'),
      h('div', { class: 'danger-zone' },
        h('p', { class: 'label' }, 'Done on a shared computer?'),
        h('p', { class: 'hint' }, 'Clears the key from memory, the prompt, reference images and all results in this tab. Then close the tab.'),
        button('Clear this session', { class: 'ghost danger' }, () => {
          clearSession()
          closeDialog(settingsDialog)
        }),
        vault.hasSavedKey() ? button('Remove saved key from this device', { class: 'link danger' }, () => {
          vault.forgetSaved()
          openSettings()
        }) : null,
      ),
    ),
  )
  showDialog(settingsDialog)
}

function clearSession(): void {
  running?.controller.abort()
  vault.lock()
  wipeSecretFields()
  prompt = ''
  promptBox.value = ''
  for (const r of refs) releaseRef(r)
  refs = []
  for (const b of [...batches]) removeBatch(b)
  if (viewer.open) viewer.close()
  renderRefs()
  validate()
  toast('Session cleared.')
}

// ---------- viewer ----------

const viewer = h('dialog', { class: 'dialog viewer', id: 'viewer', 'aria-label': 'Image viewer' })
wireDialog(viewer)

function openViewer(batch: Batch, tile: Tile, index: number, text: string): void {
  const img = tile.image
  if (!img) return
  clear(viewer)
  const actions = h('div', { class: 'viewer-actions' })
  if (img.blob) {
    actions.append(
      h('a', { class: 'primary small', href: img.url, download: filename(batch, index, img.format) }, icon('download', 16), 'Download'),
      button(h('span', {}, 'Use as reference'), { class: 'ghost small' }, () => {
        void useAsRef(img.blob!, index)
        closeDialog(viewer)
      }),
    )
  }
  const details = h('div', { class: 'viewer-meta' },
    formatBadge(img.format),
    h('span', { class: 'mono' }, img.width ? `${img.width}x${img.height}` : ''),
    h('span', {}, batch.modelName),
  )
  append(
    viewer,
    h('div', { class: 'viewer-stage' }, h('img', { src: img.url, alt: `Generated image ${index + 1}`, referrerpolicy: 'no-referrer' })),
    h('div', { class: 'viewer-bar' },
      details,
      actions,
      iconButton('x', 'Close', () => closeDialog(viewer)),
    ),
    img.revisedPrompt ? h('p', { class: 'viewer-text' }, h('strong', {}, 'Revised prompt: '), img.revisedPrompt) : null,
    text ? h('p', { class: 'viewer-text' }, h('strong', {}, 'Model note: '), text) : null,
  )
  showDialog(viewer)
}

// ---------- mount ----------

const app = document.getElementById('app')
if (!app) throw new Error('Missing #app')

// Static hosts such as GitHub Pages cannot send frame-ancestors, and a meta tag
// cannot set it, so the page refuses to run inside another site's frame. That
// stops a page from overlaying fake controls on top of this one.
let framed = true
try {
  framed = window.top !== window.self
} catch {
  framed = true
}
if (framed) {
  app.replaceChildren(h('p', { class: 'noscript' }, 'Darkroom does not run inside other pages. Open it in its own tab.'))
  throw new Error('Refusing to run in a frame')
}

app.replaceChildren(topbar, h('main', { class: 'layout' }, rail, results))
document.body.append(keyDialog, settingsDialog, viewer, toastRegion)

renderThemeBtn()
renderKeyPill()
renderModels()
renderRefs()
renderShape()
renderOptions()
validate()

vault.onVaultChange(() => {
  renderKeyPill()
  if (!vault.hasKey() && keyDialog.open && !keyDialog.classList.contains('closing')) openKeyDialog()
})

// Activity pushes the auto-lock back, at most every few seconds.
let lastTouch = 0
const activity = (): void => {
  const now = Date.now()
  if (now - lastTouch < 5000) return
  lastTouch = now
  vault.touch()
}
document.addEventListener('pointerdown', activity, { passive: true })
document.addEventListener('keydown', activity, { passive: true })

// Leaving the page wipes the key, so the back button cannot restore it from the
// back-forward cache on a shared computer.
window.addEventListener('pagehide', () => {
  vault.lock()
  wipeSecretFields()
})

// One clock drives every moving figure: elapsed time, retry countdowns, the lock countdown.
window.setInterval(() => {
  if (vault.hasKey()) renderKeyPill()
  for (const b of batches) {
    if (b.tiles.some((t) => !t.done)) {
      for (const t of b.tiles) renderTileStatus(t)
    }
  }
}, 1000)
