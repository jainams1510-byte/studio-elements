/**
 * Backup: the free database tier keeps no backups, so an owner downloads one.
 * A backup is a ZIP holding data.json (every table, every row, removed records included)
 * and media/ (every photo, voice note and site-print photo the records point to).
 */
import { strToU8, zip } from 'fflate'
import { MEDIA_BUCKET, supabase } from './supabase'

/** Every table, parents before children, so a restore can load them in this order. */
export const BACKUP_TABLES: { name: string; order: string }[] = [
  { name: 'profiles', order: 'id' },
  { name: 'projects', order: 'id' },
  { name: 'site_logs', order: 'id' },
  { name: 'site_log_photos', order: 'id' },
  { name: 'site_log_ai', order: 'log_id' },
  { name: 'site_log_reviews', order: 'id' },
  { name: 'drawings', order: 'id' },
  { name: 'drawing_revisions', order: 'id' },
  { name: 'drawing_issues', order: 'id' },
  { name: 'weekly_reports', order: 'id' },
  { name: 'project_schedules', order: 'project_id' },
  { name: 'tasks', order: 'id' },
  { name: 'schedule_changes', order: 'id' },
  { name: 'backup_log', order: 'id' },
]

const PAGE = 1000

export type Row = Record<string, unknown>
export type BackupData = {
  format: 'studio-elements-backup'
  version: 1
  exported_at: string
  tables: Record<string, Row[]>
  files: string[]
}

async function fetchAll(table: string, order: string): Promise<Row[]> {
  const rows: Row[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from(table)
      .select('*')
      .order(order)
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`${table}: ${error.message}`)
    rows.push(...((data ?? []) as Row[]))
    if (!data || data.length < PAGE) return rows
  }
}

/** Every stored file a record points to. */
export function referencedFiles(tables: Record<string, Row[]>): string[] {
  const paths = new Set<string>()
  const add = (v: unknown) => {
    if (typeof v === 'string' && v) paths.add(v)
  }
  for (const r of tables.site_logs ?? []) add(r.audio_path)
  for (const r of tables.site_log_photos ?? []) add(r.path)
  for (const r of tables.drawing_issues ?? []) add(r.print_photo_path)
  return [...paths].sort()
}

export async function collectData(onProgress: (text: string) => void = () => {}): Promise<BackupData> {
  const tables: Record<string, Row[]> = {}
  for (const t of BACKUP_TABLES) {
    onProgress(`Reading ${t.name.replace(/_/g, ' ')}`)
    tables[t.name] = await fetchAll(t.name, t.order)
  }
  return {
    format: 'studio-elements-backup',
    version: 1,
    exported_at: new Date().toISOString(),
    tables,
    files: referencedFiles(tables),
  }
}

export function summary(data: BackupData): string {
  const n = (t: string) => data.tables[t]?.length ?? 0
  return `${n('projects')} projects, ${n('site_logs')} logs, ${n('drawings')} sheets, ${n('tasks')} tasks, ${data.files.length} files`
}

function zipAsync(files: Record<string, Uint8Array>): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    // Photos and audio are already compressed; storing them is as small and much faster.
    zip(files, { level: 0 }, (err, out) => (err ? reject(err) : resolve(out)))
  })
}

/** The full backup as a ZIP. Missing files are listed in missing-files.txt instead of failing. */
export async function buildBackupZip(onProgress: (text: string) => void = () => {}): Promise<{ blob: Blob; data: BackupData; missing: string[] }> {
  const data = await collectData(onProgress)
  const entries: Record<string, Uint8Array> = {}
  const missing: string[] = []
  for (let i = 0; i < data.files.length; i++) {
    const path = data.files[i]
    onProgress(`Downloading file ${i + 1} of ${data.files.length}`)
    const { data: blob, error } = await supabase.storage.from(MEDIA_BUCKET).download(path)
    if (error || !blob) {
      missing.push(path)
      continue
    }
    entries[`media/${path}`] = new Uint8Array(await blob.arrayBuffer())
  }
  entries['data.json'] = strToU8(JSON.stringify(data, null, 1))
  if (missing.length) entries['missing-files.txt'] = strToU8(missing.join('\n') + '\n')
  entries['README.txt'] = strToU8(
    [
      'Studio Elements backup',
      `Made ${data.exported_at}`,
      summary(data),
      '',
      'data.json holds every table and row, removed records included.',
      'media/ holds the photos, voice notes and site-print photos, under the same paths as in storage.',
      'To check or restore: scripts/restore_check.py in the app repository.',
      '',
    ].join('\n'),
  )
  onProgress('Packing')
  const bytes = await zipAsync(entries)
  return { blob: new Blob([bytes.buffer as ArrayBuffer], { type: 'application/zip' }), data, missing }
}

export function backupFileName(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `studio-elements-backup-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}.zip`
}

/** Save a file: the download prompt on a laptop, the share sheet where downloads don't work. */
export async function saveFile(blob: Blob, name: string): Promise<void> {
  const file = new File([blob], name, { type: blob.type })
  const standaloneIos = /iPhone|iPad/.test(navigator.userAgent) && window.matchMedia('(display-mode: standalone)').matches
  if (standaloneIos && navigator.canShare?.({ files: [file] })) {
    await navigator.share({ files: [file], title: name })
    return
  }
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/** When the last backup was made, by anyone. Null if never (or if it can't be read). */
export async function lastBackup(): Promise<{ made_at: string; summary: string } | null> {
  const { data } = await supabase.from('backup_log').select('made_at, summary').order('made_at', { ascending: false }).limit(1)
  return (data?.[0] as { made_at: string; summary: string } | undefined) ?? null
}

export async function recordBackup(data: BackupData, missing: number): Promise<void> {
  const { error } = await supabase.from('backup_log').insert({ summary: summary(data), files: data.files.length - missing, missing })
  if (error) throw new Error(error.message)
}

export const BACKUP_EVERY_DAYS = 7
