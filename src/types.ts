export type Project = {
  id: string
  name: string
  code: string | null
  stage: number
  rooms: string[]
  trades: string[]
  archived: boolean
}

export type OutboxPhoto = { id: string; blob: Blob; mime: string; ext: string }
export type OutboxAudio = { blob: Blob; mime: string; ext: string }

/** One site log waiting on the phone until it has been uploaded. */
export type OutboxEntry = {
  id: string
  projectId: string
  room: string | null
  trade: string | null
  note: string
  loggedAt: string
  photos: OutboxPhoto[]
  audio: OutboxAudio | null
  attempts: number
  lastError: string | null
}

export type LogRow = {
  id: string
  project_id: string
  room: string | null
  trade: string | null
  note: string
  audio_path: string | null
  logged_at: string
}

export type PhotoRow = { id: string; log_id: string; path: string }

/** The server, reduced to the three calls the upload queue needs. */
export type Remote = {
  uploadFile(path: string, blob: Blob, mime: string): Promise<void>
  upsertLog(row: LogRow): Promise<void>
  upsertPhotos(rows: PhotoRow[]): Promise<void>
}

export const STAGES = [
  'Concept',
  'Design development',
  'Working drawings',
  'BOQ and tendering',
  'Procurement',
  'Execution',
  'Snagging',
  'Handover',
] as const
