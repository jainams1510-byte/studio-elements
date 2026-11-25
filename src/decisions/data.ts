/**
 * Loading for the Decisions, Procurement and Calendar screens. Each loads from Supabase and keeps a copy
 * on the phone; with no signal the copy is shown read-only (state 'offline').
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { cacheGet, cacheSet } from '../db'
import { DRAWING_SELECT, type Drawing } from '../drawings'
import {
  DECISION_SELECT,
  INVOICE_SELECT,
  PROCUREMENT_SELECT,
  RA_BILL_SELECT,
  VARIATION_SELECT,
  VENDOR_SELECT,
  VISIT_SELECT,
  type Decision,
  type FeeInvoice,
  type ProcurementItem,
  type RaBill,
  type SiteVisit,
  type Variation,
  type Vendor,
} from '../domain'
import { SCHEDULE_SELECT, TASK_SELECT, type ScheduleSettings, type Task } from '../schedule'
import { supabase } from '../supabase'

/** 'stale': the phone's copy is on show while the server is asked (read-only until fresh data arrives). */
export type LoadState = 'loading' | 'stale' | 'ready' | 'offline'

/** Show the phone's copy at once: supabase-js retries a failed read for about 7 s before giving up. */
function useCacheFirst<T>(key: string, answered: { current: boolean }, show: (cached: T) => void) {
  useEffect(() => {
    let live = true
    cacheGet<T>(key).then((cached) => {
      if (live && cached && !answered.current) show(cached)
    })
    return () => {
      live = false
    }
  }, [key, answered, show])
}

export function friendly(message: string | undefined, what = 'This change'): string {
  if (!navigator.onLine) return `No signal. ${what} needs a connection.`
  return message ?? 'Something went wrong. Try again.'
}

// ---- Decisions ------------------------------------------------------------------------------

export type SheetLite = { id: string; number: string; title: string }
export type BoqLite = { id: string; item: string; room: string | null; removed_at: string | null }
export type TaskLite = { id: string; name: string; stage: number; removed_at: string | null }
export type LogLite = { id: string; note: string; room: string | null; logged_at: string }

export type DecisionsRaw = {
  decisions: Decision[]
  variations: Variation[]
  sheets: SheetLite[]
  boq: BoqLite[]
  tasks: TaskLite[]
  logs: LogLite[]
}

const EMPTY_DECISIONS: DecisionsRaw = { decisions: [], variations: [], sheets: [], boq: [], tasks: [], logs: [] }

export function useDecisionsData(projectId: string) {
  const [raw, setRaw] = useState<DecisionsRaw>(EMPTY_DECISIONS)
  const [state, setState] = useState<LoadState>('loading')
  const [error, setError] = useState<string | null>(null)
  const key = `decisions:${projectId}`
  const answered = useRef(false)

  const reload = useCallback(async () => {
    const [d, v, s, b, t, l] = await Promise.all([
      supabase.from('decisions').select(DECISION_SELECT).eq('project_id', projectId),
      supabase.from('variations').select(VARIATION_SELECT).eq('project_id', projectId),
      supabase.from('drawings').select('id, number, title').eq('project_id', projectId).eq('archived', false),
      supabase.from('boq_items').select('id, item, room, removed_at').eq('project_id', projectId),
      supabase.from('tasks').select('id, name, stage, removed_at').eq('project_id', projectId),
      supabase.from('site_logs').select('id, note, room, logged_at').eq('project_id', projectId).is('removed_at', null)
        .order('logged_at', { ascending: false }).limit(30),
    ])
    answered.current = true
    if (d.error) {
      const cached = await cacheGet<DecisionsRaw>(key)
      if (cached) setRaw(cached)
      setState('offline')
      setError(navigator.onLine ? d.error.message : null)
      return
    }
    // The links are optional: a failed list only empties its picker.
    const next: DecisionsRaw = {
      decisions: (d.data ?? []) as unknown as Decision[],
      variations: v.error ? [] : ((v.data ?? []) as unknown as Variation[]),
      sheets: s.error ? [] : ((s.data ?? []) as SheetLite[]),
      boq: b.error ? [] : ((b.data ?? []) as BoqLite[]),
      tasks: t.error ? [] : ((t.data ?? []) as unknown as TaskLite[]),
      logs: l.error ? [] : ((l.data ?? []) as LogLite[]),
    }
    setRaw(next)
    setState('ready')
    setError(null)
    await cacheSet(key, next)
  }, [projectId, key])

  const showCached = useCallback((c: DecisionsRaw) => {
    setRaw(c)
    setState(navigator.onLine ? 'stale' : 'offline')
  }, [])
  useCacheFirst<DecisionsRaw>(key, answered, showCached)
  useEffect(() => {
    void reload()
  }, [reload])

  return { ...raw, state, error, reload }
}

// ---- Procurement ----------------------------------------------------------------------------

export type ProcurementRaw = { items: ProcurementItem[]; vendors: Vendor[] }

export function useProcurementData(projectId: string) {
  const [raw, setRaw] = useState<ProcurementRaw>({ items: [], vendors: [] })
  const [state, setState] = useState<LoadState>('loading')
  const [error, setError] = useState<string | null>(null)
  const key = `procurement:${projectId}`
  const answered = useRef(false)

  const reload = useCallback(async () => {
    const [i, v] = await Promise.all([
      supabase.from('procurement_items').select(PROCUREMENT_SELECT).eq('project_id', projectId),
      supabase.from('vendors').select(VENDOR_SELECT).order('name'),
    ])
    answered.current = true
    if (i.error) {
      const cached = await cacheGet<ProcurementRaw>(key)
      if (cached) setRaw(cached)
      setState('offline')
      setError(navigator.onLine ? i.error.message : null)
      return
    }
    const next: ProcurementRaw = {
      items: (i.data ?? []) as unknown as ProcurementItem[],
      vendors: v.error ? [] : ((v.data ?? []) as unknown as Vendor[]),
    }
    setRaw(next)
    setState('ready')
    setError(null)
    await cacheSet(key, next)
  }, [projectId, key])

  const showCached = useCallback((c: ProcurementRaw) => {
    setRaw(c)
    setState(navigator.onLine ? 'stale' : 'offline')
  }, [])
  useCacheFirst<ProcurementRaw>(key, answered, showCached)
  useEffect(() => {
    void reload()
  }, [reload])

  return { ...raw, state, error, reload }
}

// ---- Calendar (every project) -------------------------------------------------------------

export type CalendarRaw = {
  settings: ScheduleSettings[]
  tasks: Task[]
  drawings: Drawing[]
  procurement: ProcurementItem[]
  visits: SiteVisit[]
  invoices: FeeInvoice[]
  bills: RaBill[]
  vendors: { id: string; name: string }[]
  decisions: Decision[]
}

const CAL_KEY = 'calendar'

export function useCalendarData() {
  const [raw, setRaw] = useState<CalendarRaw | null>(null)
  const [offline, setOffline] = useState(false)
  const [fresh, setFresh] = useState(false)

  const reload = useCallback(async () => {
    const res = await Promise.all([
      supabase.from('project_schedules').select(SCHEDULE_SELECT),
      supabase.from('tasks').select(TASK_SELECT).is('removed_at', null),
      supabase.from('drawings').select(DRAWING_SELECT).eq('archived', false),
      supabase.from('procurement_items').select(PROCUREMENT_SELECT).is('removed_at', null),
      supabase.from('site_visits').select(VISIT_SELECT),
      supabase.from('fee_invoices').select(INVOICE_SELECT).is('removed_at', null),
      supabase.from('ra_bills').select(RA_BILL_SELECT).is('removed_at', null),
      supabase.from('vendors').select('id, name'),
      supabase.from('decisions').select(DECISION_SELECT).is('removed_at', null),
    ])
    const cached = await cacheGet<CalendarRaw>(CAL_KEY)
    const names = ['settings', 'tasks', 'drawings', 'procurement', 'visits', 'invoices', 'bills', 'vendors', 'decisions'] as const
    const next = {} as Record<(typeof names)[number], unknown[]>
    let failed = false
    names.forEach((n, i) => {
      const r = res[i]
      if (r.error) {
        // Fee invoices are owners-only: anyone else simply gets none.
        if (n !== 'invoices') failed = true
        next[n] = n === 'invoices' ? [] : ((cached?.[n] as unknown[]) ?? [])
      } else next[n] = (r.data ?? []) as unknown[]
    })
    setRaw(next as unknown as CalendarRaw)
    setOffline(failed)
    setFresh(true)
    if (!failed) await cacheSet(CAL_KEY, next)
  }, [])

  useEffect(() => {
    let live = true
    cacheGet<CalendarRaw>(CAL_KEY).then((c) => {
      if (live && c) setRaw((cur) => cur ?? c)
    })
    void reload()
    return () => {
      live = false
    }
  }, [reload])

  return { raw, offline: offline || !navigator.onLine, fresh, reload }
}
