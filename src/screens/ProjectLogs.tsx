import { useEffect, useState } from 'react'
import { cacheGet } from '../db'
import { go } from '../hooks'
import { MEDIA_BUCKET, supabase } from '../supabase'
import { STAGES, type Project } from '../types'

type Log = {
  id: string
  note: string
  room: string | null
  trade: string | null
  audio_path: string | null
  logged_at: string
  profiles: { full_name: string } | null
  site_log_photos: { id: string; path: string }[]
}

const timeFormat = new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })

export default function ProjectLogs({ projectId }: { projectId: string }) {
  const [project, setProject] = useState<Project | null>(null)
  const [logs, setLogs] = useState<Log[]>([])
  const [urls, setUrls] = useState<Record<string, string>>({})
  const [state, setState] = useState<'loading' | 'ready' | 'offline'>('loading')

  useEffect(() => {
    cacheGet<Project[]>('projects').then((cached) => {
      setProject(cached?.find((p) => p.id === projectId) ?? null)
    })
  }, [projectId])

  useEffect(() => {
    let live = true
    async function load() {
      const { data, error } = await supabase
        .from('site_logs')
        .select('id, note, room, trade, audio_path, logged_at, profiles(full_name), site_log_photos(id, path)')
        .eq('project_id', projectId)
        .order('logged_at', { ascending: false })
        .limit(50)
      if (!live) return
      if (error) {
        setState('offline')
        return
      }
      const list = (data ?? []) as unknown as Log[]
      setLogs(list)
      setState('ready')

      // Photos and audio are private: ask for links that work for one hour.
      const paths = list.flatMap((l) => [
        ...l.site_log_photos.map((p) => p.path),
        ...(l.audio_path ? [l.audio_path] : []),
      ])
      if (paths.length === 0) return
      const { data: signed } = await supabase.storage.from(MEDIA_BUCKET).createSignedUrls(paths, 3600)
      if (!live || !signed) return
      const map: Record<string, string> = {}
      for (const s of signed) if (s.path && s.signedUrl) map[s.path] = s.signedUrl
      setUrls(map)
    }
    void load()
    return () => {
      live = false
    }
  }, [projectId])

  return (
    <main className="screen">
      <header className="topbar">
        <div>
          <button type="button" className="link back" onClick={() => go('/projects')}>
            Projects
          </button>
          <h1>{project?.name ?? 'Project'}</h1>
          {project && (
            <span className="muted small">
              Stage {project.stage} of 8 · {STAGES[project.stage - 1]}
            </span>
          )}
        </div>
      </header>

      <section>
        <h2>Site logs</h2>
        {state === 'loading' && <p className="muted">Loading</p>}
        {state === 'offline' && <p className="notice">Logs cannot be shown without a connection.</p>}
        {state === 'ready' && logs.length === 0 && <p className="muted">Nothing logged on this project yet.</p>}
        <ul className="logs">
          {logs.map((log) => (
            <li key={log.id} className="card">
              <div className="card-head">
                <strong>
                  {[log.room, log.trade].filter(Boolean).join(' · ') || 'Site log'}
                </strong>
                <span className="muted small">{timeFormat.format(new Date(log.logged_at))}</span>
              </div>
              {log.note && <p>{log.note}</p>}
              {log.site_log_photos.length > 0 && (
                <div className="photos">
                  {log.site_log_photos.map((p, i) => (
                    <div key={p.id} className="tile">
                      {urls[p.path] ? <img src={urls[p.path]} alt={`Photo ${i + 1}`} loading="lazy" /> : <span className="muted small">Photo {i + 1}</span>}
                    </div>
                  ))}
                </div>
              )}
              {log.audio_path && urls[log.audio_path] && <audio controls src={urls[log.audio_path]} />}
              {log.profiles?.full_name && <span className="muted small">Logged by {log.profiles.full_name}</span>}
            </li>
          ))}
        </ul>
      </section>
    </main>
  )
}
