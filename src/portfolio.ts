/**
 * Portfolio view of every project: status, progress against plan, days to handover, drafted messages
 * and team workload. All of it is derived by rules from the schedule and the drawing register;
 * nothing here is stored and nothing is sent.
 */
import { currentRevision, needsAttention, siteStatus, type Drawing } from './drawings'
import { calendarDaysBetween, computeSchedule, formatDay, isMilestone, WorkCalendar, type ScheduleResult, type ScheduleSettings, type Task } from './schedule'
import type { Project } from './types'
import { gateFlag, MILESTONE_SLIP_DAYS } from './useSchedule'

export type Health = 'ok' | 'risk' | 'late' | 'none'
export const HEALTH_LABEL: Record<Health, string> = { ok: 'On track', risk: 'At risk', late: 'Delayed', none: 'No schedule' }

export type ProjectState = {
  project: Project
  health: Health
  /** Share of working days done, 0-100. Null without tasks. */
  progress: number | null
  /** Share of working days the baseline planned done by today, 0-100. Null without a baseline. */
  plan: number | null
  finish: string | null
  daysLeft: number | null
  slip: number | null
  overdue: Task[]
  gates: { task: Task; text: string }[]
  blocked: Task[]
  lateMilestones: { task: Task; slip: number; end: string }[]
  nextMilestone: { task: Task; end: string } | null
  sitePrints: Drawing[]
  result: ScheduleResult | null
  reasons: string[]
  /** The project's tasks that are not removed. */
  tasks: Task[]
}

/** Status, progress and risks for one project. */
export function projectState(project: Project, settings: ScheduleSettings | undefined, allTasks: Task[], drawings: Drawing[], today: string): ProjectState {
  const sitePrints = drawings.filter((d) => needsAttention(siteStatus(d)))
  const base: ProjectState = {
    project, health: 'none', progress: null, plan: null, finish: null, daysLeft: null, slip: null,
    overdue: [], gates: [], blocked: [], lateMilestones: [], nextMilestone: null, sitePrints, result: null, reasons: [],
    tasks: allTasks.filter((t) => !t.removed_at),
  }
  if (!settings) return base
  let cal: WorkCalendar
  try {
    cal = new WorkCalendar(settings.start_date, settings.work_days, settings.holidays)
  } catch {
    return base
  }
  const tasks = allTasks.filter((t) => !t.removed_at)
  const r = computeSchedule(tasks, cal, today)
  const work = tasks.filter((t) => !isMilestone(t))
  const total = work.reduce((a, t) => a + t.duration, 0)
  const done = work.filter((t) => t.status === 'done').reduce((a, t) => a + t.duration, 0)
  const withBaseline = work.filter((t) => t.baseline_end)
  const planned = withBaseline.filter((t) => t.baseline_end! < today).reduce((a, t) => a + t.duration, 0)

  const overdue = tasks.filter((t) => r.tasks[t.id]?.overdue)
  const gates = tasks.flatMap((t) => {
    const text = gateFlag(t, r.tasks[t.id]?.start, drawings, today)
    return text ? [{ task: t, text }] : []
  })
  const blocked = tasks.filter((t) => t.status === 'blocked')
  const milestones = tasks.filter((t) => isMilestone(t) && t.status !== 'done' && r.tasks[t.id])
  const lateMilestones = milestones
    .filter((t) => (r.tasks[t.id].slip ?? 0) > MILESTONE_SLIP_DAYS)
    .map((t) => ({ task: t, slip: r.tasks[t.id].slip!, end: r.tasks[t.id].end }))
    .sort((a, b) => b.slip - a.slip)
  const next = milestones.sort((a, b) => r.tasks[a.id].ef - r.tasks[b.id].ef)[0]

  const reasons: string[] = []
  if (!r.ok) reasons.push('“After” links loop')
  for (const m of lateMilestones.slice(0, 1)) reasons.push(`${m.task.name} forecast ${m.slip} working days late`)
  if (overdue.length) reasons.push(`${overdue.length} task${overdue.length === 1 ? '' : 's'} overdue`)
  if (gates.length) reasons.push(`${gates.length} waiting on a sheet at R0`)
  if (blocked.length) reasons.push(`${blocked.length} blocked`)
  if (sitePrints.length) reasons.push(`${sitePrints.length} print${sitePrints.length === 1 ? '' : 's'} on site to replace`)
  if (r.slip && r.slip > 0 && !lateMilestones.length) reasons.push(`finish ${r.slip} working days past baseline`)

  const late = !r.ok || lateMilestones.length > 0 || (r.slip ?? 0) > MILESTONE_SLIP_DAYS
  const risk = overdue.length > 0 || gates.length > 0 || blocked.length > 0 || sitePrints.length > 0 || (r.slip ?? 0) > 0

  return {
    ...base,
    health: tasks.length === 0 ? 'none' : late ? 'late' : risk ? 'risk' : 'ok',
    progress: total ? Math.round((done / total) * 100) : null,
    plan: withBaseline.length && total ? Math.round((planned / total) * 100) : null,
    finish: r.finish,
    daysLeft: r.finish ? calendarDaysBetween(today, r.finish) : null,
    slip: r.slip,
    overdue, gates, blocked, lateMilestones,
    nextMilestone: next ? { task: next, end: r.tasks[next.id].end } : null,
    result: r,
    reasons,
  }
}

// ---------------------------------------------------------------------------------------------
// Drafts: messages the rules suggest. A person edits and sends them; the app never sends.

export type DraftKind = 'client' | 'site' | 'team'
export const DRAFT_KIND_LABEL: Record<DraftKind, string> = { client: 'Client', site: 'Site', team: 'Internal' }

export type Draft = {
  /** Changes when the situation changes, so a dismissed draft comes back if things get worse. */
  key: string
  kind: DraftKind
  projectId: string
  projectName: string
  to: string
  subject: string
  why: string
  body: string
}

export function buildDrafts(states: ProjectState[], today: string): Draft[] {
  const out: Draft[] = []
  for (const s of states) {
    const name = s.project.name
    const pid = s.project.id
    for (const m of s.lateMilestones.slice(0, 1)) {
      out.push({
        key: `late:${m.task.id}:${m.end}`,
        kind: 'client',
        projectId: pid,
        projectName: name,
        to: 'Client',
        subject: `Schedule update: ${name}`,
        why: `${m.task.name} is forecast ${m.slip} working days past the baseline (now ${formatDay(m.end)}).`,
        body:
          `Hello,\n\nA quick update on ${name}. “${m.task.name}” is now expected on ${formatDay(m.end)}, ` +
          `about ${m.slip} working days later than planned. We are working on ways to bring it back and will confirm the revised dates this week.\n\nRegards,\nStudio Elements`,
      })
    }
    for (const d of s.sitePrints) {
      const rev = currentRevision(d)
      const st = siteStatus(d)
      const held = st.kind === 'outdated' || st.kind === 'preliminary' ? st.held : ''
      out.push({
        key: `print:${d.id}:${rev?.code ?? ''}:${held}`,
        kind: 'site',
        projectId: pid,
        projectName: name,
        to: 'Site',
        subject: `Replace print ${d.number}`,
        why: st.kind === 'outdated' ? `Site holds ${held}; current is ${rev?.code}.` : `Site holds ${held}, which is not for construction.`,
        body:
          st.kind === 'outdated'
            ? `${d.number} ${d.title}: please remove the ${held} print from site and use only ${rev?.code}. Work from ${held} must stop until checked against ${rev?.code}.`
            : `${d.number} ${d.title}: the print on site (${held}) is preliminary and not for construction. Please do not build from it; the construction issue will follow.`,
      })
    }
    for (const g of s.gates) {
      out.push({
        key: `gate:${g.task.id}:${g.text}`,
        kind: 'team',
        projectId: pid,
        projectName: name,
        to: 'Design team',
        subject: `Sheet needed at R0: ${g.task.name}`,
        why: g.text,
        body: `${name}: “${g.task.name}” ${g.task.status === 'planned' ? `starts ${formatDay(s.result?.tasks[g.task.id]?.start ?? today)}` : 'has started'}, but ${g.text}. Please issue the construction revision or tell me what is holding it.`,
      })
    }
    for (const t of s.overdue) {
      const end = s.result?.tasks[t.id]?.end
      out.push({
        key: `overdue:${t.id}:${end}`,
        kind: 'team',
        projectId: pid,
        projectName: name,
        to: t.owner_name || 'Task owner',
        subject: `Overdue: ${t.name}`,
        why: `In progress since ${formatDay(t.actual_start)}, planned for ${t.duration} working days.`,
        body: `${name}: “${t.name}” has run past its ${t.duration} working days (started ${formatDay(t.actual_start)}). What is left, and when will it finish?`,
      })
    }
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Team workload: unfinished tasks by owner name, across projects.

export type Load = { owner: string; open: { task: Task; project: string; end: string | null; overdue: boolean; critical: boolean }[]; overdue: number }

export function teamLoad(states: ProjectState[], today: string): Load[] {
  const by = new Map<string, Load>()
  for (const s of states) {
    if (!s.result) continue
    for (const t of s.tasks) {
      const p = s.result.tasks[t.id]
      if (!p || t.status === 'done' || isMilestone(t)) continue
      const owner = t.owner_name?.trim() || 'Unassigned'
      if (!by.has(owner)) by.set(owner, { owner, open: [], overdue: 0 })
      const l = by.get(owner)!
      // Only what starts within four weeks counts as current load.
      if (t.status === 'planned' && calendarDaysBetween(today, p.start) > 28) continue
      l.open.push({ task: t, project: s.project.name, end: p.end, overdue: p.overdue, critical: p.critical })
      if (p.overdue) l.overdue++
    }
  }
  return [...by.values()]
    .filter((l) => l.open.length)
    .map((l) => ({ ...l, open: l.open.sort((a, b) => Number(b.overdue) - Number(a.overdue) || (a.end ?? '').localeCompare(b.end ?? '')) }))
    .sort((a, b) => (a.owner === 'Unassigned' ? 1 : b.owner === 'Unassigned' ? -1 : b.overdue - a.overdue || b.open.length - a.open.length))
}
