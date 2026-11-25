/**
 * Decisions, procurement and calendar rules. Pure functions: no network, no storage, no clock
 * (today is always passed in as YYYY-MM-DD). Dates are handled as UTC days, like schedule.ts.
 */
import { currentRevision, isConstruction, type Drawing } from '../drawings'
import type { Decision, FeeInvoice, ProcurementItem, RaBill, SiteVisit } from '../domain'
import { DECISION_STEPS, ORDER_WARNING_DAYS, RA_UNPAID_DAYS } from '../domain'
import {
  calendarDaysBetween,
  computeSchedule,
  formatDay,
  isMilestone,
  isoWeekday,
  shiftDays,
  toTime,
  WorkCalendar,
  type Planned,
  type ScheduleSettings,
  type Task,
} from '../schedule'

// ---------------------------------------------------------------------------------------------
// Decisions

/** Open with a need-by date that has passed. */
export function decisionOverdue(d: Pick<Decision, 'status' | 'need_by'>, today: string): boolean {
  return d.status === 'open' && Boolean(d.need_by) && d.need_by! < today
}

/** Open first, then answered, confirmed, closed; within a status the earliest need-by first, then newest. */
export function sortDecisions<T extends Pick<Decision, 'status' | 'need_by' | 'created_at'>>(list: T[]): T[] {
  const rank = (s: string) => DECISION_STEPS.indexOf(s as (typeof DECISION_STEPS)[number])
  return [...list].sort(
    (a, b) =>
      rank(a.status) - rank(b.status) ||
      (a.need_by ?? '9999').localeCompare(b.need_by ?? '9999') ||
      (b.created_at ?? '').localeCompare(a.created_at ?? ''),
  )
}

/** The round to suggest for a new design revision: one more than the highest so far (1 when none). */
export function nextRevisionRound(decisions: Pick<Decision, 'id' | 'kind' | 'revision_round' | 'removed_at'>[], exceptId?: string): number {
  const rounds = decisions
    .filter((d) => d.kind === 'revision' && !d.removed_at && d.id !== exceptId && d.revision_round)
    .map((d) => d.revision_round as number)
  return Math.min(50, Math.max(0, ...rounds) + 1)
}

// ---------------------------------------------------------------------------------------------
// Procurement

export type ProcFlag = {
  kind: 'order_soon' | 'order_overdue' | 'delivery_late' | 'not_in_time'
  text: string
  level: 'risk' | 'late'
}

export type ProcState = {
  /** The date the item must be on site: the linked task's forecast start, else the item's need-by date. */
  need: string | null
  needSource: 'task' | 'date' | null
  /** need − lead days (calendar days). */
  orderBy: string | null
  ordered: boolean
  flags: ProcFlag[]
}

export const isOrdered = (status: ProcurementItem['status']) => status === 'ordered' || status === 'on_site'

/** Need date, order-by date and the derived flags for one procurement item. */
export function procurementState(
  item: Pick<ProcurementItem, 'task_id' | 'need_by' | 'lead_days' | 'status' | 'expected_on'>,
  today: string,
  task?: { name: string; start?: string | null } | null,
): ProcState {
  const fromTask = item.task_id && task?.start ? task.start : null
  const need = fromTask ?? item.need_by ?? null
  const needSource = fromTask ? 'task' : item.need_by ? 'date' : null
  const orderBy = need ? shiftDays(need, -Math.max(0, item.lead_days || 0)) : null
  const ordered = isOrdered(item.status)
  const onSite = item.status === 'on_site'
  const flags: ProcFlag[] = []
  if (orderBy && !ordered) {
    if (orderBy < today) flags.push({ kind: 'order_overdue', text: 'Order overdue', level: 'late' })
    else if (calendarDaysBetween(today, orderBy) <= ORDER_WARNING_DAYS)
      flags.push({ kind: 'order_soon', text: `Order by ${formatDay(orderBy)}`, level: 'risk' })
  }
  if (!onSite && item.expected_on && item.expected_on < today) flags.push({ kind: 'delivery_late', text: 'Delivery late', level: 'late' })
  if (!onSite && item.expected_on && need && item.expected_on > need) {
    const forWhat = needSource === 'task' && task ? task.name : `the need-by date (${formatDay(need)})`
    flags.push({ kind: 'not_in_time', text: `Not in time for ${forWhat}`, level: 'late' })
  }
  return { need, needSource, orderBy, ordered, flags }
}

/** Items in working order: not on site first, by order-by date (no date last); on-site items at the end. */
export function sortProcurement<T extends { item: Pick<ProcurementItem, 'status' | 'item'>; state: ProcState }>(rows: T[]): T[] {
  return [...rows].sort(
    (a, b) =>
      Number(a.item.status === 'on_site') - Number(b.item.status === 'on_site') ||
      (a.state.orderBy ?? '9999').localeCompare(b.state.orderBy ?? '9999') ||
      a.item.item.localeCompare(b.item.item),
  )
}

export type GateRow = { task: Task; start: string | null; started: boolean; items: ProcurementItem[] }

/** Tasks that need material not yet on site and start within a week (or have started). */
export function materialGate(items: ProcurementItem[], tasks: Task[], planned: Record<string, Pick<Planned, 'start'>>, today: string): GateRow[] {
  const waiting = new Map<string, ProcurementItem[]>()
  for (const it of items) {
    if (it.removed_at || !it.task_id || it.status === 'on_site') continue
    if (!waiting.has(it.task_id)) waiting.set(it.task_id, [])
    waiting.get(it.task_id)!.push(it)
  }
  const out: GateRow[] = []
  for (const t of tasks) {
    const list = waiting.get(t.id)
    if (!list || t.removed_at || t.status === 'done') continue
    const start = planned[t.id]?.start ?? null
    const started = t.status === 'in_progress' || (start !== null && start <= today)
    const soon = start !== null && calendarDaysBetween(today, start) <= ORDER_WARNING_DAYS
    if (started || soon) out.push({ task: t, start, started, items: list })
  }
  return out.sort((a, b) => (a.start ?? '').localeCompare(b.start ?? ''))
}

/** Forecast dates for a project's tasks, or an empty record without a usable schedule. */
export function forecast(settings: ScheduleSettings | null | undefined, tasks: Task[], today: string): Record<string, Planned> {
  if (!settings) return {}
  try {
    return computeSchedule(tasks, new WorkCalendar(settings.start_date, settings.work_days, settings.holidays), today).tasks
  } catch {
    return {}
  }
}

/** Case-insensitive, trimmed vendor-name match (the database's unique rule). */
export function sameVendorName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

// ---------------------------------------------------------------------------------------------
// Calendar

export const ENTRY_TYPES = ['milestone', 'order', 'sheet', 'visit', 'fee', 'bill', 'decision', 'report'] as const
export type EntryType = (typeof ENTRY_TYPES)[number]
export const ENTRY_LABEL: Record<EntryType, string> = {
  milestone: 'Milestones', order: 'Orders', sheet: 'Sheets', visit: 'Site visits',
  fee: 'Fees', bill: 'Bill payments', decision: 'Decisions', report: 'Reports',
}
export const ENTRY_TAG: Record<EntryType, string> = {
  milestone: 'Milestone', order: 'Order by', sheet: 'Sheet', visit: 'Site visit',
  fee: 'Fee due', bill: 'Payment', decision: 'Decision', report: 'Report',
}

export type CalendarEntry = {
  /** Unique and stable: the source record and the date. */
  key: string
  date: string
  type: EntryType
  title: string
  detail: string
  projectId: string
  projectName: string
  /** Hash route of the source record; null for site visits (edited in the calendar itself). */
  href: string | null
  visitId?: string
  time?: string | null
  /** A merged weekly-report entry: one link per project. */
  parts?: { projectId: string; projectName: string; href: string }[]
}

export type ProjectCalendarData = {
  project: { id: string; name: string }
  settings: ScheduleSettings | null
  tasks: Task[]
  drawings: Drawing[]
  procurement: ProcurementItem[]
  visits: SiteVisit[]
  invoices: FeeInvoice[]
  bills: RaBill[]
  decisions: Decision[]
}

/** Every Friday from `from` to `to`, inclusive. */
export function fridaysBetween(from: string, to: string): string[] {
  const out: string[] = []
  let d = shiftDays(from, (5 - isoWeekday(from) + 7) % 7)
  while (d <= to) {
    out.push(d)
    d = shiftDays(d, 7)
  }
  return out
}

const TYPE_ORDER = Object.fromEntries(ENTRY_TYPES.map((t, i) => [t, i])) as Record<EntryType, number>

/** Calendar entries for every project, from `from` to `to` inclusive. All derived except site visits. */
export function buildCalendarEntries(
  projects: ProjectCalendarData[],
  vendorNames: Record<string, string>,
  from: string,
  to: string,
  today: string,
): CalendarEntry[] {
  const out: CalendarEntry[] = []
  const inRange = (d: string | null | undefined): d is string => Boolean(d) && d! >= from && d! <= to
  for (const p of projects) {
    const pid = p.project.id
    const base = { projectId: pid, projectName: p.project.name }
    const tasks = p.tasks.filter((t) => !t.removed_at)
    const planned = forecast(p.settings, tasks, today)
    const taskById = new Map(tasks.map((t) => [t.id, t]))

    for (const t of tasks) {
      const pl = planned[t.id]
      if (!pl) continue
      if (isMilestone(t) && inRange(pl.end)) {
        out.push({ ...base, key: `milestone:${t.id}:${pl.end}`, date: pl.end, type: 'milestone', title: t.name,
          detail: t.status === 'done' ? 'Reached' : 'Forecast', href: `/project/${pid}/schedule` })
      }
      if (t.gate_drawing_id && t.status !== 'done' && inRange(pl.start)) {
        const d = p.drawings.find((x) => x.id === t.gate_drawing_id)
        const rev = d ? currentRevision(d) : null
        if (d && !(rev && isConstruction(rev.code))) {
          out.push({ ...base, key: `sheet:${t.id}:${d.id}:${pl.start}`, date: pl.start, type: 'sheet',
            title: `Sheet ${d.number} needed by ${formatDay(pl.start)}`,
            detail: `${t.name} starts · now at ${rev?.code ?? 'no revision'}`, href: `/drawing/${d.id}` })
        }
      }
    }

    for (const it of p.procurement) {
      if (it.removed_at || isOrdered(it.status)) continue
      const task = it.task_id ? taskById.get(it.task_id) : undefined
      const st = procurementState(it, today, task ? { name: task.name, start: planned[task.id]?.start } : null)
      if (!inRange(st.orderBy)) continue
      out.push({ ...base, key: `order:${it.id}:${st.orderBy}`, date: st.orderBy, type: 'order', title: `Order ${it.item}`,
        detail: `Needed on site ${formatDay(st.need)}${task && st.needSource === 'task' ? ` for ${task.name}` : ''} · ${it.lead_days} days lead`,
        href: `/project/${pid}/procurement` })
    }

    for (const v of p.visits) {
      if (v.removed_at || !inRange(v.visit_on)) continue
      out.push({ ...base, key: `visit:${v.id}:${v.visit_on}`, date: v.visit_on, type: 'visit',
        title: v.purpose.trim() ? `Site visit: ${v.purpose.trim()}` : 'Site visit',
        detail: v.visit_time ? v.visit_time : '', href: null, visitId: v.id, time: v.visit_time })
    }

    for (const f of p.invoices) {
      if (f.removed_at || f.status === 'paid' || !inRange(f.due_date)) continue
      out.push({ ...base, key: `fee:${f.id}:${f.due_date}`, date: f.due_date!, type: 'fee', title: `Fee invoice due: ${f.milestone}`,
        detail: f.status === 'raised' ? `Raised${f.invoice_no ? ` · ${f.invoice_no}` : ''}` : 'Scheduled', href: `/project/${pid}/fees` })
    }

    for (const b of p.bills) {
      if (b.removed_at || b.status !== 'client_approved' || !b.client_approved_on) continue
      const due = shiftDays(b.client_approved_on, RA_UNPAID_DAYS)
      if (!inRange(due)) continue
      const vendor = vendorNames[b.vendor_id] ?? 'Agency'
      out.push({ ...base, key: `bill:${b.id}:${due}`, date: due, type: 'bill', title: `Payment expected: ${vendor} bill ${b.bill_no}`,
        detail: `Client approved ${formatDay(b.client_approved_on)}`, href: `/project/${pid}/money` })
    }

    for (const d of p.decisions) {
      if (d.removed_at || d.status !== 'open' || !inRange(d.need_by)) continue
      out.push({ ...base, key: `decision:${d.id}:${d.need_by}`, date: d.need_by!, type: 'decision', title: d.question,
        detail: d.blocks.trim() ? `Blocks ${d.blocks.trim()}` : 'Answer needed', href: `/project/${pid}/decisions` })
    }

    for (const fri of fridaysBetween(from, to)) {
      out.push({ ...base, key: `report:${pid}:${fri}`, date: fri, type: 'report', title: 'Weekly report',
        detail: 'Draft from 5 pm, approve before sharing', href: `/project/${pid}/reports` })
    }
  }
  return out.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      TYPE_ORDER[a.type] - TYPE_ORDER[b.type] ||
      (a.time ?? '').localeCompare(b.time ?? '') ||
      a.projectName.localeCompare(b.projectName) ||
      a.title.localeCompare(b.title),
  )
}

export type EntryFilter = { types: ReadonlySet<EntryType>; projectId: string | 'all' }

export function filterEntries(entries: CalendarEntry[], f: EntryFilter): CalendarEntry[] {
  return entries.filter((e) => f.types.has(e.type) && (f.projectId === 'all' || e.projectId === f.projectId))
}

/**
 * One weekly-report entry per Friday instead of one per project (so five projects do not mean five rows
 * every Friday). The merged entry keeps a link to each project's Reports tab in `parts`.
 */
export function mergeReports(entries: CalendarEntry[]): CalendarEntry[] {
  const byDay = new Map<string, CalendarEntry[]>()
  for (const e of entries) if (e.type === 'report') byDay.set(e.date, [...(byDay.get(e.date) ?? []), e])
  const out: CalendarEntry[] = []
  const done = new Set<string>()
  for (const e of entries) {
    if (e.type !== 'report') {
      out.push(e)
      continue
    }
    const group = byDay.get(e.date)!
    if (group.length === 1) {
      out.push(e)
      continue
    }
    if (done.has(e.date)) continue
    done.add(e.date)
    out.push({
      key: `report:all:${e.date}`, date: e.date, type: 'report', title: 'Weekly reports',
      detail: group.map((g) => g.projectName).join(' · '), projectId: 'all', projectName: `${group.length} projects`, href: null,
      parts: group.map((g) => ({ projectId: g.projectId, projectName: g.projectName, href: g.href! })),
    })
  }
  return out
}

/** Monday of the week holding this date. */
export function weekStartOf(iso: string): string {
  return shiftDays(iso, 1 - isoWeekday(iso))
}

export type DayGroup = { date: string; entries: CalendarEntry[] }

/** Entries grouped by day, in date order. */
export function groupByDay(entries: CalendarEntry[]): DayGroup[] {
  const map = new Map<string, CalendarEntry[]>()
  for (const e of [...entries].sort((a, b) => a.date.localeCompare(b.date))) {
    if (!map.has(e.date)) map.set(e.date, [])
    map.get(e.date)!.push(e)
  }
  return [...map.entries()].map(([date, list]) => ({ date, entries: list }))
}

/** The weeks shown for a month: rows of 7 dates, Monday first, covering the whole month. `month` is 1-12. */
export function monthGrid(year: number, month: number): string[][] {
  const first = `${year}-${String(month).padStart(2, '0')}-01`
  const last = shiftDays(month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`, -1)
  const weeks: string[][] = []
  let d = weekStartOf(first)
  while (d <= last) {
    weeks.push(Array.from({ length: 7 }, (_, i) => shiftDays(d, i)))
    d = shiftDays(d, 7)
  }
  return weeks
}

/** "Mon 23 Nov". */
export function dayLabel(iso: string): string {
  return new Date(toTime(iso)).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
}

/** "November 2026". */
export function monthLabel(year: number, month: number): string {
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' })
}

// ---------------------------------------------------------------------------------------------
// Phone calendar file (iCalendar, RFC 5545): all-day events

/** Escape text for an iCalendar TEXT value: backslash, semicolon, comma and newlines. */
export function icsEscape(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n')
}

/** Fold a content line at 75 octets (UTF-8), never splitting a character; continuation lines start with a space. */
export function foldLine(line: string): string {
  const enc = new TextEncoder()
  const parts: string[] = []
  let current = ''
  let size = 0
  for (const ch of line) {
    const n = enc.encode(ch).length
    const limit = parts.length === 0 ? 75 : 74 // the leading space counts on continuation lines
    if (size + n > limit) {
      parts.push(current)
      current = ''
      size = 0
    }
    current += ch
    size += n
  }
  parts.push(current)
  return parts.join('\r\n ')
}

const compactDate = (iso: string) => iso.replace(/-/g, '')

function stamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

/** Entries from today for `days` days (today included). */
export function icsWindow(entries: CalendarEntry[], today: string, days = 90): CalendarEntry[] {
  const end = shiftDays(today, days)
  return entries.filter((e) => e.date >= today && e.date < end)
}

/** A VCALENDAR of all-day VEVENTs, CRLF line endings, escaped and folded text, unique UIDs. */
export function buildIcs(entries: CalendarEntry[], now: Date, calendarName = 'Studio Elements'): string {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Studio Elements//Project tool//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsEscape(calendarName)}`]
  const used = new Set<string>()
  const dtstamp = stamp(now)
  for (const e of entries) {
    let uid = `${e.key.replace(/[^A-Za-z0-9-]/g, '-')}@studio-elements`
    for (let i = 2; used.has(uid); i++) uid = `${e.key.replace(/[^A-Za-z0-9-]/g, '-')}-${i}@studio-elements`
    used.add(uid)
    const summary = `${ENTRY_TAG[e.type]}: ${e.title}${e.time ? ` (${e.time})` : ''}`
    const description = [e.projectName, e.detail].filter(Boolean).join(' · ')
    lines.push(
      'BEGIN:VEVENT',
      `UID:${uid}`,
      `DTSTAMP:${dtstamp}`,
      `DTSTART;VALUE=DATE:${compactDate(e.date)}`,
      `DTEND;VALUE=DATE:${compactDate(shiftDays(e.date, 1))}`,
      `SUMMARY:${icsEscape(summary)}`,
      `DESCRIPTION:${icsEscape(description)}`,
      `CATEGORIES:${icsEscape(ENTRY_LABEL[e.type])}`,
      'TRANSP:TRANSPARENT',
      'END:VEVENT',
    )
  }
  lines.push('END:VCALENDAR')
  return lines.map(foldLine).join('\r\n') + '\r\n'
}
