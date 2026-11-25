/**
 * The money ledger for each BOQ line and category: budget, committed, certified, paid.
 *   budget    = the line amount from the estimate (qty × rate × (1 + wastage %)).
 *   committed = qty × committed rate, once the line is on a work order.
 *   certified = Σ certified qty × bill-line rate over bills that are certified, client approved or paid (not removed).
 *   paid      = the same over paid bills only.
 * A line is over budget when certified > budget × (1 + 5 %) and no live variation is linked to it.
 */
import { OVERRUN_PCT, type BoqItem, type RaBill, type RaBillLine, type RaStatus, type Variation } from '../domain'
import { lineAmount } from '../estimate'
import { num, round2 } from '../format'

export const CERTIFIED_STATES: readonly RaStatus[] = ['certified', 'client_approved', 'paid']

export type LedgerRow = { budget: number; committed: number; certified: number; paid: number }

export type LineLedger = LedgerRow & {
  /** Certified above budget × 1.05 with no variation linked to the line. */
  overrun: boolean
  /** How far certified is above budget, in % (null when the line has no budget). */
  overPct: number | null
  hasVariation: boolean
}

export type Ledger = {
  lines: Record<string, LineLedger>
  /** Budget counts non-optional lines only (as the estimate total does); the rest count every live line. */
  categories: Record<string, LedgerRow>
  total: LedgerRow
}

/** The rate a bill line is valued at: its own rate, else the BOQ committed rate, else the estimate rate (as the database fills it). */
export function billLineRate(line: Pick<RaBillLine, 'rate'>, item: Pick<BoqItem, 'rate' | 'committed_rate'> | undefined): number {
  if (line.rate != null) return num(line.rate)
  if (!item) return 0
  return item.committed_rate != null ? num(item.committed_rate) : num(item.rate)
}

export function committedAmount(item: Pick<BoqItem, 'quantity' | 'committed_rate' | 'work_order_id'>): number {
  return item.work_order_id ? round2(num(item.quantity) * num(item.committed_rate)) : 0
}

const empty = (): LedgerRow => ({ budget: 0, committed: 0, certified: 0, paid: 0 })

export function buildLedger(items: BoqItem[], bills: RaBill[], billLines: RaBillLine[], variations: Variation[]): Ledger {
  const live = items.filter((i) => !i.removed_at)
  const byId = new Map(live.map((i) => [i.id, i]))
  const billById = new Map(bills.filter((b) => !b.removed_at).map((b) => [b.id, b]))
  const certified = new Map<string, number>()
  const paid = new Map<string, number>()
  for (const l of billLines) {
    const bill = billById.get(l.bill_id)
    const item = byId.get(l.boq_item_id)
    if (!bill || !item || !CERTIFIED_STATES.includes(bill.status)) continue
    const amount = num(l.certified_qty) * billLineRate(l, item)
    certified.set(item.id, (certified.get(item.id) ?? 0) + amount)
    if (bill.status === 'paid') paid.set(item.id, (paid.get(item.id) ?? 0) + amount)
  }
  const withVariation = new Set(variations.filter((v) => !v.removed_at && v.boq_item_id).map((v) => v.boq_item_id as string))

  const lines: Record<string, LineLedger> = {}
  const categories: Record<string, LedgerRow> = {}
  const total = empty()
  for (const i of live) {
    const budget = round2(lineAmount(i))
    const c = round2(certified.get(i.id) ?? 0)
    const row: LedgerRow = { budget, committed: committedAmount(i), certified: c, paid: round2(paid.get(i.id) ?? 0) }
    const hasVariation = withVariation.has(i.id)
    const over = c > budget * (1 + OVERRUN_PCT / 100) + 0.005
    lines[i.id] = {
      ...row,
      hasVariation,
      overrun: over && !hasVariation,
      overPct: budget > 0 ? round2(((c - budget) / budget) * 100) : null,
    }
    const cat = (categories[i.category] ??= empty())
    for (const t of [cat, total]) {
      if (!i.optional) t.budget += row.budget
      t.committed += row.committed
      t.certified += row.certified
      t.paid += row.paid
    }
  }
  for (const r of [...Object.values(categories), total]) {
    r.budget = round2(r.budget)
    r.committed = round2(r.committed)
    r.certified = round2(r.certified)
    r.paid = round2(r.paid)
  }
  return { lines, categories, total }
}

/** "Over budget by 9.5% — needs a variation" (or the no-budget wording). */
export function overrunText(l: LineLedger): string {
  if (l.overPct === null) return 'Certified with no budget on this line — needs a variation'
  return `Over budget by ${Math.round(l.overPct * 10) / 10}% — needs a variation`
}
