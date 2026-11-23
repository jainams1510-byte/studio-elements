/**
 * Fee invoices: creating them from the payment milestones, their due dates, overdue days and the
 * "milestone reached, raise the invoice" prompt. Pure functions; the screens load and save.
 *
 * Due date rule (one rule everywhere):
 * - a scheduled invoice linked to a schedule milestone is due on that milestone's forecast end plus the
 *   payment terms (calendar days), recomputed as the schedule moves;
 * - otherwise the stored due date (typed by hand, or fixed when the invoice was raised) is used.
 * When an invoice is raised the app stores its due date, so a raised invoice no longer moves with the schedule.
 */
import type { FeeInvoice, ProjectFee } from '../domain'
import { num, round2 } from '../format'
import { withGst } from '../feeMath'
import { calendarDaysBetween, shiftDays } from '../schedule'

export const DEFAULT_TERMS_DAYS = 7
export const DEFAULT_GST = 18

export type NewInvoice = {
  project_id: string
  milestone: string
  amount: number
  gst_rate: number
  status: 'scheduled'
  sort_order: number
}

/** One scheduled invoice per payment milestone: amount = agreed fee (before GST) × milestone %. */
export function invoicesFromMilestones(
  projectId: string,
  feeAmount: number,
  gstRate: number,
  milestones: { name: string; pct: number }[],
  firstSort = 0,
): NewInvoice[] {
  return milestones
    .filter((m) => m.name.trim() && num(m.pct) > 0)
    .map((m, i) => ({
      project_id: projectId,
      milestone: m.name.trim(),
      amount: round2((num(feeAmount) * num(m.pct)) / 100),
      gst_rate: num(gstRate),
      status: 'scheduled' as const,
      sort_order: firstSort + i,
    }))
}

/** Amount, GST and total of an invoice. */
export function invoiceTotals(inv: Pick<FeeInvoice, 'amount' | 'gst_rate'>): { amount: number; gst: number; total: number } {
  const amount = round2(num(inv.amount))
  const { gst, total } = withGst(amount, num(inv.gst_rate))
  return { amount, gst, total }
}

export type DueInfo = { due: string | null; source: 'milestone' | 'stored' | 'none'; milestoneEnd: string | null }

/** The date an invoice is due, and where that date comes from (see the rule at the top). */
export function invoiceDue(
  inv: Pick<FeeInvoice, 'status' | 'task_id' | 'due_date'>,
  milestoneEnd: (taskId: string) => string | null | undefined,
  termsDays: number,
): DueInfo {
  if (inv.status === 'scheduled' && inv.task_id) {
    const end = milestoneEnd(inv.task_id) ?? null
    if (end) return { due: shiftDays(end, num(termsDays)), source: 'milestone', milestoneEnd: end }
  }
  if (inv.due_date) return { due: inv.due_date, source: 'stored', milestoneEnd: null }
  return { due: null, source: 'none', milestoneEnd: null }
}

/** Days past due for a raised, unpaid invoice; 0 when not overdue. */
export function overdueDays(inv: Pick<FeeInvoice, 'status' | 'removed_at'>, due: string | null, today: string): number {
  if (inv.status !== 'raised' || inv.removed_at || !due) return 0
  return Math.max(0, calendarDaysBetween(due, today))
}

/** The linked milestone task is done but the invoice is still only scheduled. */
export function milestoneReached(inv: Pick<FeeInvoice, 'status' | 'task_id' | 'removed_at'>, doneTaskIds: Set<string>): boolean {
  return inv.status === 'scheduled' && !inv.removed_at && Boolean(inv.task_id && doneTaskIds.has(inv.task_id))
}

/** Due date to suggest when raising: the computed one if linked, else the stored one, else raised date + terms. */
export function dueOnRaise(computedDue: string | null, raisedOn: string, termsDays: number): string {
  return computedDue ?? shiftDays(raisedOn, num(termsDays))
}

/** Raised invoices with no stored due date fall back to raised date + terms (used by reminders). */
export function storedOrTermsDue(inv: Pick<FeeInvoice, 'due_date' | 'raised_on'>, fee: Pick<ProjectFee, 'payment_terms_days'> | undefined): string | null {
  if (inv.due_date) return inv.due_date
  if (inv.raised_on) return shiftDays(inv.raised_on, num(fee?.payment_terms_days ?? DEFAULT_TERMS_DAYS))
  return null
}

export const STATUS_LABEL: Record<FeeInvoice['status'], string> = { scheduled: 'Scheduled', raised: 'Raised', paid: 'Paid' }

/** Suggest the next invoice number from the ones used so far: SE/26-27/003 style is kept if present. */
export function nextInvoiceNo(used: (string | null)[], fallbackPrefix: string): string {
  const nos = used.filter((x): x is string => Boolean(x && x.trim()))
  let best: { head: string; n: number; width: number } | null = null
  for (const no of nos) {
    const m = no.match(/^(.*?)(\d+)$/)
    if (!m) continue
    const n = parseInt(m[2], 10)
    if (!best || n > best.n) best = { head: m[1], n, width: m[2].length }
  }
  if (best) return best.head + String(best.n + 1).padStart(best.width, '0')
  return `${fallbackPrefix}-001`
}
