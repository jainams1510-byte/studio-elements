/** Vendor directory maths: totals per vendor and the delivery record. Pure functions. */
import type { ProcurementItem, Quote, RaBill, Vendor, WorkOrder } from '../domain'
import { num, round2 } from '../format'

export type VendorStats = {
  projectIds: string[]
  workOrders: number
  workOrderTotal: number
  certified: number
  paid: number
  /** Client-approved (or certified) bills not yet paid by the client: count and amount incl. GST. */
  unpaidBills: number
  unpaidAmount: number
  quotes: number
  /** Delivered on or before the expected date, among delivered items that had an expected date. */
  onTimePct: number | null
  delivered: number
}

const CERTIFIED_OR_LATER = new Set(['certified', 'client_approved', 'paid'])

export function vendorStats(
  vendorId: string,
  data: { workOrders: WorkOrder[]; bills: RaBill[]; quotes: Quote[]; procurement: ProcurementItem[] },
): VendorStats {
  const wo = data.workOrders.filter((w) => w.vendor_id === vendorId && !w.removed_at)
  const bills = data.bills.filter((b) => b.vendor_id === vendorId && !b.removed_at)
  const quotes = data.quotes.filter((q) => q.vendor_id === vendorId && !q.removed_at)
  const items = data.procurement.filter((p) => p.vendor_id === vendorId && !p.removed_at)
  const unpaid = bills.filter((b) => b.status === 'client_approved' || b.status === 'certified')
  const timed = items.filter((p) => p.delivered_on && p.expected_on)
  const onTime = timed.filter((p) => p.delivered_on! <= p.expected_on!)
  const projectIds = [...new Set([...wo, ...bills, ...quotes, ...items].map((r) => r.project_id))]
  return {
    projectIds,
    workOrders: wo.length,
    workOrderTotal: round2(wo.reduce((a, w) => a + num(w.amount), 0)),
    certified: round2(bills.filter((b) => CERTIFIED_OR_LATER.has(b.status)).reduce((a, b) => a + num(b.certified_amount), 0)),
    paid: round2(bills.filter((b) => b.status === 'paid').reduce((a, b) => a + num(b.paid_amount), 0)),
    unpaidBills: unpaid.length,
    unpaidAmount: round2(unpaid.reduce((a, b) => a + billTotal(b), 0)),
    quotes: quotes.length,
    onTimePct: timed.length ? Math.round((onTime.length / timed.length) * 100) : null,
    delivered: timed.length,
  }
}

/** Certified amount plus GST: what the client owes the agency for a bill. */
export function billTotal(b: Pick<RaBill, 'certified_amount' | 'gst_rate'>): number {
  return round2(num(b.certified_amount) * (1 + num(b.gst_rate) / 100))
}

/** Same name, ignoring case and spaces at the ends (the database's unique rule). */
export function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

export function duplicateVendor(name: string, vendors: Pick<Vendor, 'id' | 'name'>[], exceptId?: string): boolean {
  return vendors.some((v) => v.id !== exceptId && sameName(v.name, name))
}

/**
 * Digits for a WhatsApp chat link (https://wa.me/<digits>). A 10-digit Indian mobile number gets 91 in front;
 * a leading 0 is dropped first. Null when there are too few digits to be a phone number.
 */
export function whatsappDigits(phone: string | null | undefined): string | null {
  let d = (phone ?? '').replace(/\D/g, '')
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1)
  if (d.length === 10) d = '91' + d
  return d.length >= 11 ? d : null
}

export function telHref(phone: string): string {
  return 'tel:' + phone.replace(/[^\d+]/g, '')
}
