import { useCallback, useEffect, useState, type ChangeEvent, type FormEvent } from 'react'
import { CLAUSE_KEYS, CLAUSE_TITLES, clauseText, REFERENCE_CLAUSES, type ClauseKey } from '../../clauses'
import { cacheGet, cacheSet } from '../../db'
import { logoPng } from '../../deck/images'
import { clauseChecks } from '../../deck/review'
import { SETTINGS_SELECT, type StudioSettings as Settings } from '../../domain'
import { go } from '../../hooks'
import { MEDIA_BUCKET, supabase } from '../../supabase'
import { isOwner, useTeam } from '../../team'

const DEFAULT_LOGO = `${import.meta.env.BASE_URL}logo-default.png`
const FIELDS: [keyof Settings, string, string][] = [
  ['name', 'Studio name', 'text'],
  ['tagline', 'Services line', 'text'],
  ['website', 'Website', 'text'],
  ['email', 'Email', 'email'],
  ['phone', 'Phone', 'tel'],
  ['gstin', 'GSTIN', 'text'],
]
type Details = Pick<Settings, 'name' | 'tagline' | 'website' | 'email' | 'phone' | 'gstin'>

const rowsFor = (t: string) => Math.min(14, Math.max(4, t.split('\n').length + Math.ceil(t.length / 34)))

/** Studio settings and the clause library (#/settings). Owners edit; everyone else reads. */
export default function StudioSettings() {
  const { me } = useTeam()
  const owner = isOwner(me)
  const [s, setS] = useState<Settings | null>(null)
  const [details, setDetails] = useState<Details | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'offline'>('loading')
  const [signedLogo, setSignedLogo] = useState<{ path: string; url: string } | null>(null)
  const [drafts, setDrafts] = useState<Partial<Record<ClauseKey, string>>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const apply = useCallback((row: Settings) => {
    const clean: Settings = { ...row, clauses: row.clauses && typeof row.clauses === 'object' ? row.clauses : {} }
    setS(clean)
    setDetails({ name: clean.name, tagline: clean.tagline, website: clean.website, email: clean.email, phone: clean.phone, gstin: clean.gstin })
  }, [])

  useEffect(() => {
    let live = true
    cacheGet<Settings>('studio_settings').then((c) => {
      if (live && c) {
        apply(c)
        setState((x) => (x === 'loading' ? 'ready' : x))
      }
    })
    supabase
      .from('studio_settings')
      .select(SETTINGS_SELECT)
      .eq('id', 1)
      .maybeSingle()
      .then(({ data, error: err }) => {
        if (!live) return
        if (err || !data) {
          setState((x) => (x === 'loading' && !err ? 'ready' : 'offline'))
          return
        }
        apply(data as unknown as Settings)
        void cacheSet('studio_settings', data)
        setState('ready')
      })
    return () => {
      live = false
    }
  }, [apply])

  useEffect(() => {
    const path = s?.logo_path
    if (!path) return
    let live = true
    supabase.storage
      .from(MEDIA_BUCKET)
      .createSignedUrl(path, 3600)
      .then(({ data }) => {
        if (live && data?.signedUrl) setSignedLogo({ path, url: data.signedUrl })
      })
    return () => {
      live = false
    }
  }, [s?.logo_path])

  /** Write to the single settings row; an update that changes nothing means the person is not an owner. */
  async function write(patch: Partial<Settings>, what: string): Promise<boolean> {
    setBusy(what)
    setError(null)
    setDone(null)
    const { data, error: err } = await supabase.from('studio_settings').update(patch).eq('id', 1).select('id')
    setBusy(null)
    if (err || !data?.length) {
      setError(err ? (navigator.onLine ? err.message : 'No signal. Changing settings needs a connection.') : 'Only an owner can change studio settings.')
      return false
    }
    const next = { ...(s as Settings), ...patch }
    setS(next)
    await cacheSet('studio_settings', next)
    setDone(what)
    return true
  }

  async function saveDetails(e: FormEvent) {
    e.preventDefault()
    if (!details) return
    const trimmed = Object.fromEntries(Object.entries(details).map(([k, v]) => [k, String(v ?? '').trim()])) as Details
    if (!trimmed.name) {
      setError('Enter the studio name.')
      return
    }
    await write(trimmed, 'details')
  }

  async function pickLogo(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setBusy('logo')
    setError(null)
    setDone(null)
    try {
      const png = await logoPng(file)
      const path = `branding/logo-${Date.now()}.png`
      const { error: upErr } = await supabase.storage.from(MEDIA_BUCKET).upload(path, png, { contentType: 'image/png' })
      if (upErr) throw new Error(navigator.onLine ? `The logo did not upload: ${upErr.message}` : 'No signal. Uploading a logo needs a connection.')
      await write({ logo_path: path }, 'logo')
    } catch (err) {
      setBusy(null)
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function saveClause(k: ClauseKey) {
    if (!s) return
    const text = drafts[k] ?? clauseText(k, s.clauses)
    const ok = await write({ clauses: { ...s.clauses, [k]: text } }, `clause:${k}`)
    if (ok) setDrafts((d) => ({ ...d, [k]: undefined }))
  }

  async function resetClause(k: ClauseKey) {
    if (!s) return
    const rest = { ...s.clauses }
    delete rest[k]
    const ok = await write({ clauses: rest }, `reset:${k}`)
    if (ok) setDrafts((d) => ({ ...d, [k]: undefined }))
  }

  const logoUrl = s?.logo_path && signedLogo?.path === s.logo_path ? signedLogo.url : DEFAULT_LOGO

  // Warnings use what is saved, plus anything being typed.
  const shown: Record<string, string> = { ...(s?.clauses ?? {}) }
  for (const k of CLAUSE_KEYS) if (drafts[k] !== undefined) shown[k] = drafts[k] as string
  const warnings = s ? clauseChecks(shown) : []

  return (
    <main className="screen">
      <header className="topbar">
        <div>
          <button type="button" className="link back" onClick={() => go('/studio')}>
            Studio
          </button>
          <h1>Studio settings</h1>
          <span className="muted small">{owner ? 'Details, logo and clause library' : 'Read only. Owners can change these.'}</span>
        </div>
      </header>

      {state === 'offline' && <p className="notice">No signal. Showing settings as last seen on this phone.</p>}
      {state === 'loading' && <p className="muted">Loading</p>}
      {error && <p className="error" role="alert">{error}</p>}

      {warnings.length > 0 && (
        <ul className="dk-checks" aria-label="Clause warnings">
          {warnings.map((w) => (
            <li key={w.text} className={`dk-check ${w.level}`}>{w.text}</li>
          ))}
        </ul>
      )}

      {s && details && (
        <>
          <form onSubmit={saveDetails} className="card stack" aria-labelledby="studio-details">
            <h2 id="studio-details" className="dk-title">Studio details</h2>
            {FIELDS.map(([k, label, type]) => (
              <label key={k} className="field">
                <span>{label}</span>
                <input
                  type={type}
                  value={String(details[k as keyof Details] ?? '')}
                  readOnly={!owner}
                  onChange={(e) => {
                    setDetails({ ...details, [k]: e.target.value })
                    setDone(null)
                  }}
                />
              </label>
            ))}
            <p className="muted small">Contact details come from the reference proposal. Confirm they are current.</p>
            {owner && (
              <button type="submit" className="primary" disabled={busy !== null}>
                {busy === 'details' ? 'Saving' : done === 'details' ? 'Details saved' : 'Save details'}
              </button>
            )}
          </form>

          <section className="card stack" aria-labelledby="studio-logo">
            <h2 id="studio-logo" className="dk-title">Logo</h2>
            <div className="dk-logo">
              <img src={logoUrl} alt="Studio logo" />
              <span className="dk-logo-name">STUDIO<br />ELEMENTS</span>
            </div>
            <p className="muted small">{s.logo_path ? 'Your uploaded logo. Used on slides and exports.' : 'The original Studio Elements logo.'}</p>
            {owner && (
              <div className="button-row">
                <label className={busy === 'logo' ? 'secondary dk-filebtn busy' : 'secondary dk-filebtn'}>
                  {busy === 'logo' ? 'Uploading' : 'Replace logo'}
                  <input type="file" accept="image/*" className="sr" onChange={pickLogo} disabled={busy !== null} aria-label="Replace logo" />
                </label>
                {s.logo_path && (
                  <button type="button" className="secondary" disabled={busy !== null} onClick={() => void write({ logo_path: null }, 'logo')}>
                    Use original logo
                  </button>
                )}
              </div>
            )}
          </section>

          <section className="stack" aria-labelledby="clauses">
            <div className="dk-head">
              <h2 id="clauses" className="dk-title">Clause library</h2>
              <p className="muted small">
                Taken from the reference proposal and used exactly as written in the proposal DOCX and PDF. Edit only with legal advice.
              </p>
            </div>
            {CLAUSE_KEYS.map((k) => {
              const overridden = s.clauses[k] != null
              const value = drafts[k] ?? clauseText(k, s.clauses)
              const dirty = drafts[k] !== undefined && drafts[k] !== clauseText(k, s.clauses)
              return (
                <div key={k} className="card stack-tight dk-clause" data-clause={k}>
                  <div className="card-head">
                    <strong className="small-title">{CLAUSE_TITLES[k]}</strong>
                    <span className={overridden ? 'tag ok' : 'tag muted'}>{overridden ? 'Edited' : 'Reference'}</span>
                  </div>
                  <textarea
                    aria-label={CLAUSE_TITLES[k]}
                    rows={rowsFor(value)}
                    value={value}
                    readOnly={!owner}
                    onChange={(e) => {
                      setDrafts((d) => ({ ...d, [k]: e.target.value }))
                      setDone(null)
                    }}
                  />
                  {owner && (
                    <div className="button-row">
                      <button type="button" className="secondary" disabled={busy !== null || !dirty} onClick={() => void saveClause(k)}>
                        {busy === `clause:${k}` ? 'Saving' : done === `clause:${k}` && !dirty ? 'Saved' : 'Save clause'}
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        disabled={busy !== null || (!overridden && !dirty)}
                        onClick={() => (overridden ? void resetClause(k) : setDrafts((d) => ({ ...d, [k]: undefined })))}
                      >
                        Reset to reference text
                      </button>
                    </div>
                  )}
                  {overridden && value === REFERENCE_CLAUSES[k] && <span className="muted small">Same as the reference text.</span>}
                </div>
              )
            })}
          </section>
        </>
      )}
    </main>
  )
}
