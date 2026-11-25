import { useCallback, useEffect, useMemo, useState } from 'react'
import { cacheGet, cacheSet } from './db'
import {
  BRIEF_SELECT,
  FEE_SELECT,
  INVOICE_SELECT,
  RA_BILL_SELECT,
  VENDOR_SELECT,
  type FeeInvoice,
  type ProjectBrief,
  type ProjectFee,
  type RaBill,
  type Vendor,
} from './domain'
import { feeDrafts } from './fees/drafts'
import { raBillDrafts } from './money/drafts'
import { DRAWING_SELECT, todayLocal, type Drawing } from './drawings'
import { useProjects } from './hooks'
import { buildDrafts, projectState, type Draft, type ProjectState } from './portfolio'
import { SCHEDULE_SELECT, TASK_SELECT, type ScheduleSettings, type Task } from './schedule'
import { supabase } from './supabase'
import type { Project } from './types'

type Raw = {
  settings: ScheduleSettings[]
  tasks: Task[]
  drawings: Drawing[]
  /** Client-approved RA bills (for unpaid reminders) and vendor names. */
  bills: RaBill[]
  vendors: Vendor[]
  /** Owner-only: the database returns none of these to anyone else. */
  invoices: FeeInvoice[]
  fees: ProjectFee[]
  briefs: ProjectBrief[]
}

type Result = { data: unknown; error: unknown }

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
    const parts = {
      settings: supabase.from('project_schedules').select(SCHEDULE_SELECT),
      tasks: supabase.from('tasks').select(TASK_SELECT).is('removed_at', null),
      drawings: supabase.from('drawings').select(DRAWING_SELECT).eq('archived', false),
      bills: supabase.from('ra_bills').select(RA_BILL_SELECT).eq('status', 'client_approved').is('removed_at', null),
      vendors: supabase.from('vendors').select(VENDOR_SELECT),
      invoices: supabase.from('fee_invoices').select(INVOICE_SELECT).is('removed_at', null),
      fees: supabase.from('project_fees').select(FEE_SELECT),
      briefs: supabase.from('project_briefs').select(BRIEF_SELECT),
    }
    const keys = Object.keys(parts) as (keyof Raw)[]
    const results = (await Promise.all(keys.map((k) => parts[k]))) as Result[]
    // Each part stands on its own: one failed request must not hide the others.
    const cached = await cacheGet<Partial<Raw>>('portfolio')
    const next = {} as Record<keyof Raw, unknown[]>
    let failed = false
    keys.forEach((k, i) => {
      const r = results[i]
      if (r.error) failed = true
      next[k] = r.error ? (cached?.[k] ?? []) : ((r.data ?? []) as unknown[])
    })
    setRaw(next as unknown as Raw)
    setOffline(failed)
    if (failed) return
    await cacheSet('portfolio', next)
  }, [])

  useEffect(() => {
    let live = true
    cacheGet<Partial<Raw>>('portfolio').then((cached) => {
      if (live && cached) setRaw((current) => current ?? withDefaults(cached))
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
  const drafts = useMemo(() => {
    const live = projects.filter((p) => !p.archived)
    const r = raw ?? withDefaults({})
    return [
      ...buildDrafts(states, today),
      ...raBillDrafts({ projects: live, bills: r.bills, vendors: r.vendors, today }),
      ...feeDrafts({
        projects: live,
        invoices: r.invoices,
        fees: r.fees,
        briefs: r.briefs,
        doneTaskIds: new Set(r.tasks.filter((t) => t.status === 'done').map((t) => t.id)),
        today,
      }),
    ]
  }, [states, today, raw, projects])

  return { projects, states, drafts, drawings: raw?.drawings ?? [], ready: raw !== null, offline, error: projectError, reload }
}

/** A copy saved by an older version of the app lacks the newer parts. */
function withDefaults(c: Partial<Raw>): Raw {
  return {
    settings: c.settings ?? [],
    tasks: c.tasks ?? [],
    drawings: c.drawings ?? [],
    bills: c.bills ?? [],
    vendors: c.vendors ?? [],
    invoices: c.invoices ?? [],
    fees: c.fees ?? [],
    briefs: c.briefs ?? [],
  }
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
