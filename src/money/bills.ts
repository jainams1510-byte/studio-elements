/** RA bill rules on the phone side. The database applies the same rules (supabase/006, ra_bill_rules). */
import { RA_STEPS, RA_UNPAID_DAYS, type BoqItem, type RaBill, type RaBillLine, type RaStatus } from '../domain'
import { num, round2 } from '../format'
import { billLineRate } from './ledger'

export const stepIndex = (s: RaStatus) => RA_STEPS.indexOf(s)
export const isCertified = (s: RaStatus) => stepIndex(s) >= 2

/** Σ certified qty × rate over a bill's lines: the default certified amount before certifying. */
export function suggestedCertified(lines: RaBillLine[], items: Map<string, BoqItem>): number {
  return round2(lines.reduce((s, l) => s + num(l.certified_qty) * billLineRate(l, items.get(l.boq_item_id)), 0))
}

export function claimedFromLines(lines: RaBillLine[], items: Map<string, BoqItem>): number {
  return round2(lines.reduce((s, l) => s + num(l.claimed_qty) * billLineRate(l, items.get(l.boq_item_id)), 0))
}

/** GST and total payable on the certified amount (on the claim until it is certified). */
export function payable(bill: Pick<RaBill, 'certified_amount' | 'claimed_amount' | 'gst_rate'>, certifiedOverride?: number | null) {
  const base = round2(num(certifiedOverride ?? bill.certified_amount ?? bill.claimed_amount))
  const gst = round2((base * num(bill.gst_rate)) / 100)
  return { base, gst, total: round2(base + gst) }
}

/**
 * The update that moves a bill to a step, with the dates the database would stamp
 * (kept when already set, cleared for later steps). The paid amount defaults to certified × (1 + GST).
 */
export function stepPatch(
  bill: RaBill,
  to: RaStatus,
  today: string,
  opts: { certifiedAmount?: number | null; paidAmount?: number | null } = {},
): Partial<RaBill> {
  const n = stepIndex(to)
  const certified = opts.certifiedAmount !== undefined ? opts.certifiedAmount : bill.certified_amount
  const patch: Partial<RaBill> = { status: to }
  if (opts.certifiedAmount !== undefined) patch.certified_amount = opts.certifiedAmount
  patch.certified_on = n >= 2 ? (bill.certified_on ?? today) : null
  patch.client_approved_on = n >= 3 ? (bill.client_approved_on ?? today) : null
  if (n >= 4) {
    patch.paid_on = bill.paid_on ?? today
    patch.paid_amount = opts.paidAmount ?? bill.paid_amount ?? round2(num(certified) * (1 + num(bill.gst_rate) / 100))
  } else {
    patch.paid_on = null
    patch.paid_amount = null
  }
  return patch
}

/** Whole days from one YYYY-MM-DD date to another. */
export function daysBetween(from: string, to: string): number {
  const a = Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10))
  const b = Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10))
  return Math.round((b - a) / 86_400_000)
}

/** Days since client approval for a bill still unpaid after more than 7 days; otherwise null. */
export function unpaidDays(bill: Pick<RaBill, 'status' | 'client_approved_on' | 'removed_at'>, today: string): number | null {
  if (bill.removed_at || bill.status !== 'client_approved' || !bill.client_approved_on) return null
  const d = daysBetween(bill.client_approved_on, today)
  return d > RA_UNPAID_DAYS ? d : null
}
