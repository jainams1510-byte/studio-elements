/** Shrink a camera photo before it is stored: long edge 1600 px, JPEG. */
export async function compressImage(
  file: Blob,
  maxDim = 1600,
  quality = 0.8,
): Promise<{ blob: Blob; mime: string; ext: string }> {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height))
    const w = Math.max(1, Math.round(bitmap.width * scale))
    const h = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('no canvas')
    ctx.drawImage(bitmap, 0, 0, w, h)
    bitmap.close()
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', quality),
    )
    if (!blob) throw new Error('no blob')
    return { blob, mime: 'image/jpeg', ext: 'jpg' }
  } catch {
    // If the phone cannot shrink it, keep the original rather than lose it.
    const mime = file.type || 'application/octet-stream'
    return { blob: file, mime, ext: extensionFor(mime) }
  }
}

export function extensionFor(mime: string): string {
  const base = mime.split(';')[0].trim().toLowerCase()
  const known: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/heic': 'heic',
    'image/webp': 'webp',
    'audio/webm': 'webm',
    'audio/mp4': 'm4a',
    'audio/ogg': 'ogg',
    'audio/aac': 'aac',
  }
  return known[base] ?? 'bin'
}

/** The audio format this phone can record. iPhones and Android differ. */
export function pickAudioMime(): string | null {
  if (typeof MediaRecorder === 'undefined') return null
  const candidates = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg']
  return candidates.find((c) => MediaRecorder.isTypeSupported(c)) ?? ''
}
