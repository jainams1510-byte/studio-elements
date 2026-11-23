import { useCallback, useEffect, useState } from 'react'
import { cacheGet, cacheSet } from '../db'

export type Loaded<T> = {
  data: T | null
  /** offline: showing the phone's last copy (read-only). */
  state: 'loading' | 'ready' | 'offline'
  error: string | null
  reload: () => Promise<void>
}

/** Load from the server and keep a copy on the phone; the copy shows first and, with no signal, stays read-only. */
export function useLoad<T>(cacheKey: string, loader: () => Promise<T>, enabled = true): Loaded<T> {
  const [data, setData] = useState<T | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'offline'>('loading')
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    if (!enabled) return
    try {
      const next = await loader()
      setData(next)
      setState('ready')
      setError(null)
      await cacheSet(cacheKey, next)
    } catch (err) {
      const cached = await cacheGet<T>(cacheKey)
      if (cached) setData(cached)
      setState('offline')
      setError(navigator.onLine && err instanceof Error ? err.message : null)
    }
    // loader is rebuilt every render; the cache key names what it loads
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey, enabled])

  useEffect(() => {
    let live = true
    // Show the phone's copy at once (read-only until the server answers; the client retries for a few seconds with no signal).
    if (enabled) {
      cacheGet<T>(cacheKey).then((cached) => {
        if (live && cached) setData((d) => d ?? cached)
      })
    }
    void reload()
    return () => {
      live = false
    }
  }, [reload, cacheKey, enabled])

  return { data, state, error, reload }
}

/** Throw the request's error so useLoad falls back to the phone's copy. */
export function rows<T>(res: { data: unknown; error: { message: string } | null }): T[] {
  if (res.error) throw new Error(res.error.message)
  return (res.data ?? []) as T[]
}

export function one<T>(res: { data: unknown; error: { message: string } | null }): T | null {
  if (res.error) throw new Error(res.error.message)
  return (res.data ?? null) as T | null
}
