import { useCallback, useEffect, useRef, useState } from 'react'
import { editSummary, loadVoiceLogs, review, stateOf, STATE_LABEL, toLite, type VoiceLog } from '../ai'
import { cacheGet } from '../db'
import { stillNeeded } from '../review'
import { callAi, MEDIA_BUCKET, supabase } from '../supabase'
import type { Project } from '../types'

const timeFormat = new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })

export default function Review() {
  const [logs, setLogs] = useState<VoiceLog[]>([])
  const [userId, setUserId] = useState('')
  const [projects, setProjects] = useState<Project[]>([])
  const [audio, setAudio] = useState<Record<string, string>>({})
  const [state, setState] = useState<'loading' | 'ready' | 'offline'>('loading')
  const [working, setWorking] = useState<Record<string, string>>({})
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [showDone, setShowDone] = useState(false)
  const caughtUp = useRef(false)

  const load = useCallback(async () => {
    try {
      const list = await loadVoiceLogs()
      setLogs(list)
      setState('ready')
      const paths = list.map((l) => l.audio_path).filter((p): p is string => Boolean(p))
      if (paths.length) {
        const { data } = await supabase.storage.from(MEDIA_BUCKET).createSignedUrls(paths, 3600)
        const map: Record<string, string> = {}
        for (const s of data ?? []) if (s.path && s.signedUrl) map[s.path] = s.signedUrl
        setAudio(map)
      }
      return list
    } catch {
      setState('offline')
      return []
    }
  }, [])

  const transcribe = useCallback(
    async (id: string, force = false) => {
      setWorking((w) => ({ ...w, [id]: 'Transcribing, this can take a minute' }))
      setErrors((e) => ({ ...e, [id]: '' }))
      try {
        await callAi({ action: 'transcribe', log_id: id, force })
      } catch (err) {
        setErrors((e) => ({ ...e, [id]: err instanceof Error ? err.message : 'Transcription failed' }))
      }
      setWorking((w) => ({ ...w, [id]: '' }))
      await load()
    },
    [load],
  )

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setUserId(data.session?.user.id ?? ''))
    cacheGet<Project[]>('projects').then((p) => setProjects(p ?? []))
    void load().then(async (list) => {
      // Catch up on voice notes that were never sent, a few at a time, one after another.
      if (caughtUp.current) return
      caughtUp.current = true
      const missing = list.filter((l) => stateOf(l) === 'missing').slice(0, 3)
      for (const l of missing) await transcribe(l.id)
    })
  }, [load, transcribe])

  async function decide(id: string, decision: 'confirm' | 'reject') {
    setWorking((w) => ({ ...w, [id]: decision === 'confirm' ? 'Confirming' : 'Rejecting' }))
    try {
      await review(id, userId, decision)
    } catch (err) {
      setErrors((e) => ({ ...e, [id]: err instanceof Error ? err.message : 'Could not save' }))
    }
    setWorking((w) => ({ ...w, [id]: '' }))
    await load()
  }

  async function saveEdit(id: string) {
    setWorking((w) => ({ ...w, [id]: 'Saving' }))
    try {
      await editSummary(id, draft)
      setEditing(null)
    } catch (err) {
      setErrors((e) => ({ ...e, [id]: err instanceof Error ? err.message : 'Could not save' }))
    }
    setWorking((w) => ({ ...w, [id]: '' }))
    await load()
  }

  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? 'Project'
  const open = logs.filter((l) => !['verified', 'rejected'].includes(stateOf(l)))
  const done = logs.filter((l) => ['verified', 'rejected'].includes(stateOf(l)))

  function card(log: VoiceLog) {
    const st = stateOf(log)
    const ai = log.site_log_ai
    const reviews = ai?.site_log_reviews ?? []
    const mine = reviews.find((r) => r.reviewer_id === userId)
    const busy = Boolean(working[log.id])
    return (
      <li key={log.id} className="card stack-tight">
        <div className="card-head">
          <span className={st === 'verified' ? 'tag ok' : st === 'unverified' ? 'tag' : 'tag muted'}>{STATE_LABEL[st]}</span>
          <span className="muted small">
            {projectName(log.project_id)} · {timeFormat.format(new Date(log.logged_at))}
          </span>
        </div>
        {log.audio_path && audio[log.audio_path] && <audio controls src={audio[log.audio_path]} />}

        {ai?.status === 'done' && (
          <>
            {editing === log.id ? (
              <label className="field">
                <span>Summary</span>
                <textarea rows={4} value={draft} onChange={(e) => setDraft(e.target.value)} />
              </label>
            ) : (
              <p className="summary">{ai.final_summary || '(empty summary)'}</p>
            )}
            {ai.transcript && (
              <details>
                <summary className="small muted">Transcript{ai.language ? `, ${ai.language}` : ''}</summary>
                <p className="transcript">{ai.transcript}</p>
              </details>
            )}
            {(ai.suggested_room || ai.suggested_trade) && (
              <span className="muted small">Suggested: {[ai.suggested_room, ai.suggested_trade].filter(Boolean).join(' · ')}</span>
            )}
            <span className="small">
              {reviews.length === 0
                ? 'No confirmations yet'
                : reviews.map((r) => `${r.profiles?.full_name ?? 'Someone'} ${r.decision === 'confirm' ? 'confirmed' : 'rejected'}`).join(' · ')}
            </span>
            {st === 'unverified' && <span className="muted small">{stillNeeded(toLite(reviews))}</span>}
          </>
        )}

        {log.note && <span className="muted small">Typed: {log.note}</span>}
        {ai?.status === 'failed' && <p className="error">{ai.error ?? 'Transcription failed.'}</p>}
        {errors[log.id] && <p className="error" role="alert">{errors[log.id]}</p>}
        {working[log.id] && <p className="muted small" aria-live="polite">{working[log.id]}</p>}

        {editing === log.id ? (
          <div className="button-row">
            <button type="button" className="primary" disabled={busy || !draft.trim()} onClick={() => saveEdit(log.id)}>
              Save summary
            </button>
            <button type="button" className="secondary" disabled={busy} onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
        ) : st === 'unverified' ? (
          <>
            <div className="button-row three">
              <button type="button" className="primary" disabled={busy || mine?.decision === 'confirm'} onClick={() => decide(log.id, 'confirm')}>
                {mine?.decision === 'confirm' ? 'Confirmed' : 'Confirm'}
              </button>
              <button type="button" className="secondary" disabled={busy} onClick={() => { setEditing(log.id); setDraft(ai?.final_summary ?? '') }}>
                Edit
              </button>
              <button type="button" className="secondary" disabled={busy} onClick={() => decide(log.id, 'reject')}>
                Reject
              </button>
            </div>
            <span className="muted small">Editing clears all confirmations, so both people confirm the same words.</span>
          </>
        ) : st === 'missing' || st === 'failed' ? (
          <button type="button" className="secondary" disabled={busy} onClick={() => transcribe(log.id, st === 'failed')}>
            {st === 'failed' ? 'Try again' : 'Transcribe now'}
          </button>
        ) : st === 'pending' ? (
          <button type="button" className="secondary" disabled={busy} onClick={() => transcribe(log.id, true)}>
            Still waiting? Try again
          </button>
        ) : null}
      </li>
    )
  }

  return (
    <main className="screen">
      <header className="topbar">
        <h1>Review</h1>
        <span className="muted small">{open.length} to review</span>
      </header>
      <p className="muted small">
        AI summaries of voice notes. Each needs the coordinator and one team member to confirm before it can reach a client report.
      </p>
      {state === 'loading' && <p className="muted">Loading</p>}
      {state === 'offline' && <p className="notice">Reviewing needs a connection.</p>}
      {state === 'ready' && open.length === 0 && <p className="muted">Nothing to review.</p>}
      <ul className="logs">{open.map(card)}</ul>
      {done.length > 0 && (
        <section>
          <button type="button" className="link" onClick={() => setShowDone((s) => !s)}>
            {showDone ? 'Hide' : 'Show'} {done.length} finished
          </button>
          {showDone && <ul className="logs">{done.map(card)}</ul>}
        </section>
      )}
    </main>
  )
}
