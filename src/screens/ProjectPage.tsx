import { useEffect, useState } from 'react'
import { cacheGet } from '../db'
import { go } from '../hooks'
import { supabase } from '../supabase'
import { STAGES, type Project } from '../types'
import DrawingList from './DrawingList'
import LogList from './LogList'
import Reports from './Reports'

export default function ProjectPage({ projectId, tab }: { projectId: string; tab: 'logs' | 'drawings' | 'reports' }) {
  const [project, setProject] = useState<Project | null>(null)

  useEffect(() => {
    let live = true
    cacheGet<Project[]>('projects').then((cached) => {
      const found = cached?.find((p) => p.id === projectId)
      if (live && found) setProject(found)
    })
    supabase
      .from('projects')
      .select('id, name, code, stage, rooms, trades, archived')
      .eq('id', projectId)
      .maybeSingle()
      .then(({ data }) => {
        if (live && data) setProject(data as Project)
      })
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
              {project.archived ? ' · removed' : ''}
            </span>
          )}
        </div>
        <button type="button" className="pill" onClick={() => go(`/project/${projectId}/edit`)}>
          Edit
        </button>
      </header>

      <nav className="tabs" aria-label="Project sections">
        <button type="button" aria-current={tab === 'logs' ? 'page' : undefined} className={tab === 'logs' ? 'on' : ''} onClick={() => go(`/project/${projectId}`)}>
          Site logs
        </button>
        <button type="button" aria-current={tab === 'drawings' ? 'page' : undefined} className={tab === 'drawings' ? 'on' : ''} onClick={() => go(`/project/${projectId}/drawings`)}>
          Drawings
        </button>
        <button type="button" aria-current={tab === 'reports' ? 'page' : undefined} className={tab === 'reports' ? 'on' : ''} onClick={() => go(`/project/${projectId}/reports`)}>
          Reports
        </button>
      </nav>

      {tab === 'logs' && <LogList projectId={projectId} />}
      {tab === 'drawings' && <DrawingList projectId={projectId} />}
      {tab === 'reports' && <Reports projectId={projectId} />}
    </main>
  )
}
