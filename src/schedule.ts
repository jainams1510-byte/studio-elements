/**
 * Schedule: working calendar and critical path, computed here (no paid Gantt component).
 *
 * Day numbers count working days from the schedule's start date: day 0 is the first working day on
 * or after the start. A task occupies days es .. ef-1 (ef is exclusive), so ef = es + duration.
 * A milestone takes no days; it sits on day ef-1 and its successors start on day ef.
 *
 * The forecast uses progress: done tasks sit on their actual dates, a task in progress finishes no
 * earlier than today, and nothing not yet started can start before today.
 */

export type TaskStatus = 'planned' | 'in_progress' | 'done' | 'blocked'

export type Task = {
  id: string
  project_id: string
  stage: number
  name: string
  trade: string | null
  room: string | null
  owner_name: string | null
  duration: number
  milestone: boolean
  after_ids: string[]
  status: TaskStatus
  actual_start: string | null
  actual_end: string | null
  gate_drawing_id: string | null
  baseline_start: string | null
  baseline_end: string | null
  sort_order: number
  removed_at: string | null
}

export type ScheduleSettings = {
  project_id: string
  start_date: string
  work_days: number[]
  holidays: string[]
  baseline_at: string | null
  baseline_by: string | null
}

export const TASK_SELECT =
  'id, project_id, stage, name, trade, room, owner_name, duration, milestone, after_ids, status, ' +
  'actual_start, actual_end, gate_drawing_id, baseline_start, baseline_end, sort_order, removed_at'

export const SCHEDULE_SELECT = 'project_id, start_date, work_days, holidays, baseline_at, baseline_by'

export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const

// ---------------------------------------------------------------------------------------------
// Dates (YYYY-MM-DD strings, handled as UTC days so there is no time-zone drift)

const DAY = 86_400_000

export function toTime(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number)
  return Date.UTC(y, m - 1, d)
}

export function fromTime(t: number): string {
  return new Date(t).toISOString().slice(0, 10)
}

export function shiftDays(iso: string, days: number): string {
  return fromTime(toTime(iso) + days * DAY)
}

/** ISO weekday: 1 = Monday ... 7 = Sunday. */
export function isoWeekday(iso: string): number {
  const d = new Date(toTime(iso)).getUTCDay()
  return d === 0 ? 7 : d
}

export function calendarDaysBetween(a: string, b: string): number {
  return Math.round((toTime(b) - toTime(a)) / DAY)
}

// ---------------------------------------------------------------------------------------------
// Working calendar

export class WorkCalendar {
  readonly start: string
  private readonly days: Set<number>
  private readonly holidays: Set<string>
  private readonly forward: string[] = [] // forward[i] = date of working day i (i >= 0)
  private readonly backward: string[] = [] // backward[k] = date of working day -(k+1)

  constructor(start: string, workDays: number[], holidays: string[] = []) {
    const days = workDays.filter((d) => d >= 1 && d <= 7)
    if (days.length === 0) throw new Error('At least one working day is needed.')
    this.start = start
    this.days = new Set(days)
    this.holidays = new Set(holidays)
    // A year of holidays could still leave no working day; guard against an endless search.
    let probe = start
    let found = false
    for (let i = 0; i < 400; i++) {
      if (this.isWorkDay(probe)) {
        found = true
        break
      }
      probe = shiftDays(probe, 1)
    }
    if (!found) throw new Error('No working day within a year of the start date.')
  }

  isWorkDay(iso: string): boolean {
    return this.days.has(isoWeekday(iso)) && !this.holidays.has(iso)
  }

  /** Date of working day n (negative n counts back before the start). */
  dateOf(n: number): string {
    if (n >= 0) {
      while (this.forward.length <= n) {
        let d = this.forward.length ? shiftDays(this.forward[this.forward.length - 1], 1) : this.start
        while (!this.isWorkDay(d)) d = shiftDays(d, 1)
        this.forward.push(d)
      }
      return this.forward[n]
    }
    const k = -n - 1
    while (this.backward.length <= k) {
      let d = shiftDays(this.backward.length ? this.backward[this.backward.length - 1] : this.start, -1)
      while (!this.isWorkDay(d)) d = shiftDays(d, -1)
      this.backward.push(d)
    }
    return this.backward[k]
  }

  /** Day number for a start: a non-working date moves forward to the next working day. */
  startIndex(iso: string): number {
    return this.search(iso, 'next')
  }

  /** Day number for a finish: a non-working date moves back to the previous working day. */
  endIndex(iso: string): number {
    return this.search(iso, 'previous')
  }

  private search(iso: string, roll: 'next' | 'previous'): number {
    // Estimate from the share of working days in a week, then walk to the exact answer.
    const perWeek = this.days.size / 7
    let n = Math.round(calendarDaysBetween(this.start, iso) * perWeek)
    while (this.dateOf(n) > iso) n--
    while (this.dateOf(n + 1) <= iso) n++
    // Now dateOf(n) <= iso < dateOf(n + 1).
    if (this.dateOf(n) === iso) return n
    return roll === 'next' ? n + 1 : n
  }

  /** Working days from a to b, counting finishes: positive when b is later. */
  workDaysBetween(a: string, b: string): number {
    return this.endIndex(b) - this.endIndex(a)
  }
}

// ---------------------------------------------------------------------------------------------
// Critical path

export type Planned = {
  id: string
  es: number
  ef: number
  start: string
  end: string
  float: number
  critical: boolean
  /** Working days later than the baseline finish (negative = early). Null without a baseline. */
  slip: number | null
  /** In progress for longer than its duration. */
  overdue: boolean
}

export type ScheduleResult = {
  ok: boolean
  /** Tasks caught in a loop of "After" links; they are left out of the dates. */
  loop: string[]
  tasks: Record<string, Planned>
  finish: string | null
  baselineFinish: string | null
  /** Working days the forecast finish is past the baseline finish. */
  slip: number | null
  /** Unfinished critical tasks, in order of start. */
  criticalPath: string[]
}

export function isMilestone(t: Pick<Task, 'milestone' | 'duration'>): boolean {
  return t.milestone || t.duration === 0
}

export function computeSchedule(allTasks: Task[], cal: WorkCalendar, today: string): ScheduleResult {
  const tasks = allTasks.filter((t) => !t.removed_at)
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const preds = new Map<string, string[]>()
  const succs = new Map<string, string[]>()
  for (const t of tasks) {
    const valid = [...new Set(t.after_ids)].filter((p) => p !== t.id && byId.has(p))
    preds.set(t.id, valid)
    if (!succs.has(t.id)) succs.set(t.id, [])
    for (const p of valid) {
      if (!succs.has(p)) succs.set(p, [])
      succs.get(p)!.push(t.id)
    }
  }

  // Order by links (Kahn). Whatever cannot be ordered is in, or behind, a loop.
  const indegree = new Map(tasks.map((t) => [t.id, preds.get(t.id)!.length]))
  const queue = tasks.filter((t) => indegree.get(t.id) === 0).map((t) => t.id)
  const order: string[] = []
  while (queue.length) {
    const id = queue.shift()!
    order.push(id)
    for (const s of succs.get(id)!) {
      indegree.set(s, indegree.get(s)! - 1)
      if (indegree.get(s) === 0) queue.push(s)
    }
  }
  const ordered = new Set(order)
  const loop = tasks.filter((t) => !ordered.has(t.id)).map((t) => t.id)

  const todayIdx = cal.startIndex(today)
  const es = new Map<string, number>()
  const ef = new Map<string, number>()

  // Forward pass.
  for (const id of order) {
    const t = byId.get(id)!
    const predEnd = Math.max(0, ...preds.get(id)!.map((p) => ef.get(p)!))
    const ms = isMilestone(t)
    if (t.status === 'done' && (t.actual_end || t.actual_start)) {
      const endIdx = cal.endIndex((t.actual_end ?? t.actual_start)!)
      const startIdx = ms ? endIdx : cal.startIndex((t.actual_start ?? t.actual_end)!)
      es.set(id, ms ? endIdx + 1 : startIdx)
      ef.set(id, Math.max(endIdx + 1, ms ? endIdx + 1 : startIdx))
    } else if (ms) {
      // Sits on the day its last predecessor finishes, and not before today.
      const day = Math.max(predEnd - 1, 0, t.status === 'done' ? -Infinity : todayIdx)
      es.set(id, day + 1)
      ef.set(id, day + 1)
    } else if (t.status === 'in_progress' && t.actual_start) {
      const s = cal.startIndex(t.actual_start)
      es.set(id, s)
      ef.set(id, Math.max(s + t.duration, todayIdx + 1))
    } else {
      const s = Math.max(predEnd, t.status === 'done' ? 0 : todayIdx, 0)
      es.set(id, s)
      ef.set(id, s + t.duration)
    }
  }

  const projectEnd = order.length ? Math.max(...order.map((id) => ef.get(id)!)) : 0

  // Backward pass.
  const lf = new Map<string, number>()
  const ls = new Map<string, number>()
  for (const id of [...order].reverse()) {
    const t = byId.get(id)!
    const after = succs.get(id)!.filter((s) => ordered.has(s))
    const late = after.length ? Math.min(...after.map((s) => ls.get(s)!)) : projectEnd
    lf.set(id, late)
    ls.set(id, late - (isMilestone(t) ? 0 : t.duration))
  }

  const out: Record<string, Planned> = {}
  let baselineFinishIdx: number | null = null
  let baselineFinish: string | null = null
  for (const id of order) {
    const t = byId.get(id)!
    const s = es.get(id)!
    const f = ef.get(id)!
    const end = cal.dateOf(f - 1)
    const start = isMilestone(t) ? end : cal.dateOf(s)
    const float = lf.get(id)! - f
    const slip = t.baseline_end ? cal.endIndex(end) - cal.endIndex(t.baseline_end) : null
    if (t.baseline_end) {
      const b = cal.endIndex(t.baseline_end)
      if (baselineFinishIdx === null || b > baselineFinishIdx) {
        baselineFinishIdx = b
        baselineFinish = t.baseline_end
      }
    }
    out[id] = {
      id,
      es: s,
      ef: f,
      start,
      end,
      float,
      critical: t.status !== 'done' && float <= 0,
      slip,
      overdue: t.status === 'in_progress' && !isMilestone(t) && s + t.duration <= todayIdx,
    }
  }

  const finish = order.length ? cal.dateOf(projectEnd - 1) : null
  const criticalPath = order
    .filter((id) => out[id].critical)
    .sort((a, b) => out[a].es - out[b].es || out[a].ef - out[b].ef)

  return {
    ok: loop.length === 0,
    loop,
    tasks: out,
    finish,
    baselineFinish,
    slip: finish && baselineFinishIdx !== null ? projectEnd - 1 - baselineFinishIdx : null,
    criticalPath,
  }
}

/** The frozen plan sent to the database when an owner freezes the baseline. */
export function baselinePlan(result: ScheduleResult): Record<string, { start: string; end: string }> {
  return Object.fromEntries(Object.values(result.tasks).map((p) => [p.id, { start: p.start, end: p.end }]))
}

/** Would adding these "After" links to a task create a loop? */
export function makesLoop(tasks: Task[], taskId: string, afterIds: string[]): boolean {
  const byId = new Map(tasks.filter((t) => !t.removed_at).map((t) => [t.id, t]))
  const seen = new Set<string>()
  const stack = [...afterIds]
  while (stack.length) {
    const id = stack.pop()!
    if (id === taskId) return true
    if (seen.has(id)) continue
    seen.add(id)
    const t = byId.get(id)
    if (t) stack.push(...t.after_ids)
  }
  return false
}

/** What the phone shows as the task's state. Slipped and overdue are derived, never stored. */
export function statusLabel(t: Task, p: Planned | undefined): string {
  if (t.status === 'done') return 'Done'
  if (t.status === 'blocked') return 'Blocked'
  if (p?.overdue) return 'Overdue'
  if (p && p.slip !== null && p.slip > 0) return `Slipped ${p.slip}d`
  if (t.status === 'in_progress') return 'In progress'
  return 'Planned'
}

export function formatDay(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(toTime(iso))
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' })
}
