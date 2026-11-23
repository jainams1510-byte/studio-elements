import { useCallback, useEffect, useState } from 'react'
import { cacheGet, cacheSet } from './db'
import { countOutbox, syncOutbox } from './queue'
import { remote, supabase } from './supabase'
import type { Project } from './types'

export function useHashRoute(): string {
  const read = () => window.location.hash.replace(/^#/, '') || '/'
  const [route, setRoute] = useState(read)
  useEffect(() => {
    const onChange = () => setRoute(read())
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return route
}

export function go(path: string): void {
  window.location.hash = path
}

export function useOnline(): boolean {
  const [online, setOnline] = useState(navigator.onLine)
  useEffect(() => {
    const up = () => setOnline(true)
    const down = () => setOnline(false)
    window.addEventListener('online', up)
    window.addEventListener('offline', down)
    return () => {
      window.removeEventListener('online', up)
      window.removeEventListener('offline', down)
    }
  }, [])
  return online
}

/** How many logs are still only on this phone. */
export function useOutboxCount(): number {
  const [count, setCount] = useState(0)
  useEffect(() => {
    const refresh = () => {
      countOutbox().then(setCount, () => setCount(0))
    }
    refresh()
    window.addEventListener('outbox-changed', refresh)
    return () => window.removeEventListener('outbox-changed', refresh)
  }, [])
  return count
}

/** Changes every time the outbox changes, even when the count stays the same. */
export function useOutboxTick(): number {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const bump = () => setTick((t) => t + 1)
    window.addEventListener('outbox-changed', bump)
    return () => window.removeEventListener('outbox-changed', bump)
  }, [])
  return tick
}

/** Upload waiting logs when the app opens, comes to the front, or gets signal. */
export function useAutoSync(signedIn: boolean): void {
  useEffect(() => {
    if (!signedIn) return
    const attempt = () => {
      if (navigator.onLine) void syncOutbox(remote)
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') attempt()
    }
    attempt()
    window.addEventListener('online', attempt)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('online', attempt)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [signedIn])
}

export const PROJECT_SELECT = 'id, name, code, stage, rooms, trades, archived'

/** Fetch the active projects and refresh the phone's copy. Throws if the server can't be reached. */
export async function refreshProjects(): Promise<Project[]> {
  const { data, error } = await supabase
    .from('projects')
    .select(PROJECT_SELECT)
    .eq('archived', false)
    .order('name')
  if (error) throw new Error(error.message)
  const list = (data ?? []) as Project[]
  await cacheSet('projects', list)
  return list
}

/** Projects, shown from the phone's copy first so the list works with no signal. */
export function useProjects(): { projects: Project[]; reload: () => Promise<void>; error: string | null } {
  const [projects, setProjects] = useState<Project[]>([])
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    try {
      setProjects(await refreshProjects())
      setError(null)
    } catch (err) {
      setError(navigator.onLine && err instanceof Error ? err.message : null)
    }
  }, [])

  useEffect(() => {
    let live = true
    cacheGet<Project[]>('projects').then((cached) => {
      if (live && cached) setProjects((current) => (current.length ? current : cached))
    })
    void reload()
    const onChange = () => void reload()
    window.addEventListener('projects-changed', onChange)
    return () => {
      live = false
      window.removeEventListener('projects-changed', onChange)
    }
  }, [reload])

  return { projects, reload, error }
}
