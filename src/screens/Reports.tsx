import { useCallback, useEffect, useState } from 'react'
import { addDays, weekStart } from '../review'
import { callAi, supabase } from '../supabase'

type Report = {
  id: string
  kind: 'client' | 'internal'
  language: string
  body: string
  status: 'draft' | 'approved'
  approved_at: string | null
  generated_at: string
  profiles: { full_name: string } | null
}

const dayFormat = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short' })
const showDay = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number)
  return dayFormat.format(new Date(y, m - 1, d))
}

export default function Reports({ projectId }: { projectId: string }) {
  const thisWeek = weekStart()
  const [week, setWeek] = useState(thisWeek)
  const [language, setLanguage] = useState('English')
  const [reports, setReports] = useState<Report[]>([])
  const [texts, setTexts] = useState<Record<string, string>>({})
  const [state, setState] = useState<'loading' | 'ready' | 'offline'>('loading')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const load = useCallback(async () => {
    const { data, error: err } = await supabase
      .from('weekly_reports')
      .select('id, kind, language, body, status, approved_at, generated_at, profiles(full_name)')
      .eq('project_id', projectId)
      .eq('week_start', week)
    if (err) {
      setState('offline')
      return
    }
    const list = ((data ?? []) as unknown as Report[]).sort((a, b) => (a.kind === 'client' ? -1 : 1) - (b.kind === 'client' ? -1 : 1))
    setReports(list)
    setTexts(Object.fromEntries(list.map((r) => [r.id, r.body])))
    const client = list.find((r) => r.kind === 'client')
    if (client) setLanguage(client.language)
    setState('ready')
  }, [projectId, week])

  useEffect(() => {
    setState('loading')
    void load()
  }, [load])

  async function draft() {
    setBusy('draft')
    setError(null)
    setNote(null)
    try {
      const out = await callAi<{ saved: string[]; skipped: string[]; awaiting_verification: number }>({
        action: 'weekly_report',
        project_id: projectId,
        week_start: week,
        language,
      })
      const bits = []
      if (out.skipped.length) bits.push(`The approved ${out.skipped.join(' and ')} report was kept as it is.`)
      if (out.awaiting_verification) bits.push(out.awaiting_verification === 1 ? '1 voice note is not verified yet, so it was left out.' : `${out.awaiting_verification} voice notes are not verified yet, so they were left out.`)
      setNote(bits.join(' ') || null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not draft the reports.')
    }
    setBusy('')
    await load()
  }

  async function save(r: Report, approve: boolean) {
    setBusy(r.id)
    setError(null)
    const changes: Record<string, string> = {}
    if (texts[r.id] !== r.body) changes.body = texts[r.id]
    if (approve) changes.status = 'approved'
    const { error: err } = await supabase.from('weekly_reports').update(changes).eq('id', r.id)
    if (err) setError(navigator.onLine ? err.message : 'No signal. Saving needs a connection.')
    setBusy('')
    await load()
  }

  async function share(r: Report) {
    const text = texts[r.id]
    try {
      if (navigator.share) {
        await navigator.share({ text })
        return
      }
    } catch {
      return // cancelled
    }
    try {
      await navigator.clipboard.writeText(text)
      setNote('Copied. Paste it into WhatsApp.')
    } catch {
      setNote('Select the text and copy it.')
    }
  }

  const hasDrafts = reports.length > 0

  return (
    <section className="stack">
      <div className="chips">
        <button type="button" className={week === thisWeek ? 'chip on' : 'chip'} aria-pressed={week === thisWeek} onClick={() => setWeek(thisWeek)}>
          This week, from {showDay(thisWeek)}
        </button>
        <button type="button" className={week === addDays(thisWeek, -7) ? 'chip on' : 'chip'} aria-pressed={week === addDays(thisWeek, -7)} onClick={() => setWeek(addDays(thisWeek, -7))}>
          Last week
        </button>
      </div>

      <div className="row-line">
        <label className="field grow">
          <span>Client report language</span>
          <select value={language} onChange={(e) => setLanguage(e.target.value)}>
            {['English', 'Hindi', 'Gujarati'].map((l) => (
              <option key={l}>{l}</option>
            ))}
          </select>
        </label>
      </div>
      <button type="button" className="primary" onClick={draft} disabled={busy !== ''}>
        {busy === 'draft' ? 'Drafting, this can take a minute' : hasDrafts ? 'Draft again' : 'Draft reports'}
      </button>
      <p className="muted small">
        Drafts use typed notes and verified voice summaries only. Nothing is sent until you approve and share it yourself.
      </p>

      {error && <p className="error" role="alert">{error}</p>}
      {note && <p className="notice">{note}</p>}
      {state === 'loading' && <p className="muted">Loading</p>}
      {state === 'offline' && <p className="notice">Reports need a connection.</p>}

      {reports.map((r) => {
        const changed = texts[r.id] !== r.body
        return (
          <article key={r.id} className="card stack-tight">
            <div className="card-head">
              <strong>{r.kind === 'client' ? `Client report, ${r.language}` : 'Internal report'}</strong>
              <span className={r.status === 'approved' ? 'tag ok' : 'tag'}>{r.status === 'approved' ? 'Approved' : 'Draft'}</span>
            </div>
            <label className="field">
              <span className="sr">{r.kind === 'client' ? 'Client report text' : 'Internal report text'}</span>
              <textarea rows={10} value={texts[r.id] ?? ''} onChange={(e) => setTexts((t) => ({ ...t, [r.id]: e.target.value }))} />
            </label>
            {r.status === 'approved' && r.profiles?.full_name && !changed && (
              <span className="muted small">Approved by {r.profiles.full_name}</span>
            )}
            {changed && r.status === 'approved' && <span className="muted small">Saving a change puts it back to draft.</span>}
            <div className="button-row">
              {r.status === 'approved' && !changed ? (
                <button type="button" className="primary" onClick={() => share(r)}>
                  Share
                </button>
              ) : (
                <button type="button" className="primary" disabled={busy !== ''} onClick={() => save(r, true)}>
                  {busy === r.id ? 'Saving' : 'Approve'}
                </button>
              )}
              <button type="button" className="secondary" disabled={busy !== '' || !changed} onClick={() => save(r, false)}>
                Save edit
              </button>
            </div>
          </article>
        )
      })}
    </section>
  )
}
