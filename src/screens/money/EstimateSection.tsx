import { useMemo, useState, type FormEvent } from 'react'
import { ESTIMATE_CATEGORIES, UNITS, type BoqItem } from '../../domain'
import { estimateTotals, lineAmount, type EstimateSettings } from '../../estimate'
import { inr, num } from '../../format'
import { groupByCategory, settingsFromBrief } from '../../money/boq'
import { PDF_TICKS, pdfTicks, type PdfKey, type PdfTicks } from '../../money/clientPdf'
import { buildLedger, overrunText, type LineLedger } from '../../money/ledger'
import { supabase } from '../../supabase'
import { exportClientPdf, exportCsv, exportXlsx } from './exports'
import { Err, errText, Figure, inrN, parseNum, type SectionProps } from './shared'

type Draft = { cont: string; gst: string; budget: string; incl: boolean; area: string; unit: string }
const toDraft = (s: EstimateSettings): Draft => ({
  cont: String(s.contingency_pct), gst: String(s.estimate_gst_rate), budget: s.client_budget == null ? '' : String(s.client_budget),
  incl: s.budget_includes_gst, area: s.area == null ? '' : String(s.area), unit: s.area_unit,
})
const fromDraft = (d: Draft): EstimateSettings => ({
  contingency_pct: parseNum(d.cont) ?? 0, estimate_gst_rate: parseNum(d.gst) ?? 0, client_budget: parseNum(d.budget),
  budget_includes_gst: d.incl, area: parseNum(d.area), area_unit: d.unit,
})

export default function EstimateSection({ projectId, m, owner, writable }: SectionProps) {
  const d = m.data
  const saved = useMemo(() => settingsFromBrief(d.brief), [d.brief])
  const [draft, setDraft] = useState<Draft>(() => toDraft(saved))
  const [savedKey, setSavedKey] = useState(() => JSON.stringify(toDraft(saved)))
  // When the stored settings change (after a save or reload), start again from them.
  if (JSON.stringify(toDraft(saved)) !== savedKey) {
    setSavedKey(JSON.stringify(toDraft(saved)))
    setDraft(toDraft(saved))
  }
  const dirty = JSON.stringify(draft) !== savedKey
  const settings = fromDraft(draft)
  const live = d.items.filter((i) => !i.removed_at)
  const removed = d.items.filter((i) => i.removed_at)
  const totals = estimateTotals(live, settings)
  const ledger = useMemo(() => buildLedger(d.items, d.bills, d.billLines, d.variations), [d.items, d.bills, d.billLines, d.variations])
  const [editing, setEditing] = useState<string | 'new' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const groups = groupByCategory(live)
  const woName = (id: string | null) => {
    const wo = d.workOrders.find((w) => w.id === id)
    return wo ? d.vendors.find((v) => v.id === wo.vendor_id)?.name ?? 'work order' : null
  }

  async function saveSettings() {
    const bad = [['Contingency', draft.cont, 0, 50], ['GST', draft.gst, 0, 28]].find(([, v, lo, hi]) => {
      const x = parseNum(v as string)
      return x === null || x < (lo as number) || x > (hi as number)
    })
    if (bad) {
      setError(`${bad[0]} must be between ${bad[2]} and ${bad[3]}%.`)
      return
    }
    setBusy(true)
    setError(null)
    const s = fromDraft(draft)
    const { error: err } = await supabase.from('project_briefs').upsert(
      { project_id: projectId, contingency_pct: s.contingency_pct, estimate_gst_rate: s.estimate_gst_rate, client_budget: s.client_budget, budget_includes_gst: s.budget_includes_gst, area: s.area, area_unit: s.area_unit },
      { onConflict: 'project_id' },
    )
    setBusy(false)
    if (err) setError(errText(err, 'Saving the settings'))
    await m.reload()
  }

  async function setRemoved(i: BoqItem, remove: boolean) {
    setError(null)
    const { error: err } = await supabase.from('boq_items').update({ removed_at: remove ? new Date().toISOString() : null }).eq('id', i.id)
    if (err) setError(errText(err, remove ? 'Removing a line' : 'Restoring a line'))
    setEditing(null)
    await m.reload()
  }

  const set = (k: keyof Draft) => (e: { target: { value: string } }) => setDraft({ ...draft, [k]: e.target.value })
  const variance = totals.variance

  return (
    <div className="stack">
      <div className="card m-totals">
        <div className="m-hero">
          <span className="muted small">Estimate total</span>
          <strong>{inr(totals.total)}</strong>
          {variance !== null && (
            <span className={variance < 0 ? 'm-var over' : 'm-var'} role="status">
              {variance < 0 ? `Estimate exceeds budget by ${inr(-variance)}. Nothing has been adjusted.` : `Within budget. Remaining ${inr(variance)}`}
              <span className="muted small"> ({settings.budget_includes_gst ? 'budget includes GST' : 'compared before GST'})</span>
            </span>
          )}
        </div>
        <div className="m-figs">
          {groups.map((g) => (
            <Figure key={g.category} label={g.category} value={inr(totals.byCategory[g.category] ?? 0)} />
          ))}
          <Figure label="Subtotal" value={inr(totals.subtotal)} strong />
          <Figure label="Contingency" value={inr(totals.contingency)}>
            <PctInput label="Contingency %" value={draft.cont} onChange={set('cont')} disabled={!writable} />
          </Figure>
          <Figure label="Taxable" value={inr(totals.taxable)} />
          <Figure label="GST" value={inr(totals.gst)}>
            <PctInput label="GST %" value={draft.gst} onChange={set('gst')} disabled={!writable} />
          </Figure>
          <Figure label="Total" value={inr(totals.total)} strong />
          <Figure label={`Cost per sq. ft.`} value={totals.perSqft ? inr(totals.perSqft) : '—'} />
          {!totals.perSqft && <p className="muted small">Add the area below to see the cost per sq. ft. (before GST).</p>}
        </div>
        <details className="m-details">
          <summary>Budget and area</summary>
          <div className="stack m-pad">
            <label className="field">
              <span>Client budget (₹)</span>
              <input type="number" inputMode="decimal" min="0" value={draft.budget} onChange={set('budget')} disabled={!writable} />
            </label>
            <label className="check">
              <input type="checkbox" checked={draft.incl} onChange={(e) => setDraft({ ...draft, incl: e.target.checked })} disabled={!writable} />
              Budget includes GST
            </label>
            <div className="two">
              <label className="field">
                <span>Area</span>
                <input type="number" inputMode="decimal" min="0" value={draft.area} onChange={set('area')} disabled={!writable} />
              </label>
              <label className="field">
                <span>Unit</span>
                <select value={draft.unit} onChange={set('unit')} disabled={!writable}>
                  <option value="sq. ft.">sq. ft.</option>
                  <option value="sq. m.">sq. m.</option>
                </select>
              </label>
            </div>
          </div>
        </details>
        {dirty && writable && (
          <div className="button-row">
            <button type="button" className="primary" onClick={saveSettings} disabled={busy}>
              {busy ? 'Saving' : 'Save settings'}
            </button>
            <button type="button" className="secondary" onClick={() => setDraft(toDraft(saved))}>
              Undo
            </button>
          </div>
        )}
      </div>

      <Err text={error} />

      {writable && editing !== 'new' && (
        <button type="button" className="secondary" onClick={() => setEditing('new')}>
          Add a line
        </button>
      )}
      {editing === 'new' && <LineEditor projectId={projectId} m={m} line={null} owner={owner} onDone={() => setEditing(null)} onRemove={setRemoved} />}

      {live.length === 0 && <p className="muted">No lines yet. Add the first line of the estimate; rates are never filled in for you.</p>}

      {groups.map((g) => (
        <div key={g.category} className="stack-tight">
          <div className="row-line m-cat">
            <h2>{g.category}</h2>
            <span className="small nowrap">{inr(totals.byCategory[g.category] ?? 0)}</span>
          </div>
          <ul className="rows">
            {g.items.map((i) => (
              <li key={i.id}>
                {editing === i.id ? (
                  <LineEditor projectId={projectId} m={m} line={i} owner={owner} onDone={() => setEditing(null)} onRemove={setRemoved} />
                ) : (
                  <LineRow line={i} l={ledger.lines[i.id]} wo={woName(i.work_order_id)} onOpen={writable ? () => setEditing(i.id) : undefined} />
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}

      {live.length > 0 && (
        <div className="stack-tight">
          <h2>Ledger by category</h2>
          <div className="m-scroll">
            <table className="m-table">
              <thead>
                <tr>
                  <th>Category</th>
                  <th>Budget</th>
                  <th>Committed</th>
                  <th>Certified</th>
                  <th>Paid</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => {
                  const c = ledger.categories[g.category]
                  return (
                    <tr key={g.category}>
                      <th>{g.category}</th>
                      <td>{inr(c.budget)}</td>
                      <td>{inr(c.committed)}</td>
                      <td>{inr(c.certified)}</td>
                      <td>{inr(c.paid)}</td>
                    </tr>
                  )
                })}
                <tr className="m-total-row">
                  <th>Total</th>
                  <td>{inr(ledger.total.budget)}</td>
                  <td>{inr(ledger.total.committed)}</td>
                  <td>{inr(ledger.total.certified)}</td>
                  <td>{inr(ledger.total.paid)}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="muted small">Budget leaves out optional lines and is before contingency and GST. Certified and paid are valued at each bill line's rate, before GST.</p>
        </div>
      )}

      <ExportCard projectId={projectId} m={m} settings={settings} writable={writable} />

      {owner && removed.length > 0 && (
        <details className="m-details">
          <summary>Removed lines ({removed.length})</summary>
          <ul className="rows">
            {removed.map((i) => (
              <li key={i.id} className="row-line padded">
                <span className="muted">
                  {i.item} · {i.category}
                </span>
                {writable && (
                  <button type="button" className="pill" onClick={() => setRemoved(i, false)}>
                    Restore
                  </button>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

function PctInput({ label, value, onChange, disabled }: { label: string; value: string; onChange: (e: { target: { value: string } }) => void; disabled: boolean }) {
  return (
    <span className="m-pct">
      <input type="number" inputMode="decimal" aria-label={label} value={value} onChange={onChange} disabled={disabled} min="0" step="0.5" />%
    </span>
  )
}

function LineRow({ line: i, l, wo, onOpen }: { line: BoqItem; l: LineLedger | undefined; wo: string | null; onOpen?: () => void }) {
  const showLedger = l && (l.committed || l.certified || l.paid)
  const body = (
    <>
      <span className="row-line">
        <span className="row-title">{i.item}</span>
        <span className="nowrap m-amt">{inr(lineAmount(i))}</span>
      </span>
      <span className="muted small">
        {[i.room, `${num(i.quantity).toLocaleString('en-IN', { maximumFractionDigits: 3 })} ${i.unit} × ${inrN(num(i.rate))}`, num(i.wastage_pct) ? `+${num(i.wastage_pct)}% wastage` : null, i.trade]
          .filter(Boolean)
          .join(' · ')}
      </span>
      <span className="m-tags">
        <span className={i.verified ? 'tag ok' : 'tag muted'}>{i.verified ? 'Verified' : 'Unverified'}</span>
        {i.optional && <span className="tag muted">Optional, not in total</span>}
        {i.rate_source && <span className="muted small">Rate: {i.rate_source}</span>}
      </span>
      {showLedger ? (
        <span className="m-ledger small">
          <span>Committed {inr(l.committed)}</span>
          <span>Certified {inr(l.certified)}</span>
          <span>Paid {inr(l.paid)}</span>
          {wo && <span className="muted">WO: {wo}</span>}
        </span>
      ) : null}
      {l?.overrun && (
        <span className="flag-text small m-overrun">
          <span className="dot m-dot-risk" aria-hidden="true" />
          {overrunText(l)}
        </span>
      )}
    </>
  )
  return onOpen ? (
    <button type="button" className="row" onClick={onOpen}>
      {body}
    </button>
  ) : (
    <div className="row">{body}</div>
  )
}

function LineEditor({ projectId, m, line, owner, onDone, onRemove }: {
  projectId: string; m: SectionProps['m']; line: BoqItem | null; owner: boolean; onDone: () => void; onRemove: (i: BoqItem, remove: boolean) => Promise<void>
}) {
  const p = m.data.project
  const [category, setCategory] = useState(line?.category ?? ESTIMATE_CATEGORIES[0])
  const [item, setItem] = useState(line?.item ?? '')
  const [room, setRoom] = useState(line?.room ?? '')
  const [trade, setTrade] = useState(line?.trade ?? '')
  const [qty, setQty] = useState(line ? String(num(line.quantity)) : '')
  const [unit, setUnit] = useState(line?.unit ?? 'sq. ft.')
  const [rate, setRate] = useState(line ? String(num(line.rate)) : '')
  const [waste, setWaste] = useState(line ? String(num(line.wastage_pct)) : '0')
  const [source, setSource] = useState(line?.rate_source ?? '')
  const [verified, setVerified] = useState(line?.verified ?? false)
  const [optional, setOptional] = useState(line?.optional ?? false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState(false)
  const rooms = [...new Set([...(p?.rooms ?? []), ...(room ? [room] : [])])]
  const trades = [...new Set([...(p?.trades ?? []), ...(trade ? [trade] : [])])]
  const cats = [...new Set([...ESTIMATE_CATEGORIES, category])]
  const units = [...new Set([...UNITS, unit])]
  const q = parseNum(qty)
  const r = parseNum(rate)
  const w = parseNum(waste) ?? 0
  const preview = q !== null && r !== null ? lineAmount({ quantity: q, rate: r, wastage_pct: w }) : null

  async function save(e: FormEvent) {
    e.preventDefault()
    if (!item.trim()) return setError('Name the item.')
    if (q === null || q < 0) return setError('Enter the quantity.')
    if (r === null || r < 0) return setError('Enter the rate. Rates are never filled in for you.')
    if (w < 0 || w > 100) return setError('Wastage must be between 0 and 100%.')
    setBusy(true)
    setError(null)
    const row = { category, item: item.trim(), room: room || null, trade: trade || null, quantity: q, unit, rate: r, wastage_pct: w, rate_source: source.trim(), verified, optional }
    const sameCat = m.data.items.filter((i) => i.category === category)
    const { error: err } = line
      ? await supabase.from('boq_items').update(row).eq('id', line.id)
      : await supabase.from('boq_items').insert({ ...row, project_id: projectId, sort_order: sameCat.reduce((mx, i) => Math.max(mx, num(i.sort_order)), 0) + 1 })
    setBusy(false)
    if (err) return setError(errText(err, 'Saving the line'))
    await m.reload()
    onDone()
  }

  return (
    <form className="card stack m-editor" onSubmit={save}>
      <h2>{line ? 'Edit line' : 'Add a line'}</h2>
      <label className="field">
        <span>Category</span>
        <select value={category} onChange={(e) => setCategory(e.target.value)}>
          {cats.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Item</span>
        <input type="text" value={item} onChange={(e) => setItem(e.target.value)} placeholder="Vitrified tiles 800 × 800" />
      </label>
      <div className="two">
        <label className="field">
          <span>Room</span>
          <select value={room} onChange={(e) => setRoom(e.target.value)}>
            <option value="">—</option>
            {rooms.map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Trade</span>
          <select value={trade} onChange={(e) => setTrade(e.target.value)}>
            <option value="">—</option>
            {trades.map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="two">
        <label className="field">
          <span>Quantity</span>
          <input type="number" inputMode="decimal" min="0" step="any" value={qty} onChange={(e) => setQty(e.target.value)} />
        </label>
        <label className="field">
          <span>Unit</span>
          <select value={unit} onChange={(e) => setUnit(e.target.value)}>
            {units.map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="two">
        <label className="field">
          <span>Rate (₹)</span>
          <input type="number" inputMode="decimal" min="0" step="any" value={rate} onChange={(e) => setRate(e.target.value)} />
        </label>
        <label className="field">
          <span>Wastage %</span>
          <input type="number" inputMode="decimal" min="0" max="100" step="any" value={waste} onChange={(e) => setWaste(e.target.value)} />
        </label>
      </div>
      <label className="field">
        <span>Rate source</span>
        <input type="text" value={source} onChange={(e) => setSource(e.target.value)} placeholder="Agency quote, market rate, last project…" />
      </label>
      <div className="two">
        <label className="check">
          <input type="checkbox" checked={verified} onChange={(e) => setVerified(e.target.checked)} />
          Rate verified
        </label>
        <label className="check">
          <input type="checkbox" checked={optional} onChange={(e) => setOptional(e.target.checked)} />
          Optional
        </label>
      </div>
      <p className="muted small" aria-live="polite">
        {preview === null ? 'Amount = quantity × rate × (1 + wastage %)' : `Amount ${inr(preview)}${optional ? ' (optional, not in the total)' : ''}`}
      </p>
      <Err text={error} />
      <div className="button-row">
        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Saving' : 'Save'}
        </button>
        <button type="button" className="secondary" onClick={onDone}>
          Cancel
        </button>
      </div>
      {line && owner && !confirm && (
        <button type="button" className="danger-outline" onClick={() => setConfirm(true)}>
          Remove line
        </button>
      )}
      {line && owner && confirm && (
        <div className="confirm stack-tight">
          <p className="small">Remove “{line.item}”? It leaves the estimate and can be restored from Removed lines.</p>
          <div className="button-row">
            <button type="button" className="danger" onClick={() => onRemove(line, true)}>
              Remove
            </button>
            <button type="button" className="secondary" onClick={() => setConfirm(false)}>
              Keep
            </button>
          </div>
        </div>
      )}
    </form>
  )
}

function ExportCard({ projectId, m, settings, writable }: { projectId: string; m: SectionProps['m']; settings: EstimateSettings; writable: boolean }) {
  const d = m.data
  const [ticks, setTicks] = useState<PdfTicks>(() => pdfTicks(d.brief?.estimate_pdf))
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function run(what: string, fn: () => Promise<void>) {
    setBusy(what)
    setError(null)
    try {
      await fn()
    } catch (err) {
      setError(`Could not make the ${what}: ${err instanceof Error ? err.message : String(err)}`)
    }
    setBusy(null)
  }

  async function tick(k: PdfKey, on: boolean) {
    const next = { ...ticks, [k]: on }
    setTicks(next)
    if (!writable) return
    const { error: err } = await supabase.from('project_briefs').upsert({ project_id: projectId, estimate_pdf: next }, { onConflict: 'project_id' })
    if (err) setError(errText(err, 'Saving the PDF ticks'))
  }

  return (
    <div className="card stack">
      <h2>Export</h2>
      <div className="button-row m-three">
        <button type="button" className="secondary" disabled={!!busy} onClick={() => run('XLSX', () => exportXlsx(d, d.items, settings))}>
          {busy === 'XLSX' ? 'Making' : 'XLSX'}
        </button>
        <button type="button" className="secondary" disabled={!!busy} onClick={() => run('CSV', () => exportCsv(d, d.items, settings))}>
          {busy === 'CSV' ? 'Making' : 'CSV'}
        </button>
        <button type="button" className="secondary" disabled={!!busy} onClick={() => run('PDF', () => exportClientPdf(d, d.items, settings, ticks))}>
          {busy === 'PDF' ? 'Making' : 'Client PDF'}
        </button>
      </div>
      <details className="m-details">
        <summary>What the client PDF shows</summary>
        <div className="m-ticks">
          {PDF_TICKS.map((t) => (
            <label key={t.key} className="check">
              <input type="checkbox" checked={ticks[t.key]} onChange={(e) => tick(t.key, e.target.checked)} />
              <span>
                {t.label}
                {t.internal && <span className="muted small"> · internal</span>}
              </span>
            </label>
          ))}
        </div>
      </details>
      <Err text={error} />
    </div>
  )
}
