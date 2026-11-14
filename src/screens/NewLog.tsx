import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { cacheGet } from '../db'
import { go, useOnline } from '../hooks'
import { compressImage, extensionFor, pickAudioMime } from '../media'
import { saveLog, syncOutbox } from '../queue'
import { remote } from '../supabase'
import type { OutboxAudio, OutboxPhoto, Project } from '../types'

const LAST_PROJECT = 'studio.lastProject'

type Shot = OutboxPhoto & { preview: string }

export default function NewLog({ outbox, offlineOnly = false }: { outbox: number; offlineOnly?: boolean }) {
  const online = useOnline()
  const [projects, setProjects] = useState<Project[]>([])
  const [projectId, setProjectId] = useState(localStorage.getItem(LAST_PROJECT) ?? '')
  const [shots, setShots] = useState<Shot[]>([])
  const [audio, setAudio] = useState<OutboxAudio | null>(null)
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const [recording, setRecording] = useState(false)
  const [seconds, setSeconds] = useState(0)
  const [room, setRoom] = useState<string | null>(null)
  const [trade, setTrade] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const recorder = useRef<MediaRecorder | null>(null)
  const chunks = useRef<Blob[]>([])
  const timer = useRef<number | null>(null)

  // The project list comes from the phone's own copy, so it works with no signal.
  useEffect(() => {
    cacheGet<Project[]>('projects').then((cached) => {
      if (!cached) return
      setProjects(cached)
      setProjectId((current) => (cached.some((p) => p.id === current) ? current : (cached[0]?.id ?? '')))
    })
  }, [])

  useEffect(() => {
    return () => {
      if (timer.current !== null) window.clearInterval(timer.current)
      recorder.current?.stream.getTracks().forEach((t) => t.stop())
    }
  }, [])

  const project = projects.find((p) => p.id === projectId)

  async function addPhotos(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    e.target.value = ''
    const added: Shot[] = []
    for (const file of files) {
      const { blob, mime, ext } = await compressImage(file)
      added.push({ id: crypto.randomUUID(), blob, mime, ext, preview: URL.createObjectURL(blob) })
    }
    setShots((current) => [...current, ...added])
  }

  function removePhoto(id: string) {
    setShots((current) => current.filter((s) => s.id !== id))
  }

  async function startRecording() {
    setError(null)
    const mime = pickAudioMime()
    if (mime === null) {
      setError('This phone cannot record sound in the browser. Type a line instead.')
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream)
      chunks.current = []
      rec.ondataavailable = (ev) => {
        if (ev.data.size > 0) chunks.current.push(ev.data)
      }
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop())
        const type = rec.mimeType || mime || 'audio/webm'
        const blob = new Blob(chunks.current, { type })
        setAudio({ blob, mime: type, ext: extensionFor(type) })
        setAudioUrl(URL.createObjectURL(blob))
      }
      rec.start()
      recorder.current = rec
      setSeconds(0)
      setRecording(true)
      timer.current = window.setInterval(() => setSeconds((s) => s + 1), 1000)
    } catch {
      setError('The microphone is blocked. Allow it for this app, or type a line instead.')
    }
  }

  function stopRecording() {
    recorder.current?.stop()
    if (timer.current !== null) window.clearInterval(timer.current)
    timer.current = null
    setRecording(false)
  }

  function clearAudio() {
    setAudio(null)
    setAudioUrl(null)
  }

  async function save() {
    if (!projectId) {
      setError('Choose a project first.')
      return
    }
    if (shots.length === 0 && !audio && note.trim() === '') {
      setError('Add a photo, a voice note or a line before saving.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await saveLog({
        id: crypto.randomUUID(),
        projectId,
        room,
        trade,
        note: note.trim(),
        loggedAt: new Date().toISOString(),
        photos: shots.map(({ id, blob, mime, ext }) => ({ id, blob, mime, ext })),
        audio,
        attempts: 0,
        lastError: null,
      })
      localStorage.setItem(LAST_PROJECT, projectId)
      if (navigator.onLine && !offlineOnly) void syncOutbox(remote)
      if (offlineOnly) {
        // Stay on this screen: clear it for the next log.
        setShots([])
        clearAudio()
        setRoom(null)
        setTrade(null)
        setNote('')
        setSaved(true)
      } else {
        go('/')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'This log could not be saved. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`

  return (
    <main className="screen log">
      <header className="topbar line">
        <div className="inline">
          {!offlineOnly && (
            <button type="button" className="icon" aria-label="Close" onClick={() => go('/')}>
              <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
                <path d="M6 6l12 12" />
                <path d="M18 6L6 18" />
              </svg>
            </button>
          )}
          <h1 className="h2">Site log</h1>
        </div>
        <label className="select">
          <span className="sr">Project</span>
          <select value={projectId} onChange={(e) => { setProjectId(e.target.value); setRoom(null); setTrade(null) }}>
            {projects.length === 0 && <option value="">No projects on this phone</option>}
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      </header>

      {!online && <p className="notice">No signal. This log is saved on the phone and uploads when you reopen the app online.</p>}
      {saved && <p className="notice">Saved on this phone.</p>}

      <section>
        <h2>Photos</h2>
        <div className="photos">
          <label className="tile add">
            <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 8h3l2-3h6l2 3h3v11H4z" />
              <circle cx="12" cy="13" r="3.5" />
            </svg>
            <span>Take photo</span>
            <input type="file" accept="image/*" capture="environment" multiple onChange={addPhotos} className="sr" />
          </label>
          {shots.map((s, i) => (
            <div key={s.id} className="tile">
              <img src={s.preview} alt={`Photo ${i + 1}`} />
              <button type="button" className="remove" aria-label={`Remove photo ${i + 1}`} onClick={() => removePhoto(s.id)}>
                <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <path d="M6 6l12 12" />
                  <path d="M18 6L6 18" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      </section>

      <section className="voice">
        <button
          type="button"
          className={recording ? 'mic live' : 'mic'}
          aria-label={recording ? 'Stop recording' : 'Record a voice note'}
          onClick={recording ? stopRecording : startRecording}
        >
          {recording ? (
            <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
              <rect x="7" y="7" width="10" height="10" rx="1.5" />
            </svg>
          ) : (
            <svg aria-hidden="true" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="3" width="6" height="11" rx="3" />
              <path d="M5 11a7 7 0 0 0 14 0" />
              <path d="M12 18v3" />
            </svg>
          )}
        </button>
        <div className="voice-text">
          {recording ? (
            <>
              <strong>Recording {clock}</strong>
              <span className="muted small">Tap to stop</span>
            </>
          ) : audio && audioUrl ? (
            <>
              <audio controls src={audioUrl} />
              <button type="button" className="link" onClick={clearAudio}>
                Remove voice note
              </button>
            </>
          ) : (
            <>
              <strong>Tap to record</strong>
              <span className="muted small">Speak in Hindi or Gujarati</span>
            </>
          )}
        </div>
      </section>

      {project && project.rooms.length > 0 && (
        <section>
          <h2>Room</h2>
          <div className="chips">
            {project.rooms.map((r) => (
              <button key={r} type="button" aria-pressed={room === r} className={room === r ? 'chip on' : 'chip'} onClick={() => setRoom(room === r ? null : r)}>
                {r}
              </button>
            ))}
          </div>
        </section>
      )}

      {project && project.trades.length > 0 && (
        <section>
          <h2>Trade</h2>
          <div className="chips">
            {project.trades.map((t) => (
              <button key={t} type="button" aria-pressed={trade === t} className={trade === t ? 'chip on' : 'chip'} onClick={() => setTrade(trade === t ? null : t)}>
                {t}
              </button>
            ))}
          </div>
        </section>
      )}

      <label className="field">
        <span>One line, optional</span>
        <input type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="What happened on site" />
      </label>

      {error && <p className="error" role="alert">{error}</p>}

      <footer className="savebar">
        <button type="button" className="primary" onClick={save} disabled={busy || recording}>
          {busy ? 'Saving' : 'Save log'}
        </button>
        <span className="muted small">
          {outbox === 0 ? 'Nothing waiting to upload' : `${outbox} waiting to upload`}
        </span>
      </footer>
    </main>
  )
}
