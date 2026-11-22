import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { cacheGet, cacheSet } from '../db'
import {
  currentRevision,
  DISCIPLINES,
  DRAWING_SELECT,
  isValidCode,
  needsAttention,
  normaliseCode,
  siteStatus,
  siteStatusText,
  todayLocal,
  type Drawing,
} from '../drawings'
import { go } from '../hooks'
import { supabase } from '../supabase'

export default function DrawingList({ projectId }: { projectId: string }) {
  const [drawings, setDrawings] = useState<Drawing[]>([])
  const [state, setState] = useState<'loading' | 'ready' | 'offline'>('loading')
  const [adding, setAdding] = useState(false)
  const [number, setNumber] = useState('')
  const [title, setTitle] = useState('')
  const [discipline, setDiscipline] = useState<string>(DISCIPLINES[0])
  const [code, setCode] = useState('P1')
  const [link, setLink] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const cacheKey = `drawings:${projectId}`

  const load = useCallback(async () => {
    const { data, error: err } = await supabase
      .from('drawings')
      .select(DRAWING_SELECT)
      .eq('project_id', projectId)
      .eq('archived', false)
      .order('number')
    if (err) {
      // Show the phone's copy so the register can be checked on site with no signal.
      const cached = await cacheGet<Drawing[]>(cacheKey)
      if (cached) setDrawings(cached)
      setState('offline')
      return
    }
    const list = (data ?? []) as unknown as Drawing[]
    setDrawings(list)
    setState('ready')
    await cacheSet(cacheKey, list)
  }, [projectId, cacheKey])

  useEffect(() => {
    void load()
  }, [load])

  async function add(e: FormEvent) {
    e.preventDefault()
    const first = normaliseCode(code)
    if (!isValidCode(first)) {
      setError('Revision code must look like P1, P2 or R0, R1.')
      return
    }
    setBusy(true)
    setError(null)
    const { data, error: err } = await supabase
      .from('drawings')
      .insert({ project_id: projectId, number: number.trim(), title: title.trim(), discipline })
      .select('id')
      .single()
    if (err || !data) {
      setBusy(false)
      setError(
        !navigator.onLine
          ? 'No signal. Adding a sheet needs a connection.'
          : err?.code === '23505'
            ? `Sheet ${number.trim()} is already in this register.`
            : (err?.message ?? 'Could not add the sheet.'),
      )
      return
    }
    const { error: revErr } = await supabase
      .from('drawing_revisions')
      .insert({ drawing_id: data.id, code: first, revised_on: todayLocal(), file_link: link.trim() || null })
    setBusy(false)
    if (revErr) {
      setError(`Sheet added, but its first revision was not saved: ${revErr.message}. Open the sheet to add it.`)
    } else {
      setNumber('')
      setTitle('')
      setCode('P1')
      setLink('')
      setAdding(false)
    }
    await load()
  }

  const sorted = [...drawings].sort((a, b) => a.number.localeCompare(b.number, 'en', { numeric: true }))

  return (
    <section className="stack">
      {state === 'loading' && <p className="muted">Loading</p>}
      {state === 'offline' && (
        <p className="notice">No signal. {drawings.length ? 'Showing the register as last seen on this phone.' : 'The register has not been opened on this phone yet.'}</p>
      )}
      {state === 'ready' && drawings.length === 0 && <p className="muted">No sheets in the register yet.</p>}

      <ul className="rows">
        {sorted.map((d) => {
          const current = currentRevision(d)
          const status = siteStatus(d)
          const flag = needsAttention(status)
          return (
            <li key={d.id}>
              <button type="button" className="row" onClick={() => go(`/drawing/${d.id}`)}>
                <span className="row-line">
                  <span className="row-title">{d.number}</span>
                  <span className={current && current.code.startsWith('R') ? 'rev con' : 'rev'}>{current?.code ?? 'No revision'}</span>
                </span>
                <span>{d.title}</span>
                <span className={flag ? 'flag-text small' : 'muted small'}>
                  {flag && <span className="dot" aria-hidden="true" />}
                  {d.discipline} · {siteStatusText(status)}
                </span>
              </button>
            </li>
          )
        })}
      </ul>

      {!adding ? (
        <button type="button" className="secondary" onClick={() => setAdding(true)}>
          Add a sheet
        </button>
      ) : (
        <form onSubmit={add} className="stack card">
          <h2>Add a sheet</h2>
          <label className="field">
            <span>Sheet number</span>
            <input type="text" value={number} onChange={(e) => setNumber(e.target.value)} placeholder="SE-EL-03" required autoCapitalize="characters" />
          </label>
          <label className="field">
            <span>Title</span>
            <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Electrical layout, living and dining" required />
          </label>
          <label className="field">
            <span>Discipline</span>
            <select value={discipline} onChange={(e) => setDiscipline(e.target.value)}>
              {DISCIPLINES.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>First revision</span>
            <input type="text" value={code} onChange={(e) => setCode(e.target.value)} autoCapitalize="characters" required />
          </label>
          <label className="field">
            <span>Link to the PDF, optional</span>
            <input type="url" value={link} onChange={(e) => setLink(e.target.value)} placeholder="Drive or server link" />
          </label>
          {error && <p className="error" role="alert">{error}</p>}
          <div className="button-row">
            <button type="submit" className="primary" disabled={busy}>
              {busy ? 'Adding' : 'Add sheet'}
            </button>
            <button type="button" className="secondary" onClick={() => { setAdding(false); setError(null) }}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  )
}
