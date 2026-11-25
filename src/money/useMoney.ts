/** Loads everything the Money tab shows for one project, keeps a copy on the phone, and shows that copy when there is no signal. */
import { useCallback, useEffect, useState } from 'react'
import { cacheGet, cacheSet } from '../db'
import {
  BOQ_SELECT, BRIEF_SELECT, QUOTE_SELECT, RA_BILL_SELECT, RA_LINE_SELECT, VARIATION_SELECT, VENDOR_SELECT, WORK_ORDER_SELECT,
  type BoqItem, type ProjectBrief, type Quote, type RaBill, type RaBillLine, type Variation, type Vendor, type WorkOrder,
} from '../domain'
import { PROJECT_SELECT } from '../hooks'
import { supabase } from '../supabase'
import type { Project } from '../types'

export type DecisionRef = { id: string; question: string; boq_item_id: string | null; status: string }

export type MoneyData = {
  project: Project | null
  brief: ProjectBrief | null
  studioName: string
  items: BoqItem[]
  quotes: Quote[]
  workOrders: WorkOrder[]
  vendors: Vendor[]
  bills: RaBill[]
  billLines: RaBillLine[]
  variations: Variation[]
  decisions: DecisionRef[]
}

const EMPTY: MoneyData = {
  project: null, brief: null, studioName: 'Studio Elements', items: [], quotes: [], workOrders: [], vendors: [], bills: [], billLines: [], variations: [], decisions: [],
}

export type MoneyState = { data: MoneyData; state: 'loading' | 'ready' | 'offline'; error: string | null; reload: () => Promise<void> }

export function useMoney(projectId: string): MoneyState {
  const [data, setData] = useState<MoneyData>(EMPTY)
  const [state, setState] = useState<MoneyState['state']>('loading')
  const [error, setError] = useState<string | null>(null)
  const key = `money:${projectId}`

  const load = useCallback(async () => {
    // With no signal, go straight to the phone's copy rather than wait for requests that cannot succeed.
    if (!navigator.onLine) {
      const cached = await cacheGet<MoneyData>(key)
      if (cached) setData(cached)
      setState('offline')
      return
    }
    try {
      const [project, brief, settings, items, quotes, orders, vendors, bills, variations, decisions] = await Promise.all([
        supabase.from('projects').select(PROJECT_SELECT).eq('id', projectId).maybeSingle(),
        supabase.from('project_briefs').select(BRIEF_SELECT).eq('project_id', projectId).maybeSingle(),
        supabase.from('studio_settings').select('name').eq('id', 1).maybeSingle(),
        supabase.from('boq_items').select(BOQ_SELECT).eq('project_id', projectId),
        supabase.from('quotes').select(QUOTE_SELECT).eq('project_id', projectId),
        supabase.from('work_orders').select(WORK_ORDER_SELECT).eq('project_id', projectId),
        supabase.from('vendors').select(VENDOR_SELECT).order('name'),
        supabase.from('ra_bills').select(RA_BILL_SELECT).eq('project_id', projectId),
        supabase.from('variations').select(VARIATION_SELECT).eq('project_id', projectId),
        supabase.from('decisions').select('id, question, boq_item_id, status').eq('project_id', projectId),
      ])
      const firstError = [project, brief, items, quotes, orders, vendors, bills, variations].find((r) => r.error)?.error
      if (firstError) throw new Error(firstError.message)
      const billRows = (bills.data ?? []) as unknown as RaBill[]
      let billLines: RaBillLine[] = []
      if (billRows.length) {
        const res = await supabase.from('ra_bill_lines').select(RA_LINE_SELECT).in('bill_id', billRows.map((b) => b.id))
        if (res.error) throw new Error(res.error.message)
        const ids = new Set(billRows.map((b) => b.id))
        billLines = ((res.data ?? []) as unknown as RaBillLine[]).filter((l) => ids.has(l.bill_id))
      }
      const next: MoneyData = {
        project: (project.data as Project | null) ?? null,
        brief: (brief.data as unknown as ProjectBrief | null) ?? null,
        studioName: (settings.data as { name?: string } | null)?.name || 'Studio Elements',
        items: (items.data ?? []) as unknown as BoqItem[],
        quotes: (quotes.data ?? []) as unknown as Quote[],
        workOrders: (orders.data ?? []) as unknown as WorkOrder[],
        vendors: (vendors.data ?? []) as unknown as Vendor[],
        bills: billRows,
        billLines,
        variations: (variations.data ?? []) as unknown as Variation[],
        // Decisions belong to another module; the Money tab only reads their questions, and works without them.
        decisions: decisions.error ? [] : ((decisions.data ?? []) as unknown as DecisionRef[]),
      }
      setData(next)
      setState('ready')
      setError(null)
      await cacheSet(key, next)
    } catch (err) {
      const cached = await cacheGet<MoneyData>(key)
      if (cached) setData(cached)
      if (navigator.onLine) {
        setError(`Could not load the money records: ${err instanceof Error ? err.message : String(err)}`)
      }
      setState('offline')
    }
  }, [projectId, key])

  useEffect(() => {
    let live = true
    // Show the phone's copy while the latest loads (read-only until it arrives).
    cacheGet<MoneyData>(key).then((cached) => {
      if (live && cached) setData((d) => (d.project ? d : cached))
    })
    void load()
    return () => {
      live = false
    }
  }, [load, key])

  return { data, state, error, reload: load }
}
