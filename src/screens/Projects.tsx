import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { go, PROJECT_SELECT, refreshProjects } from '../hooks'
import { HEALTH_LABEL, type Health } from '../portfolio'
import { usePortfolio } from '../usePortfolio'
import { ProjectCard } from './PortfolioParts'
import { supabase } from '../supabase'
import { isOwner, useTeam } from '../team'
import { STAGES, type Project } from '../types'
import BackupCard from './BackupCard'

function parseList(text: string): string[] {
  return [...new Set(text.split(',').map((s) => s.trim()).filter(Boolean))]
}

export default function Projects() {
  const { projects, states, reload: reloadPortfolio, error } = usePortfolio()
  const [filter, setFilter] = useState<Health | 'all'>('all')
  const { me } = useTeam()
  const [name, setName] = useState('')
  const [stage, setStage] = useState(1)
  const [rooms, setRooms] = useState('')
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [removed, setRemoved] = useState<Project[]>([])

  // Projects are cached by useProjects; refreshing the cache and the portfolio picks up the change.
  const refresh = useCallback(async () => {
    await refreshProjects().catch(() => undefined)
    window.dispatchEvent(new Event('projects-changed'))
    await reloadPortfolio()
  }, [reloadPortfolio])

  const loadRemoved = useCallback(async () => {
    const { data } = await supabase.from('projects').select(PROJECT_SELECT).eq('archived', true).order('name')
    setRemoved((data ?? []) as Project[])
  }, [])

  useEffect(() => {
    void loadRemoved()
  }, [loadRemoved])

  async function restore(id: string) {
    const { error: err } = await supabase.from('projects').update({ archived: false }).eq('id', id)
    if (err) {
      setFormError(navigator.onLine ? err.message : 'No signal. Restoring a project needs a connection.')
      return
    }
    await Promise.all([refresh(), loadRemoved()])
  }

  async function add(e: FormEvent) {
    e.preventDefault()
    if (name.trim() === '') return
    const clash = [...projects, ...removed].find((p) => p.name.trim().toLowerCase() === name.trim().toLowerCase())
    if (clash) {
      setFormError(
        clash.archived
          ? `A removed project is already called ${clash.name}. Restore it below instead.`
          : `A project called ${clash.name} already exists.`,
      )
      return
    }
    setBusy(true)
    setFormError(null)
    const { error: err } = await supabase
      .from('projects')
      .insert({ name: name.trim(), stage, rooms: parseList(rooms) })
    setBusy(false)
    if (err) {
      setFormError(navigator.onLine ? err.message : 'No signal. Adding a project needs a connection.')
      return
    }
    setName('')
    setRooms('')
    setStage(1)
    await refresh()
  }

  return (
    <main className="screen">
      <header className="topbar">
        <h1>Projects</h1>
        <button type="button" className="pill" onClick={() => supabase.auth.signOut()}>
          Sign out
        </button>
      </header>

      {error && <p className="error" role="alert">{error}</p>}

      {states.length > 0 && (
        <div className="chips" role="group" aria-label="Filter projects">
          <button type="button" className={filter === 'all' ? 'chip on' : 'chip'} aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
            All {states.length}
          </button>
          {(['ok', 'risk', 'late', 'none'] as const)
            .filter((h) => states.some((st) => st.health === h))
            .map((h) => (
              <button key={h} type="button" className={filter === h ? 'chip on' : 'chip'} aria-pressed={filter === h} onClick={() => setFilter(h)}>
                {HEALTH_LABEL[h]} {states.filter((st) => st.health === h).length}
              </button>
            ))}
        </div>
      )}

      <ul className="rows">
        {states
          .filter((st) => filter === 'all' || st.health === filter)
          .sort((a, b) => (a.daysLeft ?? 99999) - (b.daysLeft ?? 99999))
          .map((st) => (
            <ProjectCard key={st.project.id} s={st} />
          ))}
      </ul>

      <button type="button" className="secondary" onClick={() => go('/team')}>
        Team workload
      </button>

      <section>
        <h2>Add a project</h2>
        <form onSubmit={add} className="stack">
          <label className="field">
            <span>Name</span>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
          <label className="field">
            <span>Current stage</span>
            <select value={stage} onChange={(e) => setStage(Number(e.target.value))}>
              {STAGES.map((s, i) => (
                <option key={s} value={i + 1}>
                  {i + 1}. {s}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Rooms, separated by commas</span>
            <input type="text" value={rooms} onChange={(e) => setRooms(e.target.value)} placeholder="Living, Kitchen, Bedroom 1" />
          </label>
          {formError && <p className="error" role="alert">{formError}</p>}
          <button type="submit" className="primary" disabled={busy}>
            {busy ? 'Adding' : 'Add project'}
          </button>
        </form>
      </section>

      {removed.length > 0 && (
        <section>
          <h2>Removed projects</h2>
          <ul className="rows">
            {removed.map((p) => (
              <li key={p.id} className="row-line padded">
                <span className="muted">{p.name}</span>
                <button type="button" className="pill" onClick={() => restore(p.id)}>
                  Restore
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {isOwner(me) && <BackupCard />}
    </main>
  )
}
