import { useEffect, useState } from 'react'
import { cacheGet, cacheSet } from './db'
import { supabase } from './supabase'

export type Person = { id: string; full_name: string; role: string }
export type Team = { me: Person | null; names: Record<string, string> }

/** Who is signed in and everyone's display names. Shown from the phone's copy first. */
export function useTeam(): Team {
  const [team, setTeam] = useState<Team>({ me: null, names: {} })

  useEffect(() => {
    let live = true
    cacheGet<Team>('team').then((cached) => {
      if (live && cached) setTeam((t) => (t.me ? t : cached))
    })
    ;(async () => {
      const { data: session } = await supabase.auth.getSession()
      const uid = session.session?.user.id
      if (!uid) return
      const { data, error } = await supabase.from('profiles').select('id, full_name, role')
      if (error || !data || !live) return
      const people = data as Person[]
      const next: Team = {
        me: people.find((p) => p.id === uid) ?? null,
        names: Object.fromEntries(people.map((p) => [p.id, p.full_name])),
      }
      setTeam(next)
      await cacheSet('team', next)
    })()
    return () => {
      live = false
    }
  }, [])

  return team
}

export const isOwner = (me: Person | null) => me?.role === 'owner'
