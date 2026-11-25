import { useState, type FormEvent } from 'react'
import { todayLocal } from '../../drawings'
import { RA_BILL_SELECT, RA_STEP_LABEL, RA_STEPS, type BoqItem, type RaBill, type RaBillLine, type RaStatus } from '../../domain'
import { inr, inrExact, longDate, num } from '../../format'
import { sortedLines } from '../../money/boq'
import { claimedFromLines, isCertified, payable, stepIndex, stepPatch, suggestedCertified, unpaidDays } from '../../money/bills'
import { billLineRate } from '../../money/ledger'
import { supabase } from '../../supabase'
import { useVendorPicker } from './QuotesSection'
import { Err, errText, Figure, inrN, parseNum, Stepper, type SectionProps } from './shared'

const NEXT_LABEL: Record<RaStatus, string> = { submitted: 'Submitted', measured: 'Mark measured', certified: 'Certify', client_approved: 'Client approved', paid: 'Mark paid' }
const STATUS_TAG: Record<RaStatus, string> = { submitted: 'htag none', measured: 'htag none', certified: 'htag ok', client_approved: 'htag ok', paid: 'htag ok' }

export default function BillsSection({ projectId, m, owner, writable }: SectionProps) {
  const d = m.data
  const [adding, setAdding] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const today = todayLocal()
  const vendorName = (id: string) => d.vendors.find((v) => v.id === id)?.name ?? 'Unknown vendor'
  const live = d.bills.filter((b) => !b.removed_at).sort((a, b) => b.bill_date.localeCompare(a.bill_date) || b.bill_no.localeCompare(a.bill_no, 'en', { numeric: true }))
  const removed = d.bills.filter((b) => b.removed_at)
  const unpaid = live.filter((b) => unpaidDays(b, today) !== null)

  async function setRemoved(b: RaBill, remove: boolean) {
    setError(null)
    const { error: err } = await supabase.from('ra_bills').update({ removed_at: remove ? new Date().toISOString() : null }).eq('id', b.id)
    if (err) setError(errText(err, remove ? 'Removing the bill' : 'Restoring the bill'))
    await m.reload()
  }

  return (
    <div className="stack">
      {unpaid.length > 0 && (
        <ul className="stack-tight">
          {unpaid.map((b) => (
            <li key={b.id} className="flag flagrow">
              <span className="dot m-dot-risk" aria-hidden="true" />
              <span>
                <strong>
                  {vendorName(b.vendor_id)} RA bill {b.bill_no}
                </strong>
                : Client approved {unpaidDays(b, today)} days ago, unpaid. A reminder is drafted for you to send.
              </span>
            </li>
          ))}
        </ul>
      )}
      <Err text={error} />
      {writable && !adding && (
        <button type="button" className="secondary" onClick={() => setAdding(true)}>
          New bill
        </button>
      )}
      {adding && (
        <NewBill
          projectId={projectId}
          m={m}
          onDone={(id) => {
            setAdding(false)
            if (id) setOpen(id)
          }}
        />
      )}
      {live.length === 0 && <p className="muted">No RA bills yet.</p>}
      <ul className="stack">
        {live.map((b) => {
          const lines = d.billLines.filter((l) => l.bill_id === b.id)
          const pay = payable(b)
          const days = unpaidDays(b, today)
          return (
            <li key={b.id} className="card stack-tight m-bill">
              <button type="button" className="row m-bill-head" aria-expanded={open === b.id} onClick={() => setOpen(open === b.id ? null : b.id)}>
                <span className="row-line">
                  <span className="row-title">
                    {vendorName(b.vendor_id)} · RA bill {b.bill_no}
                  </span>
                  <span className={STATUS_TAG[b.status]}>{RA_STEP_LABEL[b.status]}</span>
                </span>
                <span className="muted small">
                  {longDate(b.bill_date)} · claimed {inrN(num(b.claimed_amount))}
                  {b.certified_amount != null && isCertified(b.status) ? ` · certified ${inrN(num(b.certified_amount))} · payable ${inrN(pay.total)}` : ''}
                  {` · ${lines.length}\u00a0line${lines.length === 1 ? '' : 's'}`}
                </span>
                {days !== null && <span className="flag-text small">Client approved {days} days ago, unpaid</span>}
              </button>
              {open === b.id && <BillDetail bill={b} lines={lines} m={m} owner={owner} writable={writable} onRemove={() => setRemoved(b, true)} />}
            </li>
          )
        })}
      </ul>
      {owner && removed.length > 0 && (
        <details className="m-details">
          <summary>Removed bills ({removed.length})</summary>
          <ul className="rows">
            {removed.map((b) => (
              <li key={b.id} className="row-line padded">
                <span className="muted">
                  {vendorName(b.vendor_id)} · RA bill {b.bill_no}
                </span>
                {writable && (
                  <button type="button" className="pill" onClick={() => setRemoved(b, false)}>
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

function NewBill({ projectId, m, onDone }: { projectId: string; m: SectionProps['m']; onDone: (id: string | null) => void }) {
  const d = m.data
  const picker = useVendorPicker(m)
  const [woId, setWoId] = useState('')
  const [billNo, setBillNo] = useState('')
  const [date, setDate] = useState(todayLocal())
  const [claimed, setClaimed] = useState('')
  const [gst, setGst] = useState('18')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const orders = d.workOrders.filter((w) => !w.removed_at && (!picker.vendorId || w.vendor_id === picker.vendorId))

  async function save(e: FormEvent) {
    e.preventDefault()
    const c = parseNum(claimed)
    const g = parseNum(gst)
    if (!billNo.trim()) return setError('Enter the bill number.')
    if (c === null || c < 0) return setError('Enter the claimed amount.')
    if (g === null || g < 0 || g > 28) return setError('GST must be between 0 and 28%.')
    setBusy(true)
    setError(null)
    const v = await picker.resolve()
    if ('error' in v) {
      setBusy(false)
      return setError(v.error)
    }
    const wo = d.workOrders.find((w) => w.id === woId && w.vendor_id === v.id)
    const { data, error: err } = await supabase
      .from('ra_bills')
      .insert({ project_id: projectId, vendor_id: v.id, work_order_id: wo?.id ?? null, bill_no: billNo.trim(), bill_date: date, claimed_amount: c, gst_rate: g, status: 'submitted', certified_amount: null })
      .select(RA_BILL_SELECT)
      .single()
    setBusy(false)
    if (err || !data) return setError(err?.code === '23505' ? `This agency already has a bill numbered ${billNo.trim()} on this project.` : errText(err, 'Saving the bill'))
    await m.reload()
    onDone((data as unknown as RaBill).id)
  }

  return (
    <form className="card stack" onSubmit={save}>
      <h2>New RA bill</h2>
      {picker.ui(d.project?.trades ?? [])}
      {orders.length > 0 && (
        <label className="field">
          <span>Work order, optional</span>
          <select value={woId} onChange={(e) => setWoId(e.target.value)}>
            <option value="">None</option>
            {orders.map((w) => (
              <option key={w.id} value={w.id}>
                {[d.vendors.find((v) => v.id === w.vendor_id)?.name, w.trade, inr(num(w.amount))].filter(Boolean).join(' · ')}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="two">
        <label className="field">
          <span>Bill no.</span>
          <input type="text" value={billNo} onChange={(e) => setBillNo(e.target.value)} />
        </label>
        <label className="field">
          <span>Bill date</span>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
      </div>
      <div className="two">
        <label className="field">
          <span>Claimed (₹, before GST)</span>
          <input type="number" inputMode="decimal" min="0" step="any" value={claimed} onChange={(e) => setClaimed(e.target.value)} />
        </label>
        <label className="field">
          <span>GST %</span>
          <input type="number" inputMode="decimal" min="0" max="28" step="any" value={gst} onChange={(e) => setGst(e.target.value)} />
        </label>
      </div>
      <Err text={error} />
      <div className="button-row">
        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Saving' : 'Save bill'}
        </button>
        <button type="button" className="secondary" onClick={() => onDone(null)}>
          Cancel
        </button>
      </div>
    </form>
  )
}

function BillDetail({ bill: b, lines, m, owner, writable, onRemove }: { bill: RaBill; lines: RaBillLine[]; m: SectionProps['m']; owner: boolean; writable: boolean; onRemove: () => void }) {
  const d = m.data
  const items = new Map(d.items.map((i) => [i.id, i]))
  const certified = isCertified(b.status)
  const locked = certified && !owner
  const editable = writable && !locked
  const suggested = suggestedCertified(lines, items)
  const [cert, setCert] = useState(b.certified_amount != null ? String(num(b.certified_amount)) : '')
  const certValue = parseNum(cert) ?? (lines.length ? suggested : null)
  const pay = payable(b, certified ? null : certValue)
  const [paid, setPaid] = useState('')
  const [back, setBack] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const at = stepIndex(b.status)
  const next = RA_STEPS[at + 1] as RaStatus | undefined
  const prev = RA_STEPS[at - 1] as RaStatus | undefined

  async function move(to: RaStatus) {
    setError(null)
    const opts: { certifiedAmount?: number | null; paidAmount?: number | null } = {}
    if (to === 'certified' && !certified) {
      if (certValue === null || certValue < 0) return setError('Enter the certified amount before certifying.')
      opts.certifiedAmount = certValue
    }
    if (to === 'paid') {
      const p = parseNum(paid)
      if (p !== null && p < 0) return setError('The paid amount cannot be negative.')
      opts.paidAmount = p
    }
    setBusy(true)
    const { error: err } = await supabase.from('ra_bills').update(stepPatch(b, to, todayLocal(), opts)).eq('id', b.id)
    setBusy(false)
    setBack(false)
    if (err) return setError(errText(err, 'Changing the status'))
    await m.reload()
  }

  async function saveCertified() {
    const v = parseNum(cert)
    if (v === null || v < 0) return setError('Enter the certified amount.')
    setBusy(true)
    const { error: err } = await supabase.from('ra_bills').update({ certified_amount: v }).eq('id', b.id)
    setBusy(false)
    if (err) return setError(errText(err, 'Saving the certified amount'))
    await m.reload()
  }

  return (
    <div className="stack m-bill-body">
      <Stepper steps={RA_STEPS} current={b.status} labels={RA_STEP_LABEL} dates={{ submitted: b.bill_date, certified: b.certified_on, client_approved: b.client_approved_on, paid: b.paid_on }} />

      <BillLines bill={b} lines={lines} m={m} editable={editable} />

      <div className="m-figs">
        <Figure label="Claimed" value={inrExact(num(b.claimed_amount))} />
        {lines.length > 0 && <Figure label="Lines, claimed qty" value={inrExact(claimedFromLines(lines, items))} />}
        {lines.length > 0 && <Figure label="Lines, certified qty" value={inrExact(suggested)} />}
        {certified ? (
          <Figure label="Certified" value={b.certified_amount != null ? inrExact(num(b.certified_amount)) : '—'} strong />
        ) : null}
        <Figure label={`GST ${num(b.gst_rate)}%${certified ? '' : ' (on the amount below)'}`} value={inrExact(pay.gst)} />
        <Figure label={certified ? 'Total payable' : 'Total payable if certified as below'} value={inrExact(pay.total)} strong />
        {b.status === 'paid' && b.paid_amount != null && <Figure label={`Paid ${longDate(b.paid_on)}`} value={inrExact(num(b.paid_amount))} />}
      </div>

      {(!certified || owner) && writable && (
        <div className="two m-cert">
          <label className="field">
            <span>Certified amount (₹, before GST)</span>
            <input type="number" inputMode="decimal" min="0" step="any" value={cert} placeholder={lines.length ? String(suggested) : ''} onChange={(e) => setCert(e.target.value)} />
          </label>
          <div className="m-cert-actions">
            {lines.length > 0 && (
              <button type="button" className="pill" onClick={() => setCert(String(suggested))}>
                Use lines total
              </button>
            )}
            {certified && owner && parseNum(cert) !== num(b.certified_amount) && (
              <button type="button" className="pill" disabled={busy} onClick={saveCertified}>
                Save amount
              </button>
            )}
          </div>
        </div>
      )}
      {!certified && <p className="muted small">Left empty, the certified amount is the lines total (certified qty × rate).</p>}
      {locked && <p className="notice">Certified on {longDate(b.certified_on)}. The certified amount and the bill lines are locked; only an owner can change them or move the bill back a step.</p>}

      {next === 'paid' && writable && (
        <label className="field">
          <span>Paid amount (₹), if different</span>
          <input type="number" inputMode="decimal" min="0" step="any" value={paid} placeholder={String(payable(b).total)} onChange={(e) => setPaid(e.target.value)} />
        </label>
      )}
      <Err text={error} />
      {writable && next && (
        <button type="button" className="primary" disabled={busy} onClick={() => move(next)}>
          {NEXT_LABEL[next]}
        </button>
      )}
      {writable && owner && prev && !back && (
        <button type="button" className="secondary" onClick={() => setBack(true)}>
          Step back to {RA_STEP_LABEL[prev]}
        </button>
      )}
      {back && prev && (
        <div className="confirm stack-tight">
          <p className="small">
            Move this bill back to {RA_STEP_LABEL[prev]}? This clears the dates stamped for the later steps
            {at >= 2 ? ' (certified, client approved and paid dates as they apply)' : ''}; they are stamped again when the bill moves forward.
          </p>
          <div className="button-row">
            <button type="button" className="primary" disabled={busy} onClick={() => move(prev)}>
              Step back
            </button>
            <button type="button" className="secondary" onClick={() => setBack(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {b.file_link && (
        <a className="small" href={b.file_link} target="_blank" rel="noreferrer">
          Open the bill file
        </a>
      )}
      {owner && writable && (
        <button type="button" className="link left small" onClick={onRemove}>
          Remove bill
        </button>
      )}
    </div>
  )
}

function BillLines({ bill, lines, m, editable }: { bill: RaBill; lines: RaBillLine[]; m: SectionProps['m']; editable: boolean }) {
  const d = m.data
  const items = new Map(d.items.map((i) => [i.id, i]))
  const [qty, setQty] = useState<Record<string, { c: string; k: string }>>(() =>
    Object.fromEntries(lines.map((l) => [l.id, { c: String(num(l.claimed_qty)), k: l.certified_qty == null ? '' : String(num(l.certified_qty)) }])),
  )
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const changed = lines.filter((l) => {
    const q = qty[l.id]
    return q && (parseNum(q.c) !== num(l.claimed_qty) || parseNum(q.k) !== (l.certified_qty == null ? null : num(l.certified_qty)))
  })

  async function saveQty() {
    setBusy(true)
    setError(null)
    for (const l of changed) {
      const c = parseNum(qty[l.id].c) ?? 0
      const k = parseNum(qty[l.id].k)
      if (c < 0 || (k !== null && k < 0)) {
        setBusy(false)
        return setError('Quantities cannot be negative.')
      }
      const { error: err } = await supabase.from('ra_bill_lines').update({ claimed_qty: c, certified_qty: k }).eq('id', l.id)
      if (err) {
        setBusy(false)
        return setError(errText(err, 'Saving quantities'))
      }
    }
    setBusy(false)
    await m.reload()
  }

  return (
    <div className="stack-tight">
      <h2>Bill lines</h2>
      {lines.length === 0 && <p className="muted small">No BOQ lines on this bill yet. Add them to value the measurement.</p>}
      <ul className="rows">
        {lines.map((l) => {
          const it = items.get(l.boq_item_id)
          const rate = billLineRate(l, it)
          const q = qty[l.id] ?? { c: String(num(l.claimed_qty)), k: l.certified_qty == null ? '' : String(num(l.certified_qty)) }
          return (
            <li key={l.id} className="m-bline">
              <span className="row-line">
                <span className="row-title small-title">{it?.item ?? 'Removed BOQ line'}</span>
                <span className="muted small nowrap">@ {inr(rate)}</span>
              </span>
              {editable ? (
                <div className="two">
                  <label className="field">
                    <span>Claimed qty{it ? ` (${it.unit})` : ''}</span>
                    <input type="number" inputMode="decimal" min="0" step="any" aria-label={`Claimed qty for ${it?.item ?? 'line'}`} value={q.c} onChange={(e) => setQty({ ...qty, [l.id]: { ...q, c: e.target.value } })} />
                  </label>
                  <label className="field">
                    <span>Certified qty</span>
                    <input type="number" inputMode="decimal" min="0" step="any" aria-label={`Certified qty for ${it?.item ?? 'line'}`} value={q.k} onChange={(e) => setQty({ ...qty, [l.id]: { ...q, k: e.target.value } })} />
                  </label>
                </div>
              ) : null}
              <span className="small m-bline-amts">
                <span>
                  Claimed {num(l.claimed_qty)} = {inr(num(l.claimed_qty) * rate)}
                </span>
                <span>
                  Certified {l.certified_qty == null ? '—' : `${num(l.certified_qty)} = ${inr(num(l.certified_qty) * rate)}`}
                </span>
              </span>
            </li>
          )
        })}
      </ul>
      {editable && changed.length > 0 && (
        <button type="button" className="primary" disabled={busy} onClick={saveQty}>
          {busy ? 'Saving' : 'Save quantities'}
        </button>
      )}
      <Err text={error} />
      {editable && !adding && (
        <button type="button" className="secondary" onClick={() => setAdding(true)}>
          Add a BOQ line
        </button>
      )}
      {adding && <AddLine bill={bill} lines={lines} m={m} onDone={() => setAdding(false)} />}
    </div>
  )
}

function AddLine({ bill, lines, m, onDone }: { bill: RaBill; lines: RaBillLine[]; m: SectionProps['m']; onDone: () => void }) {
  const d = m.data
  const onBill = new Set(lines.map((l) => l.boq_item_id))
  const all = sortedLines(d.items).filter((i) => !onBill.has(i.id))
  const ofOrder = bill.work_order_id ? all.filter((i) => i.work_order_id === bill.work_order_id) : []
  const [onlyOrder, setOnlyOrder] = useState(ofOrder.length > 0)
  const choices: BoqItem[] = onlyOrder ? ofOrder : all
  const [itemId, setItemId] = useState('')
  const [claimed, setClaimed] = useState('')
  const [certified, setCertified] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const it = d.items.find((i) => i.id === itemId)

  async function save(e: FormEvent) {
    e.preventDefault()
    if (!it) return setError('Pick a BOQ line.')
    const c = parseNum(claimed)
    const k = parseNum(certified)
    if (c === null || c < 0) return setError('Enter the claimed quantity.')
    if (k !== null && k < 0) return setError('The certified quantity cannot be negative.')
    setBusy(true)
    setError(null)
    // The rate is the BOQ committed rate, else the estimate rate (the database fills the same when it is left out).
    const rate = it.committed_rate != null ? num(it.committed_rate) : num(it.rate)
    const { error: err } = await supabase.from('ra_bill_lines').insert({ bill_id: bill.id, boq_item_id: it.id, claimed_qty: c, certified_qty: k, rate })
    setBusy(false)
    if (err) return setError(err.code === '23505' ? 'That BOQ line is already on this bill.' : errText(err, 'Adding the line'))
    await m.reload()
    onDone()
  }

  return (
    <form className="m-sub stack" onSubmit={save}>
      {ofOrder.length > 0 && (
        <label className="check">
          <input type="checkbox" checked={onlyOrder} onChange={(e) => setOnlyOrder(e.target.checked)} />
          Only lines on this bill’s work order
        </label>
      )}
      <label className="field">
        <span>BOQ line</span>
        <select aria-label="BOQ line" value={itemId} onChange={(e) => setItemId(e.target.value)}>
          <option value="">Choose</option>
          {choices.map((i) => (
            <option key={i.id} value={i.id}>
              {i.item}
              {i.room ? ` · ${i.room}` : ''}
            </option>
          ))}
        </select>
      </label>
      {it && (
        <p className="muted small">
          Estimate {num(it.quantity)} {it.unit} · bill rate {inr(it.committed_rate != null ? num(it.committed_rate) : num(it.rate))}
          {it.committed_rate != null ? ' (committed)' : ' (estimate)'}
        </p>
      )}
      <div className="two">
        <label className="field">
          <span>Claimed qty</span>
          <input type="number" inputMode="decimal" min="0" step="any" value={claimed} onChange={(e) => setClaimed(e.target.value)} />
        </label>
        <label className="field">
          <span>Certified qty</span>
          <input type="number" inputMode="decimal" min="0" step="any" value={certified} onChange={(e) => setCertified(e.target.value)} />
        </label>
      </div>
      <Err text={error} />
      <div className="button-row">
        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Adding' : 'Add line'}
        </button>
        <button type="button" className="secondary" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  )
}
