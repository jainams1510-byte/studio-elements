import { useState } from 'react'
import { todayLocal } from '../../drawings'
import { COST_CATEGORIES, type StudioCost } from '../../domain'
import { inr, longDate, num } from '../../format'
import { margin, LOW_MARGIN_PCT, type Margin } from '../../fees/money'
import { supabase } from '../../supabase'
import type { FeesData } from './FeesTab'
import { NumField, errorText } from './parts'

type Form = { spent_on: string; category: StudioCost['category']; vendor_id: string; amount: number | null; status: 'planned' | 'paid'; note: string }

const blank = (): Form => ({ spent_on: todayLocal(), category: 'Site visit', vendor_id: '', amount: null, status: 'paid', note: '' })

export function MarginCard({ m }: { m: Margin }) {
  const pct = (v: number | null) => (v === null ? '—' : `${v}%`)
  const low = (v: number | null) => v !== null && v < LOW_MARGIN_PCT
  return (
    <div className="card stack-tight fees-margin" aria-label="Margin">
      <h2>Margin (fee before GST − studio costs)</h2>
      <div className="two">
        <div>
          <span className="muted small">To date</span>
          <b className={low(m.toDatePct) ? 'fees-big late' : 'fees-big'} data-testid="margin-to-date">
            {inr(m.toDate)}
          </b>
          <span className="small">{pct(m.toDatePct)}</span>
        </div>
        <div>
          <span className="muted small">Forecast</span>
          <b className={low(m.forecastPct) ? 'fees-big late' : 'fees-big'} data-testid="margin-forecast">
            {inr(m.forecast)}
          </b>
          <span className="small">{pct(m.forecastPct)}</span>
        </div>
      </div>
      <p className="muted small">
        To date counts paid costs; the forecast adds planned ones. Fee <span className="nowrap">{inr(m.fee)}</span> · paid{' '}
        <span className="nowrap">{inr(m.paidCosts)}</span> · planned <span className="nowrap">{inr(m.plannedCosts)}</span>
      </p>
    </div>
  )
}

export default function CostsSection({ projectId, data, readOnly, reload }: { projectId: string; data: FeesData; readOnly: boolean; reload: () => Promise<void> }) {
  const [form, setForm] = useState<Form | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const live = data.costs.filter((c) => !c.removed_at).sort((a, b) => b.spent_on.localeCompare(a.spent_on))
  const removed = data.costs.filter((c) => c.removed_at)
  const m = margin(num(data.fee?.fee_amount), data.costs)
  const vendorName = (id: string | null) => data.vendors.find((v) => v.id === id)?.name

  async function run(q: PromiseLike<{ error: { message: string } | null }>) {
    setBusy(true)
    setError(null)
    const { error: e } = await q
    setBusy(false)
    const msg = errorText(e)
    if (msg) return setError(msg)
    setForm(null)
    setEditing(null)
    await reload()
  }

  function save() {
    if (!form) return
    if (form.amount == null || form.amount <= 0) return setError('Enter the amount.')
    if (!form.spent_on) return setError('Enter the date.')
    const row = { spent_on: form.spent_on, category: form.category, vendor_id: form.vendor_id || null, amount: form.amount, status: form.status, note: form.note.trim() }
    void run(editing ? supabase.from('studio_costs').update(row).eq('id', editing) : supabase.from('studio_costs').insert({ project_id: projectId, ...row }))
  }

  const formView = form && (
    <div className="card stack-tight fees-form" aria-label={editing ? 'Edit studio cost' : 'Add studio cost'}>
      <div className="two">
        <label className="field">
          <span>Date</span>
          <input type="date" value={form.spent_on} onChange={(e) => setForm({ ...form, spent_on: e.target.value })} />
        </label>
        <NumField label="Amount (₹)" value={form.amount} onChange={(v) => setForm({ ...form, amount: v })} />
      </div>
      <label className="field">
        <span>Category</span>
        <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value as Form['category'] })}>
          {COST_CATEGORIES.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Vendor (optional)</span>
        <select value={form.vendor_id} onChange={(e) => setForm({ ...form, vendor_id: e.target.value })}>
          <option value="">None</option>
          {data.vendors
            .filter((v) => !v.archived || v.id === form.vendor_id)
            .map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
        </select>
      </label>
      <div className="chips" role="group" aria-label="Cost status">
        {(['paid', 'planned'] as const).map((s) => (
          <button key={s} type="button" className={form.status === s ? 'chip on' : 'chip'} aria-pressed={form.status === s} onClick={() => setForm({ ...form, status: s })}>
            {s === 'paid' ? 'Paid' : 'Planned'}
          </button>
        ))}
      </div>
      <label className="field">
        <span>Note</span>
        <input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
      </label>
      <div className="button-row">
        <button type="button" className="primary" disabled={busy} onClick={save}>
          {editing ? 'Save' : 'Add cost'}
        </button>
        <button type="button" className="secondary" onClick={() => { setForm(null); setEditing(null) }}>
          Cancel
        </button>
      </div>
    </div>
  )

  return (
    <section className="stack" aria-label="Studio costs">
      <MarginCard m={m} />
      <div className="card-head">
        <h2>Studio costs</h2>
        <span className="small muted" data-testid="costs-totals">
          Paid {inr(m.paidCosts)} · planned {inr(m.plannedCosts)}
        </span>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!readOnly && !form && (
        <button type="button" className="secondary" onClick={() => { setEditing(null); setForm(blank()) }}>
          Add a studio cost
        </button>
      )}
      {!editing && formView}
      {live.length === 0 && <p className="muted">No studio costs yet.</p>}
      <ul className="rows">
        {live.map((c) => (
          <li key={c.id}>
            {editing === c.id ? (
              formView
            ) : (
              <div className="row fees-cost">
                <span className="row-line">
                  <span className="row-title small-title">
                    {c.category}
                    {vendorName(c.vendor_id) ? ` · ${vendorName(c.vendor_id)}` : ''}
                  </span>
                  <b className="nowrap">{inr(num(c.amount))}</b>
                </span>
                <span className="row-line">
                  <span className="muted small">
                    {longDate(c.spent_on)}
                    {c.note ? ` · ${c.note}` : ''}
                  </span>
                  <span className={c.status === 'paid' ? 'tag ok' : 'tag muted'}>{c.status === 'paid' ? 'Paid' : 'Planned'}</span>
                </span>
                {!readOnly && (
                  <span className="fees-actions">
                    <button
                      type="button"
                      className="pill"
                      onClick={() => {
                        setEditing(c.id)
                        setForm({ spent_on: c.spent_on, category: c.category, vendor_id: c.vendor_id ?? '', amount: num(c.amount), status: c.status, note: c.note ?? '' })
                      }}
                    >
                      Edit
                    </button>
                    <button type="button" className="pill" onClick={() => run(supabase.from('studio_costs').update({ removed_at: new Date().toISOString() }).eq('id', c.id))}>
                      Remove
                    </button>
                  </span>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
      {removed.length > 0 && (
        <details>
          <summary className="small">Removed costs ({removed.length})</summary>
          <ul className="rows">
            {removed.map((c) => (
              <li key={c.id} className="row-line padded">
                <span className="small">
                  {c.category} · {inr(num(c.amount))} · {longDate(c.spent_on)}
                </span>
                {!readOnly && (
                  <button type="button" className="pill" onClick={() => run(supabase.from('studio_costs').update({ removed_at: null }).eq('id', c.id))}>
                    Restore
                  </button>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}
