/** Drafted payment reminders for RA bills the client approved more than 7 days ago and has not paid. Never sent from the app. */
import type { RaBill, Vendor } from '../domain'
import { inrExact, longDate } from '../format'
import type { Draft } from '../portfolio'
import { payable, unpaidDays } from './bills'

export type RaDraftInput = { projects: { id: string; name: string }[]; bills: RaBill[]; vendors: Vendor[]; today: string }

export function raBillDrafts(input: RaDraftInput): Draft[] {
  const projects = new Map(input.projects.map((p) => [p.id, p.name]))
  const vendors = new Map(input.vendors.map((v) => [v.id, v.name]))
  const out: Draft[] = []
  for (const b of input.bills) {
    const days = unpaidDays(b, input.today)
    const projectName = projects.get(b.project_id)
    if (days === null || projectName === undefined) continue
    const agency = vendors.get(b.vendor_id) ?? 'Agency'
    const { base, gst, total } = payable(b)
    out.push({
      key: `ra-unpaid:${b.id}:${b.status}:${base}:${b.gst_rate}:${b.client_approved_on}`,
      kind: 'client',
      projectId: b.project_id,
      projectName,
      to: 'Client',
      subject: `Payment due: ${agency} RA bill ${b.bill_no}`,
      why: `Client approved ${days} days ago (${longDate(b.client_approved_on)}) and not marked paid.`,
      body:
        `Hello,\n\nA gentle reminder about ${agency}'s RA bill ${b.bill_no} for ${projectName}, dated ${longDate(b.bill_date)}. ` +
        `We certified it at ${inrExact(base)} plus GST at ${b.gst_rate}% (${inrExact(gst)}), a total of ${inrExact(total)}, ` +
        `and it was approved on ${longDate(b.client_approved_on)}. We have not yet seen the payment recorded.\n\n` +
        `Could you let us know when it will be released? If it has already been paid, please share the payment date so we can update our records.\n\n` +
        `Regards,\nStudio Elements`,
    })
  }
  return out
}
