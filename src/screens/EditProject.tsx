import { useEffect, useState, type FormEvent } from 'react'
import { cacheGet } from '../db'
import { go, PROJECT_SELECT, refreshProjects } from '../hooks'
import { supabase } from '../supabase'
import { STAGES, type Project } from '../types'

function parseList(text: string): string[] {
  return [...new Set(text.split(',').map((s) => s.trim()).filter(Boolean))]
}

export default function EditProject({ projectId }: { projectId: string }) {
  const [project, setProject] = useState<Project | null>(null)
  const [name, setName] = useState('')
  const [stage, setStage] = useState(1)
  const [rooms, setRooms] = useState('')
  const [trades, setTrades] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState(false)

  useEffect(() => {
    let live = true
    const fill = (p: Project) => {
      setProject(p)
      setName(p.name)
      setStage(p.stage)
      setRooms(p.rooms.join(', '))
      setTrades(p.trades.join(', '))
    }
    cacheGet<Project[]>('projects').then((cached) => {
      const found = cached?.find((p) => p.id === projectId)
      if (live && found) fill(found)
    })
    supabase
      .from('projects')
      .select(PROJECT_SELECT)
      .eq('id', projectId)
      .maybeSingle()
      .then(({ data }) => {
        if (live && data) fill(data as Project)
      })
    return () => {
      live = false
    }
  }, [projectId])

  async function save(e: FormEvent) {
    e.preventDefault()
    if (name.trim() === '') return
    setBusy(true)
    setError(null)
    const { error: err } = await supabase
      .from('projects')
      .update({ name: name.trim(), stage, rooms: parseList(rooms), trades: parseList(trades) })
      .eq('id', projectId)
    if (err) {
      setBusy(false)
      setError(navigator.onLine ? err.message : 'No signal. Editing a project needs a connection.')
      return
    }
    await refreshProjects().catch(() => undefined)
    setBusy(false)
    go(`/project/${projectId}`)
  }

  async function remove() {
    setBusy(true)
    setError(null)
    const { error: err } = await supabase.from('projects').update({ archived: true }).eq('id', projectId)
    if (err) {
      setBusy(false)
      setError(navigator.onLine ? err.message : 'No signal. Removing a project needs a connection.')
      return
    }
    await refreshProjects().catch(() => undefined)
    setBusy(false)
    go('/projects')
  }

  return (
    <main className="screen">
      <header className="topbar">
        <div>
          <button type="button" className="link back" onClick={() => go(`/project/${projectId}`)}>
            {project?.name ?? 'Project'}
          </button>
          <h1>Edit project</h1>
        </div>
      </header>

      <form onSubmit={save} className="stack">
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
        <label className="field">
          <span>Trades, separated by commas</span>
          <input type="text" value={trades} onChange={(e) => setTrades(e.target.value)} />
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Saving' : 'Save changes'}
        </button>
      </form>

      <section className="stack">
        <h2>Remove</h2>
        {!confirmRemove ? (
          <button type="button" className="danger-outline" onClick={() => setConfirmRemove(true)} disabled={busy}>
            Remove this project
          </button>
        ) : (
          <div className="card stack">
            <p>
              Remove <strong>{project?.name ?? 'this project'}</strong> from the lists? Its site logs and drawings are kept, and you can restore it
              from Projects.
            </p>
            <div className="button-row">
              <button type="button" className="danger" onClick={remove} disabled={busy}>
                {busy ? 'Removing' : 'Remove'}
              </button>
              <button type="button" className="secondary" onClick={() => setConfirmRemove(false)} disabled={busy}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </section>
    </main>
  )
}
