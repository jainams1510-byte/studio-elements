import { useState, type FormEvent } from 'react'
import { todayLocal } from '../../drawings'
import { QUOTE_STATUSES, VENDOR_KINDS, VENDOR_SELECT, type BoqItem, type Quote, type Vendor, type WorkOrder } from '../../domain'
import { lineAmount } from '../../estimate'
import { inr, longDate, num, round2 } from '../../format'
import { sortedLines } from '../../money/boq'
import { committedAmount } from '../../money/ledger'
import { compareQuotes } from '../../money/quotes'
import { supabase } from '../../supabase'
import { Err, errText, inrN, parseNum, type SectionProps } from './shared'

const STATUS_LABEL: Record<Quote['status'], string> = { received: 'Received', compared: 'Compared', accepted: 'Accepted', rejected: 'Rejected' }
const NEW_VENDOR = '__new__'

export default function QuotesSection({ projectId, m, owner, writable }: SectionProps) {
  const d = m.data
  const [adding, setAdding] = useState(false)
  const [issuing, setIssuing] = useState<Quote | null>(null)
  const [linesFor, setLinesFor] = useState<WorkOrder | null>(null)
  const [error, setError] = useState<string | null>(null)
  const vendorName = (id: string) => d.vendors.find((v) => v.id === id)?.name ?? 'Unknown vendor'
  const groups = compareQuotes(d.quotes, d.items)
  const liveOrders = d.workOrders.filter((w) => !w.removed_at)
  const committedOf = (wo: WorkOrder) => round2(d.items.filter((i) => !i.removed_at && i.work_order_id === wo.id).reduce((s, i) => s + committedAmount(i), 0))
  const totalCommitted = round2(liveOrders.reduce((s, w) => s + committedOf(w), 0))

  async function setStatus(q: Quote, status: Quote['status']) {
    setError(null)
    const { error: err } = await supabase.from('quotes').update({ status }).eq('id', q.id)
    if (err) setError(errText(err, 'Changing the status'))
    await m.reload()
  }

  async function setRemoved(table: 'quotes' | 'work_orders', id: string, remove: boolean) {
    setError(null)
    const { error: err } = await supabase.from(table).update({ removed_at: remove ? new Date().toISOString() : null }).eq('id', id)
    if (err) setError(errText(err, remove ? 'Removing' : 'Restoring'))
    await m.reload()
  }

  return (
    <div className="stack">
      <Err text={error} />
      {writable && !adding && (
        <button type="button" className="secondary" onClick={() => setAdding(true)}>
          Add a quote
        </button>
      )}
      {adding && <QuoteForm projectId={projectId} m={m} onDone={() => setAdding(false)} />}

      {groups.length === 0 && <p className="muted">No quotes yet.</p>}
      {groups.map((g) => (
        <div key={g.trade} className="card stack-tight">
          <div className="card-head">
            <strong>{g.trade}</strong>
            <span className="muted small">{g.lines ? `Estimate ${inr(g.budget)}` : 'No estimate lines for this trade'}</span>
          </div>
          <ul className="rows">
            {g.quotes.map(({ quote: q, diff, lowest }) => {
              const order = liveOrders.find((w) => w.quote_id === q.id)
              return (
                <li key={q.id} className={lowest ? 'm-quote lowest' : 'm-quote'}>
                  <div className="row">
                    <span className="row-line">
                      <span className="row-title">{vendorName(q.vendor_id)}</span>
                      <span className="nowrap m-amt">{inr(num(q.amount))}</span>
                    </span>
                    <span className="m-tags">
                      {lowest && <span className="tag ok">Lowest</span>}
                      {diff !== null && (
                        <span className={diff > 0 ? 'small m-over' : 'small muted'}>
                          {diff === 0 ? 'Same as estimate' : diff > 0 ? `${inrN(diff)} over estimate` : `${inrN(-diff)} under estimate`}
                        </span>
                      )}
                      <span className="muted small">{longDate(q.received_on)}</span>
                    </span>
                    {q.note && <span className="small">{q.note}</span>}
                    {q.file_link && (
                      <a className="small" href={q.file_link} target="_blank" rel="noreferrer">
                        Open the quote file
                      </a>
                    )}
                    <div className="chips m-mini" role="group" aria-label={`Status of ${vendorName(q.vendor_id)} quote`}>
                      {QUOTE_STATUSES.map((s) => (
                        <button key={s} type="button" className={q.status === s ? 'chip on' : 'chip'} aria-pressed={q.status === s} disabled={!writable} onClick={() => q.status !== s && setStatus(q, s)}>
                          {STATUS_LABEL[s]}
                        </button>
                      ))}
                    </div>
                    {q.status === 'accepted' && !order && writable && issuing?.id !== q.id && (
                      <button type="button" className="primary" onClick={() => setIssuing(q)}>
                        Issue work order
                      </button>
                    )}
                    {order && <span className="small">Work order issued {longDate(order.issued_on)}</span>}
                    {owner && writable && (
                      <button type="button" className="link left small" onClick={() => setRemoved('quotes', q.id, true)}>
                        Remove quote
                      </button>
                    )}
                  </div>
                  {issuing?.id === q.id && <WorkOrderForm projectId={projectId} m={m} quote={q} onDone={() => setIssuing(null)} />}
                </li>
              )
            })}
          </ul>
        </div>
      ))}

      <div className="stack-tight">
        <div className="row-line">
          <h2>Work orders</h2>
          <span className="small nowrap">Committed {inr(totalCommitted)}</span>
        </div>
        {liveOrders.length === 0 && <p className="muted small">None yet. Accept a quote to issue one.</p>}
        <ul className="rows">
          {liveOrders.map((w) => {
            const lines = d.items.filter((i) => !i.removed_at && i.work_order_id === w.id)
            return (
              <li key={w.id}>
                <div className="row">
                  <span className="row-line">
                    <span className="row-title">{vendorName(w.vendor_id)}</span>
                    <span className="nowrap m-amt">{inr(num(w.amount))}</span>
                  </span>
                  <span className="muted small">
                    {[w.trade, `issued ${longDate(w.issued_on)}`, `${lines.length} BOQ line${lines.length === 1 ? '' : 's'}`].filter(Boolean).join(' · ')}
                  </span>
                  <span className="small">Committed on BOQ lines {inr(committedOf(w))}</span>
                  {writable && (
                    <div className="m-actions">
                      <button type="button" className="pill" onClick={() => setLinesFor(linesFor?.id === w.id ? null : w)}>
                        BOQ lines
                      </button>
                      {owner && (
                        <button type="button" className="pill" onClick={() => setRemoved('work_orders', w.id, true)}>
                          Remove
                        </button>
                      )}
                    </div>
                  )}
                </div>
                {linesFor?.id === w.id && <AssignLines m={m} order={w} onDone={() => setLinesFor(null)} />}
              </li>
            )
          })}
        </ul>
      </div>

      {owner && (d.quotes.some((q) => q.removed_at) || d.workOrders.some((w) => w.removed_at)) && (
        <details className="m-details">
          <summary>Removed quotes and work orders</summary>
          <ul className="rows">
            {d.quotes.filter((q) => q.removed_at).map((q) => (
              <li key={q.id} className="row-line padded">
                <span className="muted">Quote · {vendorName(q.vendor_id)} · {inr(num(q.amount))}</span>
                {writable && <button type="button" className="pill" onClick={() => setRemoved('quotes', q.id, false)}>Restore</button>}
              </li>
            ))}
            {d.workOrders.filter((w) => w.removed_at).map((w) => (
              <li key={w.id} className="row-line padded">
                <span className="muted">Work order · {vendorName(w.vendor_id)} · {inr(num(w.amount))}</span>
                {writable && <button type="button" className="pill" onClick={() => setRemoved('work_orders', w.id, false)}>Restore</button>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

/** Vendor picker with an inline "new vendor" form. Returns the chosen or newly added vendor id. */
export function useVendorPicker(m: SectionProps['m']) {
  const [vendorId, setVendorId] = useState('')
  const [name, setName] = useState('')
  const [kind, setKind] = useState<Vendor['kind']>('agency')
  const [trade, setTrade] = useState('')
  const [phone, setPhone] = useState('')
  const vendors = m.data.vendors.filter((v) => !v.archived).sort((a, b) => a.name.localeCompare(b.name))

  async function resolve(): Promise<{ id: string } | { error: string }> {
    if (vendorId !== NEW_VENDOR) return vendorId ? { id: vendorId } : { error: 'Pick a vendor, or add a new one.' }
    const clean = name.trim().replace(/\s+/g, ' ')
    if (!clean) return { error: 'Enter the new vendor’s name.' }
    const dup = m.data.vendors.find((v) => v.name.trim().toLowerCase() === clean.toLowerCase())
    if (dup) return { error: `A vendor called “${dup.name}” already exists${dup.archived ? ' (removed)' : ''}. Pick it from the list instead.` }
    const { data, error } = await supabase.from('vendors').insert({ name: clean, kind, trade: trade || null, phone: phone.trim() || null }).select(VENDOR_SELECT).single()
    if (error || !data) {
      return { error: error?.code === '23505' ? `A vendor called “${clean}” already exists. Pick it from the list instead.` : errText(error, 'Adding the vendor') }
    }
    setVendorId((data as unknown as Vendor).id)
    return { id: (data as unknown as Vendor).id }
  }

  const ui = (trades: string[]) => (
    <>
      <label className="field">
        <span>Vendor</span>
        <select aria-label="Vendor" value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
          <option value="">Choose</option>
          {vendors.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
          <option value={NEW_VENDOR}>+ New vendor</option>
        </select>
      </label>
      {vendorId === NEW_VENDOR && (
        <div className="m-sub stack">
          <label className="field">
            <span>New vendor name</span>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <div className="two">
            <label className="field">
              <span>Kind</span>
              <select value={kind} onChange={(e) => setKind(e.target.value as Vendor['kind'])}>
                {VENDOR_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k[0].toUpperCase() + k.slice(1)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Vendor trade</span>
              <select value={trade} onChange={(e) => setTrade(e.target.value)}>
                <option value="">—</option>
                {trades.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
            </label>
          </div>
          <label className="field">
            <span>Phone</span>
            <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </label>
        </div>
      )}
    </>
  )
  return { vendorId, setVendorId, resolve, ui }
}

function QuoteForm({ projectId, m, onDone }: { projectId: string; m: SectionProps['m']; onDone: () => void }) {
  const picker = useVendorPicker(m)
  const trades = m.data.project?.trades ?? []
  const [trade, setTrade] = useState('')
  const [amount, setAmount] = useState('')
  const [date, setDate] = useState(todayLocal())
  const [note, setNote] = useState('')
  const [link, setLink] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save(e: FormEvent) {
    e.preventDefault()
    const a = parseNum(amount)
    if (a === null || a < 0) return setError('Enter the quoted amount.')
    setBusy(true)
    setError(null)
    const v = await picker.resolve()
    if ('error' in v) {
      setBusy(false)
      return setError(v.error)
    }
    const { error: err } = await supabase.from('quotes').insert({
      project_id: projectId, vendor_id: v.id, trade: trade || null, amount: a, received_on: date, status: 'received', note: note.trim(), file_link: link.trim() || null,
    })
    setBusy(false)
    if (err) return setError(errText(err, 'Saving the quote'))
    await m.reload()
    onDone()
  }

  return (
    <form className="card stack" onSubmit={save}>
      <h2>Add a quote</h2>
      {picker.ui(trades)}
      <div className="two">
        <label className="field">
          <span>Trade</span>
          <select aria-label="Trade" value={trade} onChange={(e) => setTrade(e.target.value)}>
            <option value="">—</option>
            {trades.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Amount (₹)</span>
          <input type="number" inputMode="decimal" min="0" step="any" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
      </div>
      <label className="field">
        <span>Received on</span>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </label>
      <label className="field">
        <span>Note</span>
        <input type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Inclusions, exclusions, validity" />
      </label>
      <label className="field">
        <span>Link to the quote file, optional</span>
        <input type="url" value={link} onChange={(e) => setLink(e.target.value)} placeholder="Drive link" />
      </label>
      <Err text={error} />
      <div className="button-row">
        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Saving' : 'Save quote'}
        </button>
        <button type="button" className="secondary" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  )
}

type LinePick = Record<string, { on: boolean; rate: string }>
const tradeLines = (items: BoqItem[], trade: string | null) =>
  sortedLines(items).filter((i) => !trade || (i.trade ?? '').trim().toLowerCase() === trade.trim().toLowerCase())

function LinePicker({ lines, pick, setPick, orders, current, vendorName }: {
  lines: BoqItem[]; pick: LinePick; setPick: (p: LinePick) => void; orders: WorkOrder[]; current: string | null; vendorName: (id: string) => string
}) {
  if (!lines.length) return <p className="muted small">No BOQ lines carry this trade yet.</p>
  return (
    <ul className="rows">
      {lines.map((i) => {
        const p = pick[i.id] ?? { on: false, rate: String(num(i.rate)) }
        const other = i.work_order_id && i.work_order_id !== current ? orders.find((w) => w.id === i.work_order_id) : null
        const r = parseNum(p.rate)
        return (
          <li key={i.id} className="m-pick">
            <label className="check">
              <input type="checkbox" checked={p.on} onChange={(e) => setPick({ ...pick, [i.id]: { ...p, on: e.target.checked } })} />
              <span>
                {i.item}
                <span className="muted small">
                  {' '}
                  · {num(i.quantity).toLocaleString('en-IN')} {i.unit} · estimate {inrN(lineAmount(i))}
                  {other ? ` · now on ${vendorName(other.vendor_id)}’s order` : ''}
                </span>
              </span>
            </label>
            {p.on && (
              <div className="m-pick-rate">
                <label className="field">
                  <span>Committed rate (₹)</span>
                  <input type="number" inputMode="decimal" min="0" step="any" aria-label={`Committed rate for ${i.item}`} value={p.rate} onChange={(e) => setPick({ ...pick, [i.id]: { ...p, rate: e.target.value } })} />
                </label>
                <span className="small m-pick-amt">{r !== null ? `Committed ${inrN(num(i.quantity) * r)} (${num(i.quantity).toLocaleString('en-IN')} ${i.unit} × rate)` : ''}</span>
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}

async function saveLines(lines: BoqItem[], pick: LinePick, orderId: string): Promise<string | null> {
  for (const i of lines) {
    const p = pick[i.id]
    const was = i.work_order_id === orderId
    if (p?.on) {
      const r = parseNum(p.rate)
      if (r === null || r < 0) return `Enter a committed rate for ${i.item}.`
      if (!was || num(i.committed_rate) !== r) {
        const { error } = await supabase.from('boq_items').update({ work_order_id: orderId, committed_rate: r }).eq('id', i.id)
        if (error) return errText(error, 'Assigning lines')
      }
    } else if (was) {
      const { error } = await supabase.from('boq_items').update({ work_order_id: null, committed_rate: null }).eq('id', i.id)
      if (error) return errText(error, 'Unassigning lines')
    }
  }
  return null
}

function WorkOrderForm({ projectId, m, quote, onDone }: { projectId: string; m: SectionProps['m']; quote: Quote; onDone: () => void }) {
  const d = m.data
  const [amount, setAmount] = useState(String(num(quote.amount)))
  const [date, setDate] = useState(todayLocal())
  const [note, setNote] = useState('')
  const lines = tradeLines(d.items, quote.trade)
  const [pick, setPick] = useState<LinePick>(() => Object.fromEntries(lines.map((i) => [i.id, { on: !i.work_order_id, rate: String(num(i.rate)) }])))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const vendorName = (id: string) => d.vendors.find((v) => v.id === id)?.name ?? 'Unknown vendor'

  async function save(e: FormEvent) {
    e.preventDefault()
    const a = parseNum(amount)
    if (a === null || a < 0) return setError('Enter the work order amount.')
    for (const i of lines) if (pick[i.id]?.on && (parseNum(pick[i.id].rate) ?? -1) < 0) return setError(`Enter a committed rate for ${i.item}.`)
    setBusy(true)
    setError(null)
    const { data, error: err } = await supabase
      .from('work_orders')
      .insert({ project_id: projectId, vendor_id: quote.vendor_id, quote_id: quote.id, trade: quote.trade, amount: a, issued_on: date, note: note.trim() })
      .select('id')
      .single()
    if (err || !data) {
      setBusy(false)
      return setError(errText(err, 'Issuing the work order'))
    }
    const lineErr = await saveLines(lines, pick, (data as { id: string }).id)
    setBusy(false)
    await m.reload()
    if (lineErr) return setError(`Work order saved, but: ${lineErr}`)
    onDone()
  }

  return (
    <form className="card stack m-inset" onSubmit={save}>
      <h2>Work order for {vendorName(quote.vendor_id)}</h2>
      <p className="muted small">Recorded here to track commitments; the order itself is issued by you.</p>
      <div className="two">
        <label className="field">
          <span>Amount (₹)</span>
          <input type="number" inputMode="decimal" min="0" step="any" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        <label className="field">
          <span>Issued on</span>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
      </div>
      <label className="field">
        <span>Note</span>
        <input type="text" value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <h2>BOQ lines{quote.trade ? ` for ${quote.trade}` : ''}</h2>
      <LinePicker lines={lines} pick={pick} setPick={setPick} orders={d.workOrders} current={null} vendorName={vendorName} />
      <Err text={error} />
      <div className="button-row">
        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Saving' : 'Save work order'}
        </button>
        <button type="button" className="secondary" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  )
}

function AssignLines({ m, order, onDone }: { m: SectionProps['m']; order: WorkOrder; onDone: () => void }) {
  const d = m.data
  const lines = tradeLines(d.items, order.trade)
  const [pick, setPick] = useState<LinePick>(() =>
    Object.fromEntries(lines.map((i) => [i.id, { on: i.work_order_id === order.id, rate: String(num(i.work_order_id === order.id && i.committed_rate != null ? i.committed_rate : i.rate)) }])),
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const vendorName = (id: string) => d.vendors.find((v) => v.id === id)?.name ?? 'Unknown vendor'

  async function save() {
    setBusy(true)
    setError(null)
    const err = await saveLines(lines, pick, order.id)
    setBusy(false)
    await m.reload()
    if (err) return setError(err)
    onDone()
  }

  return (
    <div className="card stack m-inset">
      <h2>BOQ lines on this order</h2>
      <LinePicker lines={lines} pick={pick} setPick={setPick} orders={d.workOrders} current={order.id} vendorName={vendorName} />
      <Err text={error} />
      <div className="button-row">
        <button type="button" className="primary" disabled={busy} onClick={save}>
          {busy ? 'Saving' : 'Save lines'}
        </button>
        <button type="button" className="secondary" onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  )
}
