import { useCallback, useEffect, useState, type ChangeEvent, type FormEvent } from 'react'
import {
  currentRevision,
  DRAWING_SELECT,
  isConstruction,
  ISSUE_METHODS,
  isValidCode,
  needsAttention,
  nextCodes,
  normaliseCode,
  rankOf,
  siteStatus,
  siteStatusText,
  sortRevisions,
  todayLocal,
  type Drawing,
} from '../drawings'
import { go } from '../hooks'
import { compressImage } from '../media'
import { MEDIA_BUCKET, supabase } from '../supabase'

const dateFormat = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
const showDate = (iso: string) => dateFormat.format(new Date(`${iso}T00:00:00`))

type Panel = 'none' | 'revision' | 'issue'

export default function DrawingDetail({ drawingId }: { drawingId: string }) {
  const [drawing, setDrawing] = useState<Drawing | null>(null)
  const [projectName, setProjectName] = useState('')
  const [state, setState] = useState<'loading' | 'ready' | 'missing' | 'offline'>('loading')
  const [urls, setUrls] = useState<Record<string, string>>({})
  const [panel, setPanel] = useState<Panel>('none')

  // New revision
  const [code, setCode] = useState('')
  const [revDate, setRevDate] = useState(todayLocal())
  const [note, setNote] = useState('')
  const [link, setLink] = useState('')

  // New issue
  const [revisionId, setRevisionId] = useState('')
  const [issuedTo, setIssuedTo] = useState('Site')
  const [otherTo, setOtherTo] = useState('')
  const [method, setMethod] = useState<string>('Print on site')
  const [issueDate, setIssueDate] = useState(todayLocal())
  const [photo, setPhoto] = useState<{ blob: Blob; ext: string; mime: string; preview: string } | null>(null)

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const { data, error } = await supabase.from('drawings').select(DRAWING_SELECT).eq('id', drawingId).maybeSingle()
    if (error) {
      setState('offline')
      return
    }
    if (!data) {
      setState('missing')
      return
    }
    const d = data as unknown as Drawing
    setDrawing(d)
    setState('ready')
    const { data: p } = await supabase.from('projects').select('name').eq('id', d.project_id).maybeSingle()
    if (p) setProjectName(p.name as string)
    const paths = d.drawing_revisions.flatMap((r) => r.drawing_issues.map((i) => i.print_photo_path)).filter((x): x is string => Boolean(x))
    if (paths.length) {
      const { data: signed } = await supabase.storage.from(MEDIA_BUCKET).createSignedUrls(paths, 3600)
      const map: Record<string, string> = {}
      for (const s of signed ?? []) if (s.path && s.signedUrl) map[s.path] = s.signedUrl
      setUrls(map)
    }
  }, [drawingId])

  useEffect(() => {
    void load()
  }, [load])

  if (state === 'loading') return <main className="screen"><p className="muted topgap">Loading</p></main>
  if (state === 'offline') return <main className="screen"><p className="notice topgap">No signal. Open the register from the project to see the copy saved on this phone.</p></main>
  if (state === 'missing' || !drawing) return <main className="screen"><p className="muted topgap">This sheet was not found.</p></main>

  const revisions = sortRevisions(drawing.drawing_revisions)
  const current = currentRevision(drawing)
  const status = siteStatus(drawing)
  const suggestion = nextCodes(current?.code ?? null)

  function openRevision() {
    setCode(suggestion.next)
    setRevDate(todayLocal())
    setNote('')
    setLink(current?.file_link ?? '')
    setError(null)
    setPanel('revision')
  }

  function openIssue() {
    setRevisionId(current?.id ?? '')
    setIssuedTo('Site')
    setOtherTo('')
    setMethod('Print on site')
    setIssueDate(todayLocal())
    setPhoto(null)
    setError(null)
    setPanel('issue')
  }

  async function saveRevision(e: FormEvent) {
    e.preventDefault()
    const c = normaliseCode(code)
    if (!isValidCode(c)) {
      setError('Revision code must look like P1, P2 or R0, R1.')
      return
    }
    if (current && rankOf(c) <= current.rank) {
      setError(`${c} is not later than the current revision ${current.code}.`)
      return
    }
    setBusy(true)
    setError(null)
    const { error: err } = await supabase
      .from('drawing_revisions')
      .insert({ drawing_id: drawingId, code: c, revised_on: revDate, note: note.trim(), file_link: link.trim() || null })
    setBusy(false)
    if (err) {
      setError(!navigator.onLine ? 'No signal. Adding a revision needs a connection.' : err.code === '23505' ? `${c} already exists on this sheet.` : err.message)
      return
    }
    setPanel('none')
    await load()
  }

  async function pickPhoto(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const { blob, mime, ext } = await compressImage(file)
    setPhoto({ blob, mime, ext, preview: URL.createObjectURL(blob) })
  }

  async function saveIssue(e: FormEvent) {
    e.preventDefault()
    const to = issuedTo === 'Other' ? otherTo.trim() : issuedTo
    if (!revisionId) {
      setError('Choose which revision was issued.')
      return
    }
    if (!to) {
      setError('Say who it was issued to.')
      return
    }
    setBusy(true)
    setError(null)
    let photoPath: string | null = null
    if (photo) {
      photoPath = `drawings/${drawingId}/${crypto.randomUUID()}.${photo.ext}`
      const { error: upErr } = await supabase.storage.from(MEDIA_BUCKET).upload(photoPath, photo.blob, { contentType: photo.mime })
      if (upErr) {
        setBusy(false)
        setError(!navigator.onLine ? 'No signal. Recording an issue needs a connection.' : `The photo did not upload: ${upErr.message}`)
        return
      }
    }
    const { error: err } = await supabase
      .from('drawing_issues')
      .insert({ revision_id: revisionId, issued_to: to, method, issued_on: issueDate, print_photo_path: photoPath })
    setBusy(false)
    if (err) {
      setError(!navigator.onLine ? 'No signal. Recording an issue needs a connection.' : err.message)
      return
    }
    setPanel('none')
    await load()
  }

  return (
    <main className="screen">
      <header className="topbar">
        <div>
          <button type="button" className="link back" onClick={() => go(`/project/${drawing.project_id}/drawings`)}>
            {projectName || 'Project'} · Drawings
          </button>
          <h1>{drawing.number}</h1>
          <span className="muted small">
            {drawing.title} · {drawing.discipline}
          </span>
        </div>
        <span className={current && isConstruction(current.code) ? 'rev con big' : 'rev big'}>{current?.code ?? '—'}</span>
      </header>

      <p className={needsAttention(status) ? 'flag' : 'notice'}>{siteStatusText(status)}</p>

      {panel === 'none' && (
        <div className="button-row">
          <button type="button" className="primary" onClick={openRevision}>
            New revision
          </button>
          <button type="button" className="secondary" onClick={openIssue} disabled={revisions.length === 0}>
            Record issue
          </button>
        </div>
      )}

      {panel === 'revision' && (
        <form onSubmit={saveRevision} className="stack card">
          <h2>New revision</h2>
          <div className="chips">
            <button type="button" className={normaliseCode(code) === suggestion.next ? 'chip on' : 'chip'} aria-pressed={normaliseCode(code) === suggestion.next} onClick={() => setCode(suggestion.next)}>
              {suggestion.next}
            </button>
            {suggestion.construction && (
              <button type="button" className={normaliseCode(code) === suggestion.construction ? 'chip on' : 'chip'} aria-pressed={normaliseCode(code) === suggestion.construction} onClick={() => setCode(suggestion.construction!)}>
                {suggestion.construction}, for construction
              </button>
            )}
          </div>
          <label className="field">
            <span>Code</span>
            <input type="text" value={code} onChange={(e) => setCode(e.target.value)} autoCapitalize="characters" required />
          </label>
          <label className="field">
            <span>Date</span>
            <input type="date" value={revDate} onChange={(e) => setRevDate(e.target.value)} required />
          </label>
          <label className="field">
            <span>What changed</span>
            <input type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Sofa wall points moved 300 mm" />
          </label>
          <label className="field">
            <span>Link to the PDF, optional</span>
            <input type="url" value={link} onChange={(e) => setLink(e.target.value)} placeholder="Drive or server link" />
          </label>
          {error && <p className="error" role="alert">{error}</p>}
          <div className="button-row">
            <button type="submit" className="primary" disabled={busy}>
              {busy ? 'Saving' : 'Save revision'}
            </button>
            <button type="button" className="secondary" onClick={() => setPanel('none')}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {panel === 'issue' && (
        <form onSubmit={saveIssue} className="stack card">
          <h2>Record issue</h2>
          <label className="field">
            <span>Revision</span>
            <select value={revisionId} onChange={(e) => setRevisionId(e.target.value)}>
              {revisions.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.code}
                  {r.id === current?.id ? ' (current)' : ' (superseded)'}
                </option>
              ))}
            </select>
          </label>
          <div className="field">
            <span>Issued to</span>
            <div className="chips">
              {['Site', 'Client', 'Other'].map((t) => (
                <button key={t} type="button" className={issuedTo === t ? 'chip on' : 'chip'} aria-pressed={issuedTo === t} onClick={() => setIssuedTo(t)}>
                  {t}
                </button>
              ))}
            </div>
          </div>
          {issuedTo === 'Other' && (
            <label className="field">
              <span>Agency or person</span>
              <input type="text" value={otherTo} onChange={(e) => setOtherTo(e.target.value)} placeholder="Carpenter, electrician" />
            </label>
          )}
          <label className="field">
            <span>How</span>
            <select value={method} onChange={(e) => setMethod(e.target.value)}>
              {ISSUE_METHODS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Date</span>
            <input type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} required />
          </label>
          <div className="field">
            <span>Photo of the print on site, optional</span>
            <div className="photos">
              <label className="tile add">
                <span>{photo ? 'Retake' : 'Take photo'}</span>
                <input type="file" accept="image/*" capture="environment" onChange={pickPhoto} className="sr" />
              </label>
              {photo && (
                <div className="tile">
                  <img src={photo.preview} alt="Print on site" />
                </div>
              )}
            </div>
          </div>
          {error && <p className="error" role="alert">{error}</p>}
          <div className="button-row">
            <button type="submit" className="primary" disabled={busy}>
              {busy ? 'Saving' : 'Save issue'}
            </button>
            <button type="button" className="secondary" onClick={() => setPanel('none')}>
              Cancel
            </button>
          </div>
        </form>
      )}

      <section>
        <h2>Revisions</h2>
        {revisions.length === 0 && <p className="muted">No revisions yet. Add the first one above.</p>}
        <ul className="logs">
          {revisions.map((r) => (
            <li key={r.id} className={r.id === current?.id ? 'card' : 'card faded'}>
              <div className="card-head">
                <span className="row-line">
                  <span className={isConstruction(r.code) ? 'rev con' : 'rev'}>{r.code}</span>
                  <span className="muted small">{r.id === current?.id ? 'Current' : 'Superseded'}</span>
                </span>
                <span className="muted small">{showDate(r.revised_on)}</span>
              </div>
              {r.note && <p>{r.note}</p>}
              {r.file_link && (
                <a href={r.file_link} target="_blank" rel="noreferrer" className="small">
                  Open the PDF
                </a>
              )}
              {r.drawing_issues.length > 0 && (
                <ul className="issues">
                  {[...r.drawing_issues]
                    .sort((a, b) => `${b.issued_on}${b.created_at}`.localeCompare(`${a.issued_on}${a.created_at}`))
                    .map((i) => (
                      <li key={i.id}>
                        <span>
                          To {i.issued_to} · {i.method} · {showDate(i.issued_on)}
                        </span>
                        {i.print_photo_path && urls[i.print_photo_path] && (
                          <a href={urls[i.print_photo_path]} target="_blank" rel="noreferrer">
                            <img src={urls[i.print_photo_path]} alt={`Print on site, ${r.code}`} className="thumb" />
                          </a>
                        )}
                      </li>
                    ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </section>
    </main>
  )
}
