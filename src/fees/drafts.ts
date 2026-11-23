/**
 * Fee drafts for the Drafts outbox: payment reminders for overdue fee invoices (3 and 10 days after the
 * due date) and prompts to raise an invoice when its schedule milestone is done. Nothing is sent: the
 * owner edits, then shares or copies the message.
 */
import { FEE_REMINDER_DAYS, type FeeInvoice, type ProjectBrief, type ProjectFee } from '../domain'
import { inrExact, longDate, num } from '../format'
import type { Draft } from '../portfolio'
import { calendarDaysBetween } from '../schedule'
import { invoiceTotals, milestoneReached, storedOrTermsDue } from './invoices'

export type FeeDraftInput = {
  projects: { id: string; name: string }[]
  invoices: FeeInvoice[]
  fees: ProjectFee[]
  briefs: ProjectBrief[]
  doneTaskIds: Set<string>
  today: string
}

export function feeDrafts(input: FeeDraftInput): Draft[] {
  const out: Draft[] = []
  const stages = [...FEE_REMINDER_DAYS].sort((a, b) => b - a) // latest stage first
  for (const inv of input.invoices) {
    if (inv.removed_at) continue
    const project = input.projects.find((p) => p.id === inv.project_id)
    if (!project) continue
    const fee = input.fees.find((f) => f.project_id === inv.project_id)
    const brief = input.briefs.find((b) => b.project_id === inv.project_id)
    const { total } = invoiceTotals(inv)

    if (inv.status === 'raised') {
      const due = storedOrTermsDue(inv, fee)
      if (!due) continue
      const late = calendarDaysBetween(due, input.today)
      const stage = stages.find((d) => late >= d)
      if (stage === undefined) continue
      const client = brief?.client_name?.trim()
      const ref = inv.invoice_no ? `invoice ${inv.invoice_no}` : 'our invoice'
      const dated = inv.raised_on ? ` dated ${longDate(inv.raised_on)}` : ''
      const firm = stage >= 10
      out.push({
        key: `fee:${inv.id}:${stage}`,
        kind: 'client',
        projectId: project.id,
        projectName: project.name,
        to: client || 'Client',
        subject: `${firm ? 'Second reminder' : 'Reminder'}: design fee for ${project.name}`,
        why: `${inv.invoice_no ?? inv.milestone} (${inrExact(total)} incl. GST) was due ${longDate(due)}: ${late} days ago.`,
        body:
          `Dear ${client || 'Sir/Madam'},\n\n` +
          (firm
            ? `This is a second reminder about ${ref}${dated} for “${inv.milestone}” on ${project.name}. ` +
              `The amount of ${inrExact(total)} (including GST at ${num(inv.gst_rate)}%) was due on ${longDate(due)} and is now ${late} days overdue. ` +
              `Could you please arrange the payment at the earliest, or let us know if anything is holding it up?\n\n`
            : `A gentle reminder that ${ref}${dated} for “${inv.milestone}” on ${project.name}, ` +
              `${inrExact(total)} including GST at ${num(inv.gst_rate)}%, was due on ${longDate(due)}. ` +
              `If the payment has already been made, please ignore this note and share the reference so we can match it.\n\n`) +
          `Thank you,\nStudio Elements`,
      })
    } else if (milestoneReached(inv, input.doneTaskIds)) {
      out.push({
        key: `feeraise:${inv.id}`,
        kind: 'team',
        projectId: project.id,
        projectName: project.name,
        to: 'Owners',
        subject: `Raise the fee invoice: ${inv.milestone}`,
        why: `The schedule milestone for “${inv.milestone}” is done; the invoice is still only scheduled.`,
        body:
          `${project.name}: the milestone for “${inv.milestone}” is done. ` +
          `Please raise the fee invoice of ${inrExact(total)} (${inrExact(num(inv.amount))} plus GST at ${num(inv.gst_rate)}%) ` +
          `from Project → Fees, and share it with the client.`,
      })
    }
  }
  return out
}
