import { useEffect, useState, type FormEvent } from 'react'
import { cacheGet, cacheSet } from '../../db'
import { briefDateWarnings, briefNumberProblem, parseNum } from '../../deck/brief'
import { BRIEF_SELECT, TYPOLOGIES, type ProjectBrief } from '../../domain'
import { supabase } from '../../supabase'

type Form = {
  client_name: string; client_phone: string; client_email: string; site_address: string; city: string
  typology: ProjectBrief['typology']; area: string; area_unit: ProjectBrief['area_unit']
  issue_date: string; agreement_date: string; start_date: string; end_date: string; duration_months: string
  client_budget: string; budget_includes_gst: boolean; estimate_gst_rate: string; contingency_pct: string
}

const EMPTY: Form = {
  client_name: '', client_phone: '', client_email: '', site_address: '', city: '', typology: 'residential', area: '', area_unit: 'sq. ft.',
  issue_date: '', agreement_date: '', start_date: '', end_date: '', duration_months: '', client_budget: '', budget_includes_gst: false,
  estimate_gst_rate: '18', contingency_pct: '5',
}

const str = (v: unknown) => (v == null ? '' : String(v))

function toForm(b: Partial<ProjectBrief>): Form {
  return {
    client_name: str(b.client_name), client_phone: str(b.client_phone), client_email: str(b.client_email),
    site_address: str(b.site_address), city: str(b.city), typology: b.typology ?? 'residential', area: str(b.area),
    area_unit: b.area_unit ?? 'sq. ft.', issue_date: str(b.issue_date), agreement_date: str(b.agreement_date),
    start_date: str(b.start_date), end_date: str(b.end_date), duration_months: str(b.duration_months),
    client_budget: str(b.client_budget), budget_includes_gst: Boolean(b.budget_includes_gst),
    estimate_gst_rate: b.estimate_gst_rate == null ? '18' : str(b.estimate_gst_rate),
    contingency_pct: b.contingency_pct == null ? '5' : str(b.contingency_pct),
  }
}

function Warn({ list }: { list: { level: string; text: string }[] }) {
  return (
    <>
      {list.map((w) => (
        <p key={w.text} className={w.level === 'bad' ? 'dk-inline bad' : 'dk-inline'} role="status">
          {w.text}
        </p>
      ))}
    </>
  )
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** The project brief (client, site, area, dates, budget), at the bottom of Project → Edit. */
export default function BriefForm({ projectId }: { projectId: string }) {
  const [f, setF] = useState<Form>(EMPTY)
  const [state, setState] = useState<'loading' | 'ready' | 'offline'>('loading')
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const key = `brief:${projectId}`

  useEffect(() => {
    let live = true
    cacheGet<Partial<ProjectBrief>>(key).then((c) => {
      if (live && c) {
        setF(toForm(c))
        setState((s) => (s === 'loading' ? 'ready' : s))
      }
    })
    supabase
      .from('project_briefs')
      .select(BRIEF_SELECT)
      .eq('project_id', projectId)
      .maybeSingle()
      .then(({ data, error: err }) => {
        if (!live) return
        if (err) {
          setState('offline')
          return
        }
        if (data) {
          setF(toForm(data as unknown as ProjectBrief))
          void cacheSet(key, data)
        }
        setState('ready')
      })
    return () => {
      live = false
    }
  }, [projectId, key])

  const set = <K extends keyof Form>(k: K, v: Form[K]) => {
    setF((x) => ({ ...x, [k]: v }))
    setSaved(false)
  }

  const warnings = briefDateWarnings({
    issue_date: f.issue_date || null, agreement_date: f.agreement_date || null, start_date: f.start_date || null, end_date: f.end_date || null,
  })
  const warnFor = (field: 'agreement' | 'start' | 'end') =>
    warnings.filter((w) =>
      field === 'agreement' ? w.text.startsWith('Agreement') : field === 'start' ? w.text.startsWith('Start') : w.text.startsWith('Completion'),
    )

  async function save(e: FormEvent) {
    e.preventDefault()
    const nums = {
      area: parseNum(f.area), duration_months: parseNum(f.duration_months), client_budget: parseNum(f.client_budget),
      estimate_gst_rate: parseNum(f.estimate_gst_rate), contingency_pct: parseNum(f.contingency_pct),
    }
    const problem = briefNumberProblem(nums)
    if (problem) {
      setError(problem)
      return
    }
    const t = (s: string) => s.trim() || null
    const row = {
      project_id: projectId, client_name: t(f.client_name), client_phone: t(f.client_phone), client_email: t(f.client_email),
      site_address: t(f.site_address), city: t(f.city), typology: f.typology, area: nums.area, area_unit: f.area_unit,
      issue_date: f.issue_date || null, agreement_date: f.agreement_date || null, start_date: f.start_date || null, end_date: f.end_date || null,
      duration_months: nums.duration_months, client_budget: nums.client_budget, budget_includes_gst: f.budget_includes_gst,
      estimate_gst_rate: nums.estimate_gst_rate, contingency_pct: nums.contingency_pct,
    }
    setBusy(true)
    setError(null)
    const { error: err } = await supabase.from('project_briefs').upsert(row, { onConflict: 'project_id' })
    setBusy(false)
    if (err) {
      setError(navigator.onLine ? err.message : 'No signal. Saving the brief needs a connection.')
      return
    }
    await cacheSet(key, row)
    setSaved(true)
  }


  return (
    <section className="stack dk-brief" aria-labelledby="brief-title">
      <div className="dk-head">
        <h2 id="brief-title" className="dk-title">Brief</h2>
        <p className="muted small">Client, site, dates and budget. Used by the estimate, fee proposal, review and exports.</p>
      </div>
      {state === 'offline' && <p className="notice">No signal. Showing the brief as last seen on this phone. Saving needs a connection.</p>}
      {state === 'loading' ? (
        <p className="muted">Loading</p>
      ) : (
        <form onSubmit={save} className="stack">
          <fieldset className="card dk-group">
            <legend className="dk-legend">Client and site</legend>
            <label className="field">
              <span>Client name</span>
              <input type="text" value={f.client_name} onChange={(e) => set('client_name', e.target.value)} autoComplete="off" />
            </label>
            <label className="field">
              <span>Client phone</span>
              <input type="tel" value={f.client_phone} onChange={(e) => set('client_phone', e.target.value)} placeholder="+91" inputMode="tel" />
              <small className="muted small">Used for WhatsApp links. Include the country code.</small>
            </label>
            <label className="field">
              <span>Client email</span>
              <input type="email" value={f.client_email} onChange={(e) => set('client_email', e.target.value)} />
            </label>
            <label className="field">
              <span>Site address</span>
              <input type="text" value={f.site_address} onChange={(e) => set('site_address', e.target.value)} />
            </label>
            <label className="field">
              <span>City and state</span>
              <input type="text" value={f.city} onChange={(e) => set('city', e.target.value)} />
            </label>
            <label className="field">
              <span>Typology</span>
              <select value={f.typology} onChange={(e) => set('typology', e.target.value as Form['typology'])}>
                {TYPOLOGIES.map((t) => (
                  <option key={t} value={t}>{cap(t)}</option>
                ))}
              </select>
            </label>
            <div className="two">
              <label className="field">
                <span>Project area</span>
                <input type="text" inputMode="decimal" value={f.area} onChange={(e) => set('area', e.target.value)} />
              </label>
              <label className="field">
                <span>Unit</span>
                <select value={f.area_unit} onChange={(e) => set('area_unit', e.target.value as Form['area_unit'])}>
                  <option value="sq. ft.">sq. ft.</option>
                  <option value="sq. m.">sq. m.</option>
                </select>
              </label>
            </div>
          </fieldset>

          <fieldset className="card dk-group">
            <legend className="dk-legend">Dates, kept separate</legend>
            <label className="field">
              <span>Proposal issue</span>
              <input type="date" value={f.issue_date} onChange={(e) => set('issue_date', e.target.value)} />
            </label>
            <label className="field">
              <span>Agreement</span>
              <input type="date" value={f.agreement_date} onChange={(e) => set('agreement_date', e.target.value)} />
            </label>
            <Warn list={warnFor('agreement')} />
            <label className="field">
              <span>Planned start</span>
              <input type="date" value={f.start_date} onChange={(e) => set('start_date', e.target.value)} />
            </label>
            <Warn list={warnFor('start')} />
            <label className="field">
              <span>Estimated completion</span>
              <input type="date" value={f.end_date} onChange={(e) => set('end_date', e.target.value)} />
            </label>
            <Warn list={warnFor('end')} />
            <label className="field">
              <span>Duration (months)</span>
              <input type="text" inputMode="decimal" value={f.duration_months} onChange={(e) => set('duration_months', e.target.value)} />
            </label>
          </fieldset>

          <fieldset className="card dk-group">
            <legend className="dk-legend">Budget and tax</legend>
            <label className="field">
              <span>Client total budget (₹)</span>
              <input type="text" inputMode="decimal" value={f.client_budget} onChange={(e) => set('client_budget', e.target.value)} />
            </label>
            <label className="check">
              <input type="checkbox" checked={f.budget_includes_gst} onChange={(e) => set('budget_includes_gst', e.target.checked)} />
              Budget includes GST
            </label>
            <div className="two">
              <label className="field">
                <span>Estimate GST (%)</span>
                <input type="text" inputMode="decimal" value={f.estimate_gst_rate} onChange={(e) => set('estimate_gst_rate', e.target.value)} />
              </label>
              <label className="field">
                <span>Contingency (%)</span>
                <input type="text" inputMode="decimal" value={f.contingency_pct} onChange={(e) => set('contingency_pct', e.target.value)} />
              </label>
            </div>
            <p className="muted small">Confirm the GST rate with your CA.</p>
          </fieldset>

          {error && <p className="error" role="alert">{error}</p>}
          <button type="submit" className="primary" disabled={busy}>
            {busy ? 'Saving' : saved ? 'Brief saved' : 'Save brief'}
          </button>
        </form>
      )}
    </section>
  )
}
