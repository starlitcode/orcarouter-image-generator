// Holds the OrcaRouter key.
//
// By default the key exists only in this module's memory. It is never written to
// localStorage, sessionStorage, cookies, the URL, or the DOM, and it is wiped on
// lock, on idle timeout, and on pagehide (so the back button cannot bring back a
// page from the back-forward cache with the key still loaded).
//
// "Remember on this device" stores only ciphertext: AES-GCM with a key derived
// from a passphrase through PBKDF2-SHA-256. The passphrase itself is never stored.

const STORE_KEY = 'orca-ig.vault.v1'
const PBKDF2_ITERATIONS = 600_000
export const MIN_PASSPHRASE = 10
const MAX_KEY_LENGTH = 512

let apiKey: string | null = null
let lockTimer: number | undefined
let lockAt = 0
let idleMinutes = 15
const listeners = new Set<() => void>()

const notify = (): void => listeners.forEach((fn) => fn())

export const onVaultChange = (fn: () => void): (() => void) => {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export interface KeyCheck {
  ok: boolean
  key: string
  error: string
  warning: string
}

// A pasted key often carries a trailing newline or space. Trim those, and refuse
// anything that is not printable ASCII, since it would corrupt the header.
export function checkKey(raw: string): KeyCheck {
  const key = raw.trim()
  const fail = (error: string): KeyCheck => ({ ok: false, key: '', error, warning: '' })
  if (!key) return fail('Paste your OrcaRouter API key.')
  if (key.length > MAX_KEY_LENGTH) return fail('That is far longer than an API key. Check what was pasted.')
  if (/[^\x21-\x7e]/.test(key)) return fail('The key has spaces, line breaks or unusual characters in it. Copy it again from the console.')
  const warning = key.startsWith('sk-orca-') ? '' : 'OrcaRouter keys usually start with sk-orca-. Double check this is the right key.'
  return { ok: true, key, error: '', warning }
}

export const hasKey = (): boolean => apiKey !== null

// Only the request layer calls this, right before building headers.
export function readKey(): string | null {
  if (apiKey !== null) touch()
  return apiKey
}

export function useKey(key: string): void {
  apiKey = key
  touch()
  notify()
}

export function lock(): void {
  apiKey = null
  window.clearTimeout(lockTimer)
  lockTimer = undefined
  lockAt = 0
  notify()
}

export function setIdleMinutes(minutes: number): void {
  idleMinutes = minutes
  if (apiKey !== null) touch()
  notify()
}

export const getIdleMinutes = (): number => idleMinutes

// The lock timer can fire late when a phone has paused the tab, so this checks
// the deadline itself.
export function lockIfExpired(): void {
  if (apiKey !== null && lockAt && Date.now() >= lockAt) lock()
}

// Milliseconds until the key locks itself, or 0 when it never will.
export const msUntilLock = (): number => (lockAt ? Math.max(0, lockAt - Date.now()) : 0)

// Activity pushes the lock back. Called on pointer and key input, throttled by the caller.
export function touch(): void {
  if (apiKey === null) return
  window.clearTimeout(lockTimer)
  if (idleMinutes <= 0) {
    lockAt = 0
    return
  }
  const ms = idleMinutes * 60_000
  lockAt = Date.now() + ms
  lockTimer = window.setTimeout(lock, ms)
}

// ---- encrypted storage ----

interface StoredVault {
  v: 1
  salt: string
  iv: string
  data: string
  iterations: number
}

const subtle: SubtleCrypto | undefined = globalThis.crypto?.subtle

// crypto.subtle exists only on https and localhost. Over plain http on a LAN
// address it is undefined, so the remember option is unavailable there.
export const canRemember = (): boolean => subtle !== undefined && storageWorks()

function storageWorks(): boolean {
  try {
    const probe = '__orca_probe__'
    localStorage.setItem(probe, '1')
    localStorage.removeItem(probe)
    return true
  } catch {
    return false
  }
}

const toB64 = (bytes: Uint8Array): string => {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

const fromB64 = (text: string): Uint8Array<ArrayBuffer> => {
  const s = atob(text)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

async function deriveKey(passphrase: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<CryptoKey> {
  if (!subtle) throw new Error('Encryption is unavailable on this connection.')
  const material = await subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey'])
  return subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

function readStored(): StoredVault | null {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const v = parsed as Record<string, unknown>
    if (v.v !== 1 || typeof v.salt !== 'string' || typeof v.iv !== 'string' || typeof v.data !== 'string') return null
    const iterations = typeof v.iterations === 'number' && v.iterations >= 100_000 ? v.iterations : PBKDF2_ITERATIONS
    return { v: 1, salt: v.salt, iv: v.iv, data: v.data, iterations }
  } catch {
    return null
  }
}

export const hasSavedKey = (): boolean => readStored() !== null

export async function saveEncrypted(key: string, passphrase: string): Promise<void> {
  if (!subtle) throw new Error('Encryption is unavailable on this connection.')
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const aes = await deriveKey(passphrase, salt, PBKDF2_ITERATIONS)
  const data = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, aes, new TextEncoder().encode(key)))
  const record: StoredVault = { v: 1, salt: toB64(salt), iv: toB64(iv), data: toB64(data), iterations: PBKDF2_ITERATIONS }
  localStorage.setItem(STORE_KEY, JSON.stringify(record))
  notify()
}

// Resolves with the key on success. A wrong passphrase makes AES-GCM fail its
// integrity check, which is reported as a plain wrong-passphrase error.
export async function unlockSaved(passphrase: string): Promise<string> {
  const stored = readStored()
  if (!stored) throw new Error('No saved key on this device.')
  if (!subtle) throw new Error('Encryption is unavailable on this connection.')
  const aes = await deriveKey(passphrase, fromB64(stored.salt), stored.iterations)
  let plain: ArrayBuffer
  try {
    plain = await subtle.decrypt({ name: 'AES-GCM', iv: fromB64(stored.iv) }, aes, fromB64(stored.data))
  } catch {
    throw new Error('Wrong passphrase.')
  }
  const key = new TextDecoder().decode(plain)
  const check = checkKey(key)
  if (!check.ok) throw new Error('The saved key is damaged. Remove it and enter the key again.')
  return check.key
}

export function forgetSaved(): void {
  try {
    localStorage.removeItem(STORE_KEY)
  } catch {
    // Storage blocked: there is nothing saved to remove.
  }
  notify()
}
