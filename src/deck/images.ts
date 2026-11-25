/** Browser image helpers for the deck and the studio logo. */
import type { Img } from './export'

/** PNG or JPEG from the first bytes (storage may not keep the content type). */
export function sniff(bytes: Uint8Array): 'PNG' | 'JPEG' | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'PNG'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'JPEG'
  return null
}

function toDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error)
    r.readAsDataURL(blob)
  })
}

async function size(blob: Blob): Promise<{ w: number; h: number }> {
  const bmp = await createImageBitmap(blob)
  const out = { w: bmp.width, h: bmp.height }
  bmp.close()
  return out
}

/** Fetch an image (signed URL or app file) as a data URL with its pixel size. Null if it cannot be read. */
export async function loadImage(url: string): Promise<Img | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const buf = new Uint8Array(await res.arrayBuffer())
    let fmt = sniff(buf)
    let blob = new Blob([buf], { type: fmt === 'PNG' ? 'image/png' : fmt === 'JPEG' ? 'image/jpeg' : res.headers.get('content-type') || '' })
    if (!fmt) {
      // Another format the browser can draw (e.g. WebP): redraw it as JPEG for the exports.
      const bmp = await createImageBitmap(blob)
      const c = document.createElement('canvas')
      c.width = bmp.width
      c.height = bmp.height
      const g = c.getContext('2d')
      if (!g) return null
      g.fillStyle = '#fff'
      g.fillRect(0, 0, c.width, c.height)
      g.drawImage(bmp, 0, 0)
      bmp.close()
      const jpeg = await new Promise<Blob | null>((ok) => c.toBlob(ok, 'image/jpeg', 0.85))
      if (!jpeg) return null
      blob = jpeg
      fmt = 'JPEG'
    }
    const { w, h } = await size(blob)
    if (!w || !h) return null
    return { data: await toDataUrl(blob), w, h, fmt }
  } catch {
    return null
  }
}

/** Shrink a logo to a PNG (transparency kept), long edge at most maxDim, as the original did. */
export async function logoPng(file: Blob, maxDim = 1400): Promise<Blob> {
  try {
    const bmp = await createImageBitmap(file)
    const k = Math.min(1, maxDim / Math.max(bmp.width, bmp.height))
    const c = document.createElement('canvas')
    c.width = Math.max(1, Math.round(bmp.width * k))
    c.height = Math.max(1, Math.round(bmp.height * k))
    const g = c.getContext('2d')
    if (!g) throw new Error('no canvas')
    g.drawImage(bmp, 0, 0, c.width, c.height)
    bmp.close()
    const png = await new Promise<Blob | null>((ok) => c.toBlob(ok, 'image/png'))
    if (!png) throw new Error('no png')
    return png
  } catch {
    if (file.type === 'image/png') return file
    throw new Error('This image could not be read. Try a PNG or JPEG.')
  }
}
