import { useEffect, useState } from 'react'
import { backupFileName, buildBackupZip, lastBackup, recordBackup, saveFile, summary } from '../backup'

const when = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })

/** Owners only: download everything, because the free database tier keeps no backups. */
export default function BackupCard() {
  const [last, setLast] = useState<{ made_at: string; summary: string } | null | undefined>(undefined)
  const [progress, setProgress] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    lastBackup().then(setLast, () => setLast(null))
  }, [])

  async function run() {
    setError(null)
    setDone(null)
    setProgress('Starting')
    try {
      const { blob, data, missing } = await buildBackupZip(setProgress)
      setProgress('Saving')
      await saveFile(blob, backupFileName())
      try {
        await recordBackup(data, missing.length)
      } catch {
        // The file is the backup; failing to note it down is not worth alarming anyone.
      }
      setDone(
        `Saved: ${summary(data)}, ${(blob.size / 1_048_576).toFixed(1)} MB.` +
          (missing.length ? ` ${missing.length} file${missing.length === 1 ? ' was' : 's were'} missing in storage; see missing-files.txt.` : '') +
          ' Put it on the shared drive.',
      )
      setLast({ made_at: new Date().toISOString(), summary: summary(data) })
    } catch (err) {
      setError(navigator.onLine ? (err instanceof Error ? err.message : String(err)) : 'No signal. A backup needs a connection.')
    } finally {
      setProgress(null)
    }
  }

  return (
    <section className="card stack">
      <h2>Backup</h2>
      <p className="small">
        {last === undefined
          ? 'Checking the last backup'
          : last
            ? `Last backup ${when.format(new Date(last.made_at))}: ${last.summary}.`
            : 'No backup yet. The free database keeps none, so make one weekly.'}
      </p>
      <p className="muted small">One ZIP with every record (removed ones too) and every photo and voice note. Best on the laptop; save it to the shared drive.</p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {done && <p className="small">{done}</p>}
      <button type="button" className="secondary" onClick={run} disabled={progress !== null}>
        {progress ?? 'Download backup'}
      </button>
    </section>
  )
}
