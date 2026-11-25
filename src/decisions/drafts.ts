/**
 * Drafted messages for decisions and procurement. Suggestions only: nothing is sent from the app.
 * Jainam edits a draft, then shares or copies it himself. Keys change when the situation changes,
 * so a dismissed draft comes back if things move (new need-by date, new answer, order now overdue...).
 *
 * Input shapes:
 *   decisionDrafts({ today, projects: [{ id, name }], decisions: Decision[], links?: { [decisionId]: ['Sheet SE-EL-01 …', …] } })
 *     - open approvals whose need-by date has passed  → client reminder   (kind 'client')
 *     - confirmed decisions                           → group confirmation (kind 'site')
 *   procurementDrafts({ today, projects: [{ id, name }], items: ProcurementItem[], vendors: [{ id, name }],
 *                       tasks: [{ id, name }], taskStarts: { [taskId]: 'YYYY-MM-DD' } })
 *     - not ordered, order-by date within 7 days (or already passed) → internal reminder (kind 'team')
 */
import { DECISION_KIND_LABEL, ORDER_WARNING_DAYS, type Decision, type ProcurementItem } from '../domain'
import { inr, num } from '../format'
import type { Draft } from '../portfolio'
import { calendarDaysBetween, formatDay } from '../schedule'
import { procurementState } from './logic'

type Named = { id: string; name: string }

export type DecisionDraftInput = {
  today: string
  projects: Named[]
  decisions: Decision[]
  /** Optional linked-record names per decision id, e.g. ['Sheet SE-EL-01 Electrical layout', 'Task Kitchen install']. */
  links?: Record<string, string[]>
}

export type ProcurementDraftInput = {
  today: string
  projects: Named[]
  items: ProcurementItem[]
  vendors: Named[]
  tasks: Named[]
  /** Forecast start of each task (from the schedule), by task id. */
  taskStarts: Record<string, string>
}

/** Short, stable fingerprint of some text (djb2), so a key changes when the text does. */
export function fingerprint(text: string): string {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0
  return h.toString(36)
}

function shorten(text: string, max = 60): string {
  const t = text.trim().replace(/\s+/g, ' ')
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t
}

export function kindText(d: Pick<Decision, 'kind' | 'approval_kind' | 'revision_round' | 'raised_by'>): string {
  if (d.kind === 'approval' && d.approval_kind) return `${d.approval_kind === 'client' ? 'Client' : 'Material'} approval`
  if (d.kind === 'revision') {
    const by = d.raised_by ? ` (${d.raised_by})` : ''
    return d.revision_round ? `Design revision, round ${d.revision_round}${by}` : `Design revision${by}`
  }
  return DECISION_KIND_LABEL[d.kind]
}

/** The confirmation for the project's WhatsApp group, once a decision is confirmed. */
export function confirmationDraft(d: Decision, projectName: string, links: string[] = []): Draft {
  const lines = [
    `Confirming for ${projectName} (${kindText(d)}):`,
    '',
    `Question: ${d.question.trim()}`,
    `Decision: ${d.answer.trim() || '(answer not written yet)'}`,
  ]
  const who = [d.decided_by?.trim() ? `by ${d.decided_by.trim()}` : '', d.decided_on ? `on ${formatDay(d.decided_on)}` : ''].filter(Boolean).join(' ')
  if (who) lines.push(`Decided ${who}.`)
  if (links.length) lines.push(`Refers to: ${links.join('; ')}.`)
  if (d.cost_impact !== null && num(d.cost_impact) !== 0) lines.push(`Cost impact: ${inr(num(d.cost_impact))}, to be approved as a variation.`)
  if (d.blocks.trim()) lines.push(`This releases: ${d.blocks.trim()}.`)
  lines.push('', 'Work will go ahead on this basis. Please reply here today if anything differs from what was agreed.', '', 'Studio Elements')
  return {
    key: `confirm:${d.id}:${fingerprint([d.question, d.answer, d.decided_by ?? '', d.decided_on ?? '', d.cost_impact ?? ''].join('|'))}`,
    kind: 'site',
    projectId: d.project_id,
    projectName,
    to: 'Project WhatsApp group',
    subject: `Confirmed: ${shorten(d.question)}`,
    why: `${kindText(d)} marked confirmed${d.decided_on ? ` on ${formatDay(d.decided_on)}` : ''}. Put it on record in the group.`,
    body: lines.join('\n'),
  }
}

/** A polite reminder to the client for an approval past its need-by date. */
export function approvalReminderDraft(d: Decision, projectName: string, today: string): Draft {
  const late = d.need_by ? calendarDaysBetween(d.need_by, today) : 0
  const blocks = d.blocks.trim()
  return {
    key: `approval:${d.id}:${d.need_by}`,
    kind: 'client',
    projectId: d.project_id,
    projectName,
    to: 'Client',
    subject: `Approval needed: ${shorten(d.question)}`,
    why: `${kindText(d)} was needed by ${formatDay(d.need_by)} (${late} day${late === 1 ? '' : 's'} ago) and is still open.`,
    body:
      `Hello,\n\nA reminder on ${projectName}: we need your approval on “${d.question.trim()}”. ` +
      `It was needed by ${formatDay(d.need_by)}${blocks ? `, and ${blocks} is waiting on it` : ''}. ` +
      `Please let us know at the earliest so the work is not held up.\n\nRegards,\nStudio Elements`,
  }
}

export function decisionDrafts(input: DecisionDraftInput): Draft[] {
  const names = new Map(input.projects.map((p) => [p.id, p.name]))
  const out: Draft[] = []
  for (const d of input.decisions) {
    if (d.removed_at) continue
    const name = names.get(d.project_id)
    if (!name) continue
    if (d.kind === 'approval' && d.status === 'open' && d.need_by && d.need_by < input.today) out.push(approvalReminderDraft(d, name, input.today))
    if (d.status === 'confirmed') out.push(confirmationDraft(d, name, input.links?.[d.id] ?? []))
  }
  return out
}

export function procurementDrafts(input: ProcurementDraftInput): Draft[] {
  const names = new Map(input.projects.map((p) => [p.id, p.name]))
  const vendors = new Map(input.vendors.map((v) => [v.id, v.name]))
  const tasks = new Map(input.tasks.map((t) => [t.id, t.name]))
  const out: Draft[] = []
  for (const it of input.items) {
    const name = names.get(it.project_id)
    if (it.removed_at || !name) continue
    const taskName = it.task_id ? tasks.get(it.task_id) : undefined
    const st = procurementState(it, input.today, taskName ? { name: taskName, start: input.taskStarts[it.task_id!] } : null)
    if (st.ordered || !st.orderBy || calendarDaysBetween(input.today, st.orderBy) > ORDER_WARNING_DAYS) continue
    const overdue = st.orderBy < input.today
    const vendor = it.vendor_id ? vendors.get(it.vendor_id) : undefined
    const forTask = st.needSource === 'task' && taskName ? ` for “${taskName}”` : ''
    out.push({
      key: `order:${it.id}:${st.orderBy}:${overdue ? 'late' : 'soon'}:${it.status}:${it.vendor_id ?? ''}`,
      kind: 'team',
      projectId: it.project_id,
      projectName: name,
      to: 'Studio team',
      subject: `${overdue ? 'Order overdue' : `Order by ${formatDay(st.orderBy)}`}: ${it.item}`,
      why: `Needed on site ${formatDay(st.need)}${forTask}; ${it.lead_days} days lead time, so order by ${formatDay(st.orderBy)}.`,
      body:
        `${name}: “${it.item}” ${overdue ? `should have been ordered by ${formatDay(st.orderBy)}` : `must be ordered by ${formatDay(st.orderBy)}`}` +
        `${vendor ? ` from ${vendor}` : ' (no vendor chosen yet)'} to be on site by ${formatDay(st.need)}${forTask}. ` +
        `Lead time is ${it.lead_days} days.${it.spec_approved ? '' : ' The spec is not approved yet.'} Please place the order or tell me what is holding it.`,
    })
  }
  return out
}
