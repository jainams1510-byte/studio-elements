import { useCallback, useEffect, useMemo, useState } from 'react'
import { cacheGet, cacheSet } from './db'
import { currentRevision, DRAWING_SELECT, isConstruction, todayLocal, type Drawing } from './drawings'
import {
  calendarDaysBetween,
  computeSchedule,
  SCHEDULE_SELECT,
  TASK_SELECT,
  WorkCalendar,
  type ScheduleResult,
  type ScheduleSettings,
  type Task,
} from './schedule'
import { supabase } from './supabase'

export type ScheduleChange = {
  id: string
  task_id: string | null
  kind: string
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  reason: string | null
  changed_by: string | null
  changed_at: string
}

type Cached = { settings: ScheduleSettings | null; tasks: Task[]; drawings: Drawing[] }

export type ScheduleData = {
  state: 'loading' | 'ready' | 'offline'
  error: string | null
  settings: ScheduleSettings | null
  tasks: Task[]
  drawings: Drawing[]
  changes: ScheduleChange[]
  calendar: WorkCalendar | null
  result: ScheduleResult | null
  gateFlags: Record<string, string>
  reload: () => Promise<void>
}

/** A task whose sheet is not yet for construction, starting within a week or already started. */
export function gateFlag(task: Task, start: string | undefined, drawings: Drawing[], today: string): string | null {
  if (!task.gate_drawing_id || task.status === 'done' || task.removed_at) return null
  const drawing = drawings.find((d) => d.id === task.gate_drawing_id)
  if (!drawing) return null
  const rev = currentRevision(drawing)
  if (rev && isConstruction(rev.code)) return null
  if (task.status === 'planned' && start && calendarDaysBetween(today, start) > 7) return null
  return `${drawing.number} is at ${rev?.code ?? 'no revision'}, not R0 yet`
}

export function useSchedule(projectId: string): ScheduleData {
  const [state, setState] = useState<'loading' | 'ready' | 'offline'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [settings, setSettings] = useState<ScheduleSettings | null>(null)
  const [tasks, setTasks] = useState<Task[]>([])
  const [drawings, setDrawings] = useState<Drawing[]>([])
  const [changes, setChanges] = useState<ScheduleChange[]>([])
  const cacheKey = `schedule:${projectId}`

  const reload = useCallback(async () => {
    const [s, t, d, c] = await Promise.all([
      supabase.from('project_schedules').select(SCHEDULE_SELECT).eq('project_id', projectId).maybeSingle(),
      supabase.from('tasks').select(TASK_SELECT).eq('project_id', projectId).order('stage').order('sort_order'),
      supabase.from('drawings').select(DRAWING_SELECT).eq('project_id', projectId).eq('archived', false),
      supabase
        .from('schedule_changes')
        .select('id, task_id, kind, before, after, reason, changed_by, changed_at')
        .eq('project_id', projectId)
        .order('changed_at', { ascending: false })
        .limit(50),
    ])
    const failed = s.error ?? t.error ?? d.error
    if (failed) {
      const cached = await cacheGet<Cached>(cacheKey)
      if (cached) {
        setSettings(cached.settings)
        setTasks(cached.tasks)
        setDrawings(cached.drawings)
      }
      setState('offline')
      setError(navigator.onLine ? failed.message : null)
      return
    }
    const next: Cached = {
      settings: (s.data as ScheduleSettings | null) ?? null,
      tasks: (t.data ?? []) as unknown as Task[],
      drawings: (d.data ?? []) as unknown as Drawing[],
    }
    setSettings(next.settings)
    setTasks(next.tasks)
    setDrawings(next.drawings)
    setChanges(c.error ? [] : ((c.data ?? []) as ScheduleChange[]))
    setState('ready')
    setError(null)
    await cacheSet(cacheKey, next)
  }, [projectId, cacheKey])

  useEffect(() => {
    void reload()
  }, [reload])

  const calendar = useMemo(() => {
    if (!settings) return null
    try {
      return new WorkCalendar(settings.start_date, settings.work_days, settings.holidays)
    } catch {
      return null
    }
  }, [settings])

  const today = todayLocal()
  const result = useMemo(() => (calendar ? computeSchedule(tasks, calendar, today) : null), [calendar, tasks, today])

  const gateFlags = useMemo(() => {
    const out: Record<string, string> = {}
    for (const t of tasks) {
      const flag = gateFlag(t, result?.tasks[t.id]?.start, drawings, today)
      if (flag) out[t.id] = flag
    }
    return out
  }, [tasks, drawings, result, today])

  return { state, error, settings, tasks, drawings, changes, calendar, result, gateFlags, reload }
}

export type ProjectRisk = { overdue: number; gates: number; blocked: number; lateMilestone: { name: string; slip: number } | null; loop: boolean }

/** Milestones count as a risk once their forecast is more than this many working days past baseline. */
export const MILESTONE_SLIP_DAYS = 7

/** What Today flags for one project's schedule. */
export function projectRisk(settings: ScheduleSettings, tasks: Task[], drawings: Drawing[], today: string): ProjectRisk | null {
  let cal: WorkCalendar
  try {
    cal = new WorkCalendar(settings.start_date, settings.work_days, settings.holidays)
  } catch {
    return null
  }
  const r = computeSchedule(tasks, cal, today)
  const live = tasks.filter((t) => !t.removed_at)
  let lateMilestone: { name: string; slip: number } | null = null
  for (const t of live) {
    const p = r.tasks[t.id]
    if (!p || t.status === 'done' || !(t.milestone || t.duration === 0)) continue
    if (p.slip !== null && p.slip > MILESTONE_SLIP_DAYS && (!lateMilestone || p.slip > lateMilestone.slip)) lateMilestone = { name: t.name, slip: p.slip }
  }
  const risk: ProjectRisk = {
    overdue: live.filter((t) => r.tasks[t.id]?.overdue).length,
    gates: live.filter((t) => gateFlag(t, r.tasks[t.id]?.start, drawings, today)).length,
    blocked: live.filter((t) => t.status === 'blocked').length,
    lateMilestone,
    loop: !r.ok,
  }
  return risk.overdue || risk.gates || risk.blocked || risk.lateMilestone || risk.loop ? risk : null
}

export function riskText(r: ProjectRisk): string {
  const parts: string[] = []
  if (r.lateMilestone) parts.push(`${r.lateMilestone.name} forecast ${r.lateMilestone.slip} working days late`)
  if (r.overdue) parts.push(`${r.overdue} task${r.overdue === 1 ? '' : 's'} overdue`)
  if (r.gates) parts.push(`${r.gates} waiting on a sheet at R0`)
  if (r.blocked) parts.push(`${r.blocked} blocked`)
  if (r.loop) parts.push('“After” links loop')
  return parts.join(' · ')
}
