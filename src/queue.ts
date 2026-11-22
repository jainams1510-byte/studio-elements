import { getDb } from './db'
import type { OutboxEntry, PhotoRow, Remote } from './types'

export type SyncResult = { uploaded: number; failed: number }

function notify(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('outbox-changed'))
}

function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false
}

/**
 * Save a log on the phone. The entry is read back before we report success,
 * because some phone browsers drop a write without raising an error.
 */
export async function saveLog(entry: OutboxEntry): Promise<void> {
  const db = await getDb()
  await db.put('outbox', entry)
  const back = (await db.get('outbox', entry.id)) as OutboxEntry | undefined
  const intact =
    back !== undefined &&
    back.photos.length === entry.photos.length &&
    (back.audio !== null) === (entry.audio !== null)
  if (!intact) {
    throw new Error('This log could not be saved on the phone. Please try again.')
  }
  notify()
}

export async function listOutbox(): Promise<OutboxEntry[]> {
  const db = await getDb()
  const all = (await db.getAll('outbox')) as OutboxEntry[]
  return all.sort((a, b) => a.loggedAt.localeCompare(b.loggedAt))
}

export async function countOutbox(): Promise<number> {
  const db = await getDb()
  return db.count('outbox')
}

/** Where each file of a log lives on the server. Fixed, so a retry overwrites itself. */
export function photoPath(entry: OutboxEntry, photoId: string, ext: string): string {
  return `${entry.projectId}/${entry.id}/${photoId}.${ext}`
}
export function audioPath(entry: OutboxEntry, ext: string): string {
  return `${entry.projectId}/${entry.id}/voice.${ext}`
}

async function uploadEntry(remote: Remote, entry: OutboxEntry): Promise<void> {
  const photoRows: PhotoRow[] = []
  for (const photo of entry.photos) {
    const path = photoPath(entry, photo.id, photo.ext)
    await remote.uploadFile(path, photo.blob, photo.mime)
    photoRows.push({ id: photo.id, log_id: entry.id, path })
  }
  let voice: string | null = null
  if (entry.audio) {
    voice = audioPath(entry, entry.audio.ext)
    await remote.uploadFile(voice, entry.audio.blob, entry.audio.mime)
  }
  // Files first, record last: a log never appears with missing photos.
  await remote.upsertLog({
    id: entry.id,
    project_id: entry.projectId,
    room: entry.room,
    trade: entry.trade,
    note: entry.note,
    audio_path: voice,
    logged_at: entry.loggedAt,
  })
  if (photoRows.length > 0) await remote.upsertPhotos(photoRows)
}

async function run(remote: Remote): Promise<SyncResult> {
  const db = await getDb()
  const entries = await listOutbox()
  let uploaded = 0
  let failed = 0
  for (const entry of entries) {
    try {
      await uploadEntry(remote, entry)
      // Removed from the phone only after the server has accepted everything.
      await db.delete('outbox', entry.id)
      uploaded += 1
      // Transcription runs on the server and can take a minute: start it, don't wait for it.
      if (entry.audio && remote.requestTranscript) {
        remote.requestTranscript(entry.id).catch(() => undefined)
      }
    } catch (err) {
      failed += 1
      const message = err instanceof Error ? err.message : String(err)
      await db.put('outbox', { ...entry, attempts: entry.attempts + 1, lastError: message })
      if (isOffline()) break
    }
  }
  notify()
  return { uploaded, failed }
}

let running: Promise<SyncResult> | null = null

/** Upload everything waiting. Calls made while one is running share its result. */
export function syncOutbox(remote: Remote): Promise<SyncResult> {
  if (!running) {
    running = run(remote).finally(() => {
      running = null
    })
  }
  return running
}
