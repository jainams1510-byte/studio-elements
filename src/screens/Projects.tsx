import { useState, type FormEvent } from 'react'
import { go, useProjects } from '../hooks'
import { supabase } from '../supabase'
import { STAGES } from '../types'

function parseList(text: string): string[] {
  return [...new Set(text.split(',').map((s) => s.trim()).filter(Boolean))]
}

export default function Projects() {
  const { projects, reload, error } = useProjects()
  const [name, setName] = useState('')
  const [stage, setStage] = useState(1)
  const [rooms, setRooms] = useState('')
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  async function add(e: FormEvent) {
    e.preventDefault()
    if (name.trim() === '') return
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
    await reload()
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

      <ul className="rows">
        {projects.map((p) => (
          <li key={p.id}>
            <button type="button" className="row" onClick={() => go(`/project/${p.id}`)}>
              <span className="row-title">{p.name}</span>
              <span className="muted small">
                Stage {p.stage} of 8 · {STAGES[p.stage - 1]}
                {p.rooms.length ? ` · ${p.rooms.length} rooms` : ''}
              </span>
            </button>
          </li>
        ))}
      </ul>

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
    </main>
  )
}
