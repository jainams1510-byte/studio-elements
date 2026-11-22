import { useCallback, useEffect, useState } from 'react'
import { AI_SELECT, stateOf, STATE_LABEL, type AiRow } from '../ai'
import { go, useProjects } from '../hooks'
import { MEDIA_BUCKET, supabase } from '../supabase'
import { isOwner, useTeam } from '../team'

type Photo = { id: string; path: string; removed_at: string | null }

type Log = {
  id: string
  note: string
  room: string | null
  trade: string | null
  audio_path: string | null
  logged_at: string
  edited_at: string | null
  edited_by: string | null
  removed_at: string | null
  removed_by: string | null
  profiles: { full_name: string } | null
  site_log_photos: Photo[]
  site_log_ai: AiRow | null
}

const LOG_SELECT =
  'id, project_id, note, room, trade, audio_path, logged_at, edited_at, edited_by, removed_at, removed_by, ' +
  `profiles(full_name), site_log_photos(id, path, removed_at), site_log_ai(${AI_SELECT})`

const timeFormat = new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
const dayFormat = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short' })

type Draft = { note: string; room: string; trade: string; removePhotos: Set<string> }

export default function LogList({ projectId }: { projectId: string }) {
  const { me, names } = useTeam()
  const owner = isOwner(me)
  const { projects } = useProjects()
  const project = projects.find((p) => p.id === projectId)

  const [logs, setLogs] = useState<Log[]>([])
  const [removed, setRemoved] = useState<Log[]>([])
  const [showRemoved, setShowRemoved] = useState(false)
  const [urls, setUrls] = useState<Record<string, string>>({})
  const [state, setState] = useState<'loading' | 'ready' | 'offline'>('loading')
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ id: string; text: string } | null>(null)

  const load = useCallback(async () => {
    const { data, error: err } = await supabase
      .from('site_logs')
      .select(LOG_SELECT)
      .eq('project_id', projectId)
      .order('logged_at', { ascending: false })
      .limit(80)
    if (err) {
      setState('offline')
      return
    }
    const all = (data ?? []) as unknown as Log[]
    setLogs(all.filter((l) => !l.removed_at))
    setRemoved(all.filter((l) => l.removed_at))
    setState('ready')

    // Photos and audio are private: ask for links that work for one hour.
    const paths = all.flatMap((l) => [...l.site_log_photos.map((p) => p.path), ...(l.audio_path ? [l.audio_path] : [])])
    if (paths.length === 0) return
    const { data: signed } = await supabase.storage.from(MEDIA_BUCKET).createSignedUrls(paths, 3600)
    if (!signed) return
    const map: Record<string, string> = {}
    for (const s of signed) if (s.path && s.signedUrl) map[s.path] = s.signedUrl
    setUrls(map)
  }, [projectId])

  useEffect(() => {
    void load()
  }, [load])

  function startEdit(log: Log) {
    setEditing(log.id)
    setConfirmRemove(null)
    setError(null)
    setDraft({ note: log.note ?? '', room: log.room ?? '', trade: log.trade ?? '', removePhotos: new Set() })
  }

  /** Save, then read back: if the server kept the old values, this account is not an owner. */
  async function save(log: Log) {
    if (!draft) return
    setBusy(true)
    setError(null)
    const changes = { note: draft.note.trim(), room: draft.room || null, trade: draft.trade || null }
    try {
      const { data, error: err } = await supabase.from('site_logs').update(changes).eq('id', log.id).select('note, room, trade')
      if (err) throw new Error(err.message)
      const back = data?.[0]
      if (!back || back.note !== changes.note || back.room !== changes.room || back.trade !== changes.trade) {
        throw new Error('Not saved. Only an owner can edit site logs.')
      }
      if (draft.removePhotos.size) {
        const { error: perr } = await supabase
          .from('site_log_photos')
          .update({ removed_at: new Date().toISOString() })
          .in('id', [...draft.removePhotos])
        if (perr) throw new Error(perr.message)
      }
      setEditing(null)
      setDraft(null)
      await load()
    } catch (e) {
      setError({ id: log.id, text: navigator.onLine ? (e instanceof Error ? e.message : 'Could not save.') : 'No signal. Editing needs a connection.' })
    }
    setBusy(false)
  }

  async function setRemovedAt(log: Log, removedAt: string | null) {
    setBusy(true)
    setError(null)
    try {
      const { data, error: err } = await supabase.from('site_logs').update({ removed_at: removedAt }).eq('id', log.id).select('removed_at')
      if (err) throw new Error(err.message)
      if (!data?.[0] || Boolean(data[0].removed_at) !== Boolean(removedAt)) throw new Error('Not saved. Only an owner can remove site logs.')
      setConfirmRemove(null)
      setEditing(null)
      await load()
    } catch (e) {
      setError({ id: log.id, text: navigator.onLine ? (e instanceof Error ? e.message : 'Could not save.') : 'No signal. This needs a connection.' })
    }
    setBusy(false)
  }

  const options = (list: string[] | undefined, current: string) => {
    const all = [...(list ?? [])]
    if (current && !all.includes(current)) all.unshift(current)
    return all
  }

  function view(log: Log) {
    const photos = log.site_log_photos.filter((p) => !p.removed_at)
    return (
      <>
        <div className="card-head">
          <strong>{[log.room, log.trade].filter(Boolean).join(' · ') || 'Site log'}</strong>
          <span className="muted small">{timeFormat.format(new Date(log.logged_at))}</span>
        </div>
        {log.note && <p>{log.note}</p>}
        {photos.length > 0 && (
          <div className="photos">
            {photos.map((p, i) => (
              <div key={p.id} className="tile">
                {urls[p.path] ? <img src={urls[p.path]} alt={`Photo ${i + 1}`} loading="lazy" /> : <span className="muted small">Photo {i + 1}</span>}
              </div>
            ))}
          </div>
        )}
        {log.audio_path && urls[log.audio_path] && <audio controls src={urls[log.audio_path]} />}
        {log.audio_path && !log.removed_at && (() => {
          const st = stateOf({ ...log, project_id: projectId })
          const summary = log.site_log_ai?.status === 'done' ? log.site_log_ai.final_summary : null
          return (
            <div className="stack-tight">
              {summary && <p className="summary">{summary}</p>}
              <button type="button" className="link small left" onClick={() => go('/review')}>
                <span className={st === 'verified' ? 'tag ok' : st === 'unverified' ? 'tag' : 'tag muted'}>{STATE_LABEL[st]}</span>
              </button>
            </div>
          )
        })()}
        <span className="muted small">
          {[
            log.profiles?.full_name && `Logged by ${log.profiles.full_name}`,
            log.edited_at && `edited by ${(log.edited_by && names[log.edited_by]) || 'an owner'} on ${dayFormat.format(new Date(log.edited_at))}`,
          ]
            .filter(Boolean)
            .join(', ')}
        </span>
      </>
    )
  }

  function editor(log: Log) {
    if (!draft) return null
    const photos = log.site_log_photos.filter((p) => !p.removed_at)
    return (
      <div className="stack-tight">
        <div className="card-head">
          <strong>Edit log</strong>
          <span className="muted small">{timeFormat.format(new Date(log.logged_at))}</span>
        </div>
        <label className="field">
          <span>Note</span>
          <textarea rows={3} value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} />
        </label>
        <div className="row-line">
          <label className="field grow">
            <span>Room</span>
            <select value={draft.room} onChange={(e) => setDraft({ ...draft, room: e.target.value })}>
              <option value="">None</option>
              {options(project?.rooms, draft.room).map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </label>
          <label className="field grow">
            <span>Trade</span>
            <select value={draft.trade} onChange={(e) => setDraft({ ...draft, trade: e.target.value })}>
              <option value="">None</option>
              {options(project?.trades, draft.trade).map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </label>
        </div>
        {photos.length > 0 && (
          <div className="photos">
            {photos.map((p, i) => {
              const gone = draft.removePhotos.has(p.id)
              return (
                <div key={p.id} className={gone ? 'tile removing' : 'tile'}>
                  {urls[p.path] ? <img src={urls[p.path]} alt={`Photo ${i + 1}`} /> : <span className="muted small">Photo {i + 1}</span>}
                  <button
                    type="button"
                    className="tile-action"
                    aria-label={gone ? `Keep photo ${i + 1}` : `Remove photo ${i + 1}`}
                    onClick={() => {
                      const next = new Set(draft.removePhotos)
                      if (gone) next.delete(p.id)
                      else next.add(p.id)
                      setDraft({ ...draft, removePhotos: next })
                    }}
                  >
                    {gone ? 'Undo remove' : 'Remove'}
                  </button>
                </div>
              )
            })}
          </div>
        )}
        {log.audio_path && <span className="muted small">The voice note cannot be changed.</span>}
        <div className="button-row">
          <button type="button" className="primary" disabled={busy} onClick={() => save(log)}>
            {busy ? 'Saving' : 'Save'}
          </button>
          <button type="button" className="secondary" disabled={busy} onClick={() => { setEditing(null); setDraft(null) }}>
            Cancel
          </button>
        </div>
        {confirmRemove === log.id ? (
          <div className="confirm stack-tight">
            <p className="small">Remove this log? It is hidden from the app and from reports. You can restore it.</p>
            <div className="button-row">
              <button type="button" className="danger" disabled={busy} onClick={() => setRemovedAt(log, new Date().toISOString())}>
                Remove log
              </button>
              <button type="button" className="secondary" disabled={busy} onClick={() => setConfirmRemove(null)}>
                Keep
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="danger-outline" disabled={busy} onClick={() => setConfirmRemove(log.id)}>
            Remove log
          </button>
        )}
      </div>
    )
  }

  return (
    <section>
      {state === 'loading' && <p className="muted">Loading</p>}
      {state === 'offline' && <p className="notice">Logs cannot be shown without a connection.</p>}
      {state === 'ready' && logs.length === 0 && <p className="muted">Nothing logged on this project yet.</p>}
      <ul className="logs">
        {logs.map((log) => (
          <li key={log.id} className="card stack-tight">
            {editing === log.id ? editor(log) : view(log)}
            {error?.id === log.id && <p className="error" role="alert">{error.text}</p>}
            {owner && editing !== log.id && (
              <button type="button" className="link small left" onClick={() => startEdit(log)}>
                Edit or remove
              </button>
            )}
          </li>
        ))}
      </ul>
      {owner && removed.length > 0 && (
        <section>
          <button type="button" className="link" onClick={() => setShowRemoved((s) => !s)}>
            {showRemoved ? 'Hide' : 'Show'} {removed.length} removed {removed.length === 1 ? 'log' : 'logs'}
          </button>
          {showRemoved && (
            <ul className="logs">
              {removed.map((log) => (
                <li key={log.id} className="card stack-tight removed">
                  {view(log)}
                  <span className="muted small">
                    Removed by {(log.removed_by && names[log.removed_by]) || 'an owner'} on {dayFormat.format(new Date(log.removed_at as string))}
                  </span>
                  {error?.id === log.id && <p className="error" role="alert">{error.text}</p>}
                  <button type="button" className="secondary" disabled={busy} onClick={() => setRemovedAt(log, null)}>
                    Restore
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </section>
  )
}
