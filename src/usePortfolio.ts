import { useCallback, useEffect, useMemo, useState } from 'react'
import { cacheGet, cacheSet } from './db'
import { DRAWING_SELECT, todayLocal, type Drawing } from './drawings'
import { useProjects } from './hooks'
import { buildDrafts, projectState, type Draft, type ProjectState } from './portfolio'
import { SCHEDULE_SELECT, TASK_SELECT, type ScheduleSettings, type Task } from './schedule'
import { supabase } from './supabase'
import type { Project } from './types'

type Raw = { settings: ScheduleSettings[]; tasks: Task[]; drawings: Drawing[] }

export type Portfolio = {
  projects: Project[]
  states: ProjectState[]
  drafts: Draft[]
  drawings: Drawing[]
  ready: boolean
  offline: boolean
  error: string | null
  reload: () => Promise<void>
}

/** Every active project's schedule and register, shown from the phone's copy first. */
export function usePortfolio(): Portfolio {
  const { projects, error: projectError } = useProjects()
  const [raw, setRaw] = useState<Raw | null>(null)
  const [offline, setOffline] = useState(false)

  const reload = useCallback(async () => {
    const [s, t, d] = await Promise.all([
      supabase.from('project_schedules').select(SCHEDULE_SELECT),
      supabase.from('tasks').select(TASK_SELECT).is('removed_at', null),
      supabase.from('drawings').select(DRAWING_SELECT).eq('archived', false),
    ])
    // Each part stands on its own: one failed request must not hide the others.
    const cached = await cacheGet<Raw>('portfolio')
    const next: Raw = {
      settings: s.error ? (cached?.settings ?? []) : ((s.data ?? []) as ScheduleSettings[]),
      tasks: t.error ? (cached?.tasks ?? []) : ((t.data ?? []) as unknown as Task[]),
      drawings: d.error ? (cached?.drawings ?? []) : ((d.data ?? []) as unknown as Drawing[]),
    }
    setRaw(next)
    setOffline(Boolean(s.error || t.error || d.error))
    if (s.error || t.error || d.error) return
    await cacheSet('portfolio', next)
  }, [])

  useEffect(() => {
    let live = true
    cacheGet<Raw>('portfolio').then((cached) => {
      if (live && cached) setRaw((current) => current ?? cached)
    })
    void reload()
    return () => {
      live = false
    }
  }, [reload])

  const today = todayLocal()
  // Projects always show, even before (or without) the schedule data; they just have no status yet.
  const states = useMemo(
    () =>
      projects.map((p) =>
        projectState(
          p,
          raw?.settings.find((s) => s.project_id === p.id),
          raw?.tasks.filter((t) => t.project_id === p.id) ?? [],
          raw?.drawings.filter((d) => d.project_id === p.id) ?? [],
          today,
        ),
      ),
    [raw, projects, today],
  )
  const drafts = useMemo(() => buildDrafts(states, today), [states, today])

  return { projects, states, drafts, drawings: raw?.drawings ?? [], ready: raw !== null, offline, error: projectError, reload }
}

// Drafts that were shared, copied or dismissed on this device. Keyed by situation, so a draft
// comes back when the situation changes (a new revision, a later forecast).
const HANDLED_KEY = 'studio.handledDrafts'

export function handledDrafts(): Record<string, { how: string; at: string }> {
  try {
    return JSON.parse(localStorage.getItem(HANDLED_KEY) ?? '{}') as Record<string, { how: string; at: string }>
  } catch {
    return {}
  }
}

export function markDraft(key: string, how: 'shared' | 'copied' | 'dismissed'): void {
  try {
    const all = handledDrafts()
    all[key] = { how, at: new Date().toISOString() }
    // Keep the list small: drop entries older than 60 days.
    const cutoff = Date.now() - 60 * 86_400_000
    for (const [k, v] of Object.entries(all)) if (Date.parse(v.at) < cutoff) delete all[k]
    localStorage.setItem(HANDLED_KEY, JSON.stringify(all))
    window.dispatchEvent(new Event('drafts-changed'))
  } catch {
    // Storage can be unavailable (private mode); the draft just stays listed.
  }
}

export function useOpenDrafts(drafts: Draft[]): Draft[] {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const bump = () => setTick((t) => t + 1)
    window.addEventListener('drafts-changed', bump)
    return () => window.removeEventListener('drafts-changed', bump)
  }, [])
  return useMemo(() => {
    void tick
    const handled = handledDrafts()
    return drafts.filter((d) => !handled[d.key])
  }, [drafts, tick])
}
