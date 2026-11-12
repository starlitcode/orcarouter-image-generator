// Reference images: read, check, and scale down before upload.
// Gemini bills a flat 1120 tokens per input image whatever its size, and both
// providers downscale large inputs themselves, so sending more than 2048px on
// the long side only makes the upload slower.

export const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const
const MAX_LONG_EDGE = 2048
// Gemini's inline limit per file is 7 MB.
const MAX_UPLOAD_BYTES = 7 * 1024 * 1024
const MAX_SOURCE_BYTES = 50 * 1024 * 1024

export interface RefImage {
  id: string
  name: string
  blob: Blob
  url: string
  width: number
  height: number
}

let counter = 0
// crypto.randomUUID is missing outside secure contexts, and these ids only need
// to be unique within the page.
const nextId = (): string => `ref-${Date.now().toString(36)}-${(counter++).toString(36)}`

const isAccepted = (type: string): boolean => (ACCEPTED_TYPES as readonly string[]).includes(type)

export class RefError extends Error {}

async function decode(file: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    throw new RefError('could not be read as an image')
  }
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new RefError('could not be re-encoded'))), type, quality)
  })
}

export async function prepareRef(file: Blob, name: string): Promise<RefImage> {
  if (!isAccepted(file.type)) throw new RefError('is not a PNG, JPEG or WebP image')
  if (file.size > MAX_SOURCE_BYTES) throw new RefError('is larger than 50 MB')

  const bitmap = await decode(file)
  const { width, height } = bitmap
  const long = Math.max(width, height)

  if (long <= MAX_LONG_EDGE && file.size <= MAX_UPLOAD_BYTES) {
    bitmap.close()
    return { id: nextId(), name, blob: file, url: URL.createObjectURL(file), width, height }
  }

  const scale = Math.min(1, MAX_LONG_EDGE / long)
  const w = Math.max(1, Math.round(width * scale))
  const h = Math.max(1, Math.round(height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new RefError('could not be resized on this device')
  ctx.drawImage(bitmap, 0, 0, w, h)
  bitmap.close()

  // Keep PNG and WebP as they are so transparency survives. JPEG stays JPEG.
  let blob = await canvasToBlob(canvas, file.type, file.type === 'image/png' ? undefined : 0.92)
  if (blob.size > MAX_UPLOAD_BYTES) blob = await canvasToBlob(canvas, 'image/jpeg', 0.88)
  return { id: nextId(), name, blob, url: URL.createObjectURL(blob), width: w, height: h }
}

export function releaseRef(ref: RefImage): void {
  URL.revokeObjectURL(ref.url)
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new RefError('could not be read'))
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : '')
    }
    reader.readAsDataURL(blob)
  })
}

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/

export type OutFormat = 'png' | 'jpeg' | 'webp' | 'gif' | 'avif' | 'unknown'

// The format is read from the file's own first bytes, never from the type the
// response declares, so a JPEG labeled as PNG is still reported as a JPEG.
export function sniffFormat(b: Uint8Array): OutFormat {
  const at = (i: number, ...bytes: number[]): boolean => bytes.every((v, k) => b[i + k] === v)
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'png'
  if (at(0, 0xff, 0xd8, 0xff)) return 'jpeg'
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'webp'
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'gif'
  if (at(4, 0x66, 0x74, 0x79, 0x70) && (at(8, 0x61, 0x76, 0x69, 0x66) || at(8, 0x61, 0x76, 0x69, 0x73))) return 'avif'
  return 'unknown'
}

const MIME: Record<OutFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
  unknown: 'application/octet-stream',
}

const EXT: Record<OutFormat, string> = { png: 'png', jpeg: 'jpg', webp: 'webp', gif: 'gif', avif: 'avif', unknown: 'bin' }

export const formatLabel = (f: OutFormat): string => (f === 'unknown' ? 'an unknown format' : f.toUpperCase())
export const extensionForFormat = (f: OutFormat): string => EXT[f]

export interface DecodedImage {
  blob: Blob
  format: OutFormat
}

// The bytes are kept exactly as they arrived. Nothing is re-encoded.
export function base64ToImage(data: string): DecodedImage | null {
  const clean = data.replace(/\s+/g, '')
  if (!clean || !BASE64_RE.test(clean)) return null
  try {
    const bin = atob(clean)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    const format = sniffFormat(bytes)
    return { blob: new Blob([bytes], { type: MIME[format] }), format }
  } catch {
    return null
  }
}

export function extensionFor(type: string): string {
  if (type === 'image/jpeg') return 'jpg'
  if (type === 'image/webp') return 'webp'
  return 'png'
}
