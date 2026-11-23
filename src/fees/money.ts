/**
 * Studio money maths: margin per project and the 8-week cash-flow forecast. Pure functions.
 *
 * Margin = agreed fee (before GST) − studio costs. "To date" counts paid costs; "forecast" counts paid + planned.
 * Cash flow is cash: invoices count with GST (that is what the client pays), studio costs as entered.
 */
import type { FeeInvoice, StudioCost } from '../domain'
import { num, round2 } from '../format'
import { calendarDaysBetween, isoWeekday, shiftDays } from '../schedule'
import { invoiceTotals } from './invoices'

export type Margin = {
  fee: number
  paidCosts: number
  plannedCosts: number
  toDate: number
  toDatePct: number | null
  forecast: number
  forecastPct: number | null
}

const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null)

export function margin(feeExGst: number, costs: Pick<StudioCost, 'amount' | 'status' | 'removed_at'>[]): Margin {
  const live = costs.filter((c) => !c.removed_at)
  const paidCosts = round2(live.filter((c) => c.status === 'paid').reduce((a, c) => a + num(c.amount), 0))
  const plannedCosts = round2(live.filter((c) => c.status === 'planned').reduce((a, c) => a + num(c.amount), 0))
  const fee = round2(num(feeExGst))
  const toDate = round2(fee - paidCosts)
  const forecast = round2(fee - paidCosts - plannedCosts)
  return { fee, paidCosts, plannedCosts, toDate, toDatePct: pct(toDate, fee), forecast, forecastPct: pct(forecast, fee) }
}

/** Below this margin a project is shown in the danger colour. */
export const LOW_MARGIN_PCT = 10

/** Monday of the week that holds this date. */
export function mondayOf(iso: string): string {
  return shiftDays(iso, 1 - isoWeekday(iso))
}

export type CashIn = { id: string; projectId: string; label: string; due: string; amount: number; overdue: boolean }
export type CashOut = { id: string; projectId: string; label: string; on: string; amount: number }

export type CashWeek = {
  start: string
  end: string
  cashIn: number
  cashOut: number
  net: number
  balance: number
  negative: boolean
  ins: CashIn[]
  outs: CashOut[]
}

export type CashFlowInput = {
  today: string
  openingCash: number
  /** Invoices with their due dates already worked out (see invoices.ts). */
  invoices: { inv: FeeInvoice; due: string | null; label: string }[]
  costs: { cost: StudioCost; label: string }[]
  weeks?: number
}

/**
 * Eight Monday-start weeks from the week holding today.
 * In: raised unpaid invoices by due date (already overdue → week 1) and scheduled invoices with a due date
 * (a past date → week 1); amounts include GST. Out: planned studio costs by date (a past date → week 1).
 * Anything after the last week is left out. Balance = opening cash + running net.
 */
export function cashFlow(input: CashFlowInput): CashWeek[] {
  const n = input.weeks ?? 8
  const first = mondayOf(input.today)
  const weeks: CashWeek[] = Array.from({ length: n }, (_, i) => ({
    start: shiftDays(first, i * 7),
    end: shiftDays(first, i * 7 + 6),
    cashIn: 0, cashOut: 0, net: 0, balance: 0, negative: false, ins: [], outs: [],
  }))
  const slot = (iso: string) => {
    const i = Math.floor(calendarDaysBetween(first, iso) / 7)
    if (i < 0) return 0
    return i < n ? i : -1
  }
  for (const { inv, due, label } of input.invoices) {
    if (inv.removed_at || !due) continue
    if (inv.status !== 'raised' && inv.status !== 'scheduled') continue
    const i = slot(due)
    if (i < 0) continue
    const amount = invoiceTotals(inv).total
    weeks[i].ins.push({ id: inv.id, projectId: inv.project_id, label, due, amount, overdue: inv.status === 'raised' && due < input.today })
    weeks[i].cashIn = round2(weeks[i].cashIn + amount)
  }
  for (const { cost, label } of input.costs) {
    if (cost.removed_at || cost.status !== 'planned') continue
    const i = slot(cost.spent_on)
    if (i < 0) continue
    weeks[i].outs.push({ id: cost.id, projectId: cost.project_id, label, on: cost.spent_on, amount: num(cost.amount) })
    weeks[i].cashOut = round2(weeks[i].cashOut + num(cost.amount))
  }
  let balance = num(input.openingCash)
  for (const w of weeks) {
    w.net = round2(w.cashIn - w.cashOut)
    balance = round2(balance + w.net)
    w.balance = balance
    w.negative = balance < 0
  }
  return weeks
}

export type Receivable = { inv: FeeInvoice; due: string | null; overdueDays: number; total: number }

/** Sum of a list of numbers, to paise. */
export function sum(xs: number[]): number {
  return round2(xs.reduce((a, b) => a + b, 0))
}
