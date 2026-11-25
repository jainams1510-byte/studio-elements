import { useMemo, useState, type FormEvent } from 'react'
import { todayLocal } from '../../drawings'
import { VARIATION_STEPS, type BoqItem, type Variation } from '../../domain'
import { inr, longDate, num } from '../../format'
import { sortedLines } from '../../money/boq'
import { buildLedger, overrunText } from '../../money/ledger'
import { supabase } from '../../supabase'
import { Err, errText, parseNum, type SectionProps } from './shared'

type VStatus = Variation['status']
const LABEL: Record<VStatus, string> = { proposed: 'Proposed', costed: 'Costed', client_approved: 'Client approved', executed: 'Executed', billed: 'Billed' }

export default function VariationsSection({ projectId, m, owner, writable }: SectionProps) {
  const d = m.data
  const [adding, setAdding] = useState<{ boq: string; description: string } | null>(null)
  const [linking, setLinking] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const ledger = useMemo(() => buildLedger(d.items, d.bills, d.billLines, d.variations), [d.items, d.bills, d.billLines, d.variations])
  const items = new Map(d.items.map((i) => [i.id, i]))
  const live = d.variations.filter((v) => !v.removed_at)
  const removed = d.variations.filter((v) => v.removed_at)
  const overruns = sortedLines(d.items).filter((i) => ledger.lines[i.id]?.overrun)
  const total = live.reduce((s, v) => s + num(v.amount), 0)
  const approved = live.filter((v) => VARIATION_STEPS.indexOf(v.status) >= 2).reduce((s, v) => s + num(v.amount), 0)

  async function update(v: Variation, patch: Partial<Variation>, what: string) {
    setError(null)
    const { error: err } = await supabase.from('variations').update(patch).eq('id', v.id)
    if (err) setError(errText(err, what))
    await m.reload()
  }

  const setStatus = (v: Variation, status: VStatus) =>
    update(v, { status, client_approved_on: VARIATION_STEPS.indexOf(status) >= 2 ? (v.client_approved_on ?? todayLocal()) : null }, 'Changing the status')

  return (
    <div className="stack">
      {overruns.length > 0 && (
        <ul className="stack-tight">
          {overruns.map((i) => (
            <li key={i.id} className="flag flagrow m-flag-col">
              <span>
                <span className="dot m-dot-risk" aria-hidden="true" />
                <strong>{i.item}</strong>: {overrunText(ledger.lines[i.id])}
              </span>
              {writable && (
                <button type="button" className="pill" onClick={() => setAdding({ boq: i.id, description: `Extra over estimate: ${i.item}` })}>
                  Add variation
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="m-figs card">
        <div className="m-fig">
          <span className="m-fig-label">All live variations</span>
          <span className="m-fig-value">{inr(total)}</span>
        </div>
        <div className="m-fig">
          <span className="m-fig-label">Client approved or later</span>
          <span className="m-fig-value">{inr(approved)}</span>
        </div>
      </div>
      <Err text={error} />
      {writable && !adding && (
        <button type="button" className="secondary" onClick={() => setAdding({ boq: '', description: '' })}>
          Add a variation
        </button>
      )}
      {adding && <VariationForm projectId={projectId} m={m} initial={adding} onDone={() => setAdding(null)} />}
      {live.length === 0 && <p className="muted">No variations. Decisions with a cost impact add one here automatically.</p>}
      <ul className="stack">
        {live.map((v) => {
          const item = v.boq_item_id ? items.get(v.boq_item_id) : undefined
          const decision = v.decision_id ? d.decisions.find((x) => x.id === v.decision_id) : undefined
          return (
            <li key={v.id} className="card stack-tight">
              <div className="row-line">
                <span className="row-title">{v.description}</span>
                <span className={num(v.amount) < 0 ? 'nowrap m-amt muted' : 'nowrap m-amt'}>{inr(num(v.amount))}</span>
              </div>
              {decision && <span className="small">From decision: “{decision.question}”</span>}
              {v.decision_id && !decision && <span className="muted small">From a decision</span>}
              <span className="muted small">
                BOQ line: {item ? `${item.item}${item.removed_at ? ' (removed)' : ''}` : 'not linked'}
                {v.client_approved_on ? ` · client approved ${longDate(v.client_approved_on)}` : ''}
              </span>
              <div className="chips m-mini" role="group" aria-label={`Status of ${v.description}`}>
                {VARIATION_STEPS.map((s, n) => (
                  <button
                    key={s}
                    type="button"
                    className={v.status === s ? 'chip on' : n < VARIATION_STEPS.indexOf(v.status) ? 'chip m-done' : 'chip'}
                    aria-pressed={v.status === s}
                    disabled={!writable}
                    onClick={() => v.status !== s && setStatus(v, s)}
                  >
                    {LABEL[s]}
                  </button>
                ))}
              </div>
              {writable && linking !== v.id && (
                <div className="m-actions">
                  <button type="button" className="pill" onClick={() => setLinking(v.id)}>
                    {item ? 'Change BOQ line' : 'Link a BOQ line'}
                  </button>
                  {owner && (
                    <button type="button" className="pill" onClick={() => update(v, { removed_at: new Date().toISOString() }, 'Removing the variation')}>
                      Remove
                    </button>
                  )}
                </div>
              )}
              {linking === v.id && (
                <LinkLine
                  items={d.items}
                  current={v.boq_item_id}
                  onCancel={() => setLinking(null)}
                  onSave={async (boq) => {
                    await update(v, { boq_item_id: boq }, 'Linking the BOQ line')
                    setLinking(null)
                  }}
                />
              )}
            </li>
          )
        })}
      </ul>
      {owner && removed.length > 0 && (
        <details className="m-details">
          <summary>Removed variations ({removed.length})</summary>
          <ul className="rows">
            {removed.map((v) => (
              <li key={v.id} className="row-line padded">
                <span className="muted">{v.description}</span>
                {writable && (
                  <button type="button" className="pill" onClick={() => update(v, { removed_at: null }, 'Restoring the variation')}>
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

function LineSelect({ items, value, onChange, label = 'BOQ line' }: { items: BoqItem[]; value: string; onChange: (v: string) => void; label?: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Not linked</option>
        {sortedLines(items).map((i) => (
          <option key={i.id} value={i.id}>
            {i.item}
            {i.room ? ` · ${i.room}` : ''}
          </option>
        ))}
      </select>
    </label>
  )
}

function LinkLine({ items, current, onSave, onCancel }: { items: BoqItem[]; current: string | null; onSave: (id: string | null) => Promise<void>; onCancel: () => void }) {
  const [value, setValue] = useState(current ?? '')
  return (
    <div className="m-sub stack">
      <LineSelect items={items} value={value} onChange={setValue} />
      <div className="button-row">
        <button type="button" className="primary" onClick={() => onSave(value || null)}>
          Save link
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}

function VariationForm({ projectId, m, initial, onDone }: { projectId: string; m: SectionProps['m']; initial: { boq: string; description: string }; onDone: () => void }) {
  const [description, setDescription] = useState(initial.description)
  const [amount, setAmount] = useState('')
  const [boq, setBoq] = useState(initial.boq)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save(e: FormEvent) {
    e.preventDefault()
    if (!description.trim()) return setError('Describe the variation.')
    const a = parseNum(amount)
    if (a === null) return setError('Enter the amount (negative for a saving).')
    setBusy(true)
    setError(null)
    const { error: err } = await supabase
      .from('variations')
      .insert({ project_id: projectId, description: description.trim(), amount: a, boq_item_id: boq || null, status: 'proposed', decision_id: null })
    setBusy(false)
    if (err) return setError(errText(err, 'Saving the variation'))
    await m.reload()
    onDone()
  }

  return (
    <form className="card stack" onSubmit={save}>
      <h2>Add a variation</h2>
      <label className="field">
        <span>Description</span>
        <input type="text" value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <label className="field">
        <span>Amount (₹)</span>
        <input type="number" inputMode="decimal" step="any" value={amount} onChange={(e) => setAmount(e.target.value)} />
      </label>
      <LineSelect items={m.data.items} value={boq} onChange={setBoq} />
      <Err text={error} />
      <div className="button-row">
        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Saving' : 'Save variation'}
        </button>
        <button type="button" className="secondary" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  )
}
