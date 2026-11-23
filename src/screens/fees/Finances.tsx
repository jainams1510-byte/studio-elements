import { useState } from 'react'
import { todayLocal } from '../../drawings'
import {
  COST_SELECT, FEE_SELECT, INVOICE_SELECT, RA_BILL_SELECT, RA_STEP_LABEL,
  type FeeInvoice, type ProjectFee, type RaBill, type StudioCost,
} from '../../domain'
import { inr, inrShort, longDate, num } from '../../format'
import { DEFAULT_TERMS_DAYS, invoiceDue, invoiceTotals, overdueDays } from '../../fees/invoices'
import { LOW_MARGIN_PCT, cashFlow, margin, sum, type CashWeek } from '../../fees/money'
import { one, rows, useLoad } from '../../fees/useLoad'
import { billTotal } from '../../fees/vendors'
import { go } from '../../hooks'
import { formatDay } from '../../schedule'
import { supabase } from '../../supabase'
import { isOwner, useTeam } from '../../team'
import { usePortfolio } from '../../usePortfolio'
import { NumField, OwnerOnly, Tile, errorText } from './parts'

type FinData = {
  fees: ProjectFee[]
  invoices: FeeInvoice[]
  costs: StudioCost[]
  openingCash: number
  bills: RaBill[]
  vendors: { id: string; name: string }[]
}

async function loadFinances(): Promise<FinData> {
  const [f, i, c, s, b, v] = await Promise.all([
    supabase.from('project_fees').select(FEE_SELECT),
    supabase.from('fee_invoices').select(INVOICE_SELECT).is('removed_at', null),
    supabase.from('studio_costs').select(COST_SELECT).is('removed_at', null),
    supabase.from('studio_private').select('id, opening_cash').limit(1).maybeSingle(),
    supabase.from('ra_bills').select(RA_BILL_SELECT).is('removed_at', null),
    supabase.from('vendors').select('id, name'),
  ])
  return {
    fees: rows<ProjectFee>(f),
    invoices: rows<FeeInvoice>(i).filter((x) => !x.removed_at),
    costs: rows<StudioCost>(c).filter((x) => !x.removed_at),
    openingCash: num(one<{ opening_cash: number }>(s)?.opening_cash),
    bills: b.error ? [] : ((b.data ?? []) as unknown as RaBill[]).filter((x) => !x.removed_at),
    vendors: v.error ? [] : ((v.data ?? []) as { id: string; name: string }[]),
  }
}

/** Studio finances (owners): KPIs, receivables, payables, agency dues, margin by project, cash-flow forecast. */
export default function Finances() {
  const { me } = useTeam()
  const owner = isOwner(me)
  const portfolio = usePortfolio()
  const load = useLoad<FinData>('finances', loadFinances, owner)

  return (
    <main className="screen fees">
      <header className="topbar">
        <div>
          <button type="button" className="link back" onClick={() => go('/studio')}>
            Studio
          </button>
          <h1>Finances</h1>
        </div>
      </header>
      {!me ? <p className="muted">Loading</p> : !owner ? <OwnerOnly what="Studio finances are" /> : <Body portfolio={portfolio} load={load} />}
    </main>
  )
}

function Body({ portfolio, load }: { portfolio: ReturnType<typeof usePortfolio>; load: ReturnType<typeof useLoad<FinData>> }) {
  const data = load.data
  const [opening, setOpening] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!data) {
    if (load.state === 'offline') return <p className="notice">No signal. Finances have not been opened on this phone yet.</p>
    return <p className="muted">Loading</p>
  }
  const readOnly = load.state !== 'ready'
  const today = todayLocal()
  const projects = portfolio.projects
  const active = new Set(projects.map((p) => p.id))
  const name = (pid: string) => projects.find((p) => p.id === pid)?.name ?? 'Removed project'
  const feeOf = (pid: string) => data.fees.find((f) => f.project_id === pid)
  const endOf = (pid: string) => (taskId: string) => portfolio.states.find((s) => s.project.id === pid)?.result?.tasks[taskId]?.end ?? null

  const invoices = data.invoices.filter((i) => active.has(i.project_id))
  const costs = data.costs.filter((c) => active.has(c.project_id))
  const withDue = invoices.map((inv) => {
    const due = invoiceDue(inv, endOf(inv.project_id), num(feeOf(inv.project_id)?.payment_terms_days ?? DEFAULT_TERMS_DAYS)).due
    return { inv, due, late: overdueDays(inv, due, today), total: invoiceTotals(inv).total }
  })
  const raised = withDue.filter((x) => x.inv.status === 'raised')
  const feesAgreed = sum(data.fees.filter((f) => active.has(f.project_id)).map((f) => num(f.fee_amount)))
  const invoiced = sum(withDue.filter((x) => x.inv.status !== 'scheduled').map((x) => x.total))
  const received = sum(invoices.filter((i) => i.status === 'paid').map((i) => num(i.paid_amount)))
  const outstanding = sum(raised.map((x) => x.total))
  const overdue = sum(raised.filter((x) => x.late > 0).map((x) => x.total))
  const all = margin(feesAgreed, costs)
  const studioCosts = all.paidCosts + all.plannedCosts

  const receivables = [...raised].sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999'))
  const payables = costs.filter((c) => c.status === 'planned').sort((a, b) => a.spent_on.localeCompare(b.spent_on))
  const dues = data.bills
    .filter((b) => active.has(b.project_id) && (b.status === 'client_approved' || b.status === 'certified'))
    .sort((a, b) => (a.client_approved_on ?? a.certified_on ?? '').localeCompare(b.client_approved_on ?? b.certified_on ?? ''))
  const vendorName = (id: string) => data.vendors.find((v) => v.id === id)?.name ?? 'Agency'

  const byProject = projects
    .map((p) => ({ p, m: margin(num(feeOf(p.id)?.fee_amount), costs.filter((c) => c.project_id === p.id)) }))
    .filter((x) => x.m.fee > 0 || x.m.paidCosts + x.m.plannedCosts > 0)

  const openingCash = opening ?? data.openingCash
  const weeks = cashFlow({
    today,
    openingCash,
    invoices: withDue.map((x) => ({ inv: x.inv, due: x.due, label: `${name(x.inv.project_id)} · ${x.inv.milestone}` })),
    costs: costs.map((c) => ({ cost: c, label: `${name(c.project_id)} · ${c.category}` })),
  })

  async function saveOpening() {
    setBusy(true)
    setError(null)
    const { error: e } = await supabase.from('studio_private').upsert({ id: 1, opening_cash: num(opening) }, { onConflict: 'id' })
    setBusy(false)
    const msg = errorText(e)
    if (msg) return setError(msg)
    await load.reload()
    setOpening(null)
  }

  return (
    <>
      {readOnly && <p className="notice">No signal. Showing finances as last seen on this phone (read-only).</p>}
      {load.error && <p className="error">{load.error}</p>}
      <p className="muted small">Fees agreed are before GST; invoice amounts include GST (what the client pays).</p>
      <div className="tiles fees-tiles" aria-label="Studio money">
        <Tile value={inrShort(feesAgreed)} label="Fees agreed" />
        <Tile value={inrShort(invoiced)} label="Invoiced" />
        <Tile value={inrShort(received)} label="Received" />
        <Tile value={inrShort(outstanding)} label="Outstanding" />
        <Tile value={inrShort(overdue)} label="Overdue" tone={overdue > 0 ? 'danger' : undefined} />
        <Tile value={inrShort(studioCosts)} label="Studio costs (incl. planned)" />
        <Tile value={all.forecastPct === null ? '—' : `${all.forecastPct}%`} label="Margin (forecast)" tone={all.forecastPct !== null && all.forecastPct < LOW_MARGIN_PCT ? 'danger' : undefined} />
      </div>

      <section className="stack-tight" aria-label="Receivables">
        <h2>Receivables: raised, not paid</h2>
        {receivables.length === 0 && <p className="muted small">Nothing outstanding.</p>}
        <ul className="rows">
          {receivables.map(({ inv, due, late, total }) => (
            <li key={inv.id}>
              <button type="button" className="row" onClick={() => go(`/project/${inv.project_id}/fees`)}>
                <span className="row-line">
                  <span className="row-title small-title">
                    {name(inv.project_id)} · {inv.milestone}
                  </span>
                  <b className="nowrap">{inr(total)}</b>
                </span>
                <span className="row-line">
                  <span className="muted small">
                    {inv.invoice_no ?? 'No number'} · {due ? `due ${longDate(due)}` : 'no due date'}
                  </span>
                  {late > 0 && <span className="htag late">Overdue {late} d</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="stack-tight" aria-label="Payables">
        <h2>Payables: planned studio costs</h2>
        {payables.length === 0 && <p className="muted small">No planned costs.</p>}
        <ul className="rows">
          {payables.map((c) => (
            <li key={c.id} className="row-line padded">
              <span className="small">
                {longDate(c.spent_on)} · {name(c.project_id)} · {c.category}
                {c.spent_on < today ? <span className="late"> · date passed</span> : null}
              </span>
              <b className="nowrap small">{inr(num(c.amount))}</b>
            </li>
          ))}
        </ul>
      </section>

      <section className="stack-tight" aria-label="Agency dues">
        <h2>Agency bills awaiting the client’s payment</h2>
        <p className="muted small">Paid by the client directly to the agency. For follow-up only; not studio money.</p>
        {dues.length === 0 && <p className="muted small">None.</p>}
        <ul className="rows">
          {dues.map((b) => (
            <li key={b.id} className="row-line padded">
              <span className="small">
                {vendorName(b.vendor_id)} · {name(b.project_id)} · bill {b.bill_no} · {RA_STEP_LABEL[b.status]}
              </span>
              <b className="nowrap small">{inr(billTotal(b))}</b>
            </li>
          ))}
        </ul>
      </section>

      <section className="stack-tight" aria-label="Margin by project">
        <h2>Margin by project (forecast)</h2>
        {byProject.length === 0 && <p className="muted small">No fees or studio costs yet.</p>}
        <ul className="stack-tight">
          {byProject.map(({ p, m }) => {
            const low = m.forecastPct !== null && m.forecastPct < LOW_MARGIN_PCT
            return (
              <li key={p.id} className="fees-mbar">
                <span className="row-line">
                  <span className="small">{p.name}</span>
                  <b className={low ? 'small late' : 'small'}>{m.forecastPct === null ? '—' : `${m.forecastPct}%`}</b>
                </span>
                <span className={low ? 'pbar fees-low' : 'pbar'} role="img" aria-label={`${p.name} margin ${m.forecastPct ?? 0}%`}>
                  <i style={{ width: `${Math.max(0, Math.min(100, m.forecastPct ?? 0))}%` }} />
                </span>
                <span className="muted small">
                  {inr(m.forecast)} of {inr(m.fee)} · to date {m.toDatePct === null ? '—' : `${m.toDatePct}%`}
                </span>
              </li>
            )
          })}
        </ul>
      </section>

      <section className="stack-tight" aria-label="Cash-flow forecast">
        <h2>Cash-flow forecast: next 8 weeks</h2>
        <p className="muted small">
          A forecast, not a record. In: raised, unpaid invoices by due date (overdue ones in this week) and scheduled invoices with a due date. Out: planned studio costs.
        </p>
        <div className="fees-opening">
          <NumField label="Opening cash (₹)" value={opening ?? data.openingCash} disabled={readOnly} onChange={setOpening} />
          {!readOnly && opening !== null && (
            <button type="button" className="secondary" disabled={busy} onClick={saveOpening}>
              Save
            </button>
          )}
        </div>
        {error && <p className="error">{error}</p>}
        <CashChart weeks={weeks} opening={openingCash} />
        <div className="fees-scroll">
          <table className="fees-table" aria-label="Cash-flow weeks">
            <thead>
              <tr>
                <th>Week of</th>
                <th>In</th>
                <th>Out</th>
                <th>Balance</th>
              </tr>
            </thead>
            <tbody>
              {weeks.map((w) => (
                <tr key={w.start} className={w.negative ? 'neg' : ''}>
                  <td>{formatDay(w.start)}</td>
                  <td>{w.cashIn ? inr(w.cashIn) : '—'}</td>
                  <td>{w.cashOut ? inr(w.cashOut) : '—'}</td>
                  <td>
                    {inr(w.balance)}
                    {w.negative ? ' ▼' : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {weeks.some((w) => w.negative) && (
          <p className="error" role="status">
            Cash forecast goes below zero in the week of {formatDay(weeks.find((w) => w.negative)!.start)}.
          </p>
        )}
      </section>
    </>
  )
}

/** In (green) and out (grey) bars per week, the running balance as a line; below-zero points in red. */
function CashChart({ weeks, opening }: { weeks: CashWeek[]; opening: number }) {
  const W = 340
  const H = 170
  const top = 12
  const bottom = 22
  const left = 8
  const values = [0, opening, ...weeks.flatMap((w) => [w.cashIn, -w.cashOut, w.balance])]
  const max = Math.max(...values)
  const min = Math.min(...values)
  const span = max - min || 1
  const y = (v: number) => top + ((max - v) / span) * (H - top - bottom)
  const col = (W - left * 2) / weeks.length
  const bw = Math.min(14, col / 3)
  const cx = (i: number) => left + col * i + col / 2
  const line = weeks.map((w, i) => `${i ? 'L' : 'M'}${cx(i).toFixed(1)},${y(w.balance).toFixed(1)}`).join(' ')
  return (
    <svg className="fees-chart" viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Cash-flow forecast chart">
      <line x1={left} x2={W - left} y1={y(0)} y2={y(0)} stroke="#8e8a82" strokeWidth="1" />
      {weeks.map((w, i) => (
        <g key={w.start}>
          {w.cashIn > 0 && <rect x={cx(i) - bw - 1} y={y(w.cashIn)} width={bw} height={Math.max(1, y(0) - y(w.cashIn))} fill="#2F5D46" opacity="0.85" />}
          {w.cashOut > 0 && <rect x={cx(i) + 1} y={y(0)} width={bw} height={Math.max(1, y(-w.cashOut) - y(0))} fill="#8e8a82" opacity="0.8" />}
          <text x={cx(i)} y={H - 6} textAnchor="middle" fontSize="9" fill="#5f5c56">
            {formatDay(w.start)}
          </text>
        </g>
      ))}
      <path d={line} fill="none" stroke="#2b2b29" strokeWidth="1.5" />
      {weeks.map((w, i) => (
        <circle key={w.start} cx={cx(i)} cy={y(w.balance)} r="3" fill={w.negative ? '#8A2B1D' : '#2b2b29'} data-negative={w.negative ? '1' : undefined} />
      ))}
    </svg>
  )
}
