import { useEffect, useState } from 'react'
import { cacheGet } from '../db'
import { go } from '../hooks'
import { supabase } from '../supabase'
import { STAGES, type Project } from '../types'
import DrawingList from './DrawingList'
import LogList from './LogList'
import Reports from './Reports'
import ScheduleTab from './ScheduleTab'
import DecisionsTab from './decisions/DecisionsTab'
import ProcurementTab from './decisions/ProcurementTab'
import DeckTab from './deck/DeckTab'
import ReviewTab from './deck/ReviewTab'
import FeesTab from './fees/FeesTab'
import MoneyTab from './money/MoneyTab'
import { isOwner, useTeam } from '../team'

export const PROJECT_TABS = [
  ['logs', 'Site logs'],
  ['drawings', 'Drawings'],
  ['schedule', 'Schedule'],
  ['money', 'Money'],
  ['fees', 'Fees'],
  ['decisions', 'Decisions'],
  ['procurement', 'Procurement'],
  ['deck', 'Deck'],
  ['reports', 'Reports'],
  ['review', 'Review'],
] as const
export type ProjectTab = (typeof PROJECT_TABS)[number][0]

export default function ProjectPage({ projectId, tab }: { projectId: string; tab: ProjectTab }) {
  const { me } = useTeam()
  const owner = isOwner(me)
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

      <nav className="tabs scroll-tabs" aria-label="Project sections">
        {PROJECT_TABS.filter(([id]) => id !== 'fees' || owner).map(([id, label]) => (
          <button
            key={id}
            type="button"
            aria-current={tab === id ? 'page' : undefined}
            className={tab === id ? 'on' : ''}
            ref={(el) => {
              if (el && tab === id) el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
            }}
            onClick={() => go(id === 'logs' ? `/project/${projectId}` : `/project/${projectId}/${id}`)}
          >
            {label}
          </button>
        ))}
      </nav>

      {tab === 'logs' && <LogList projectId={projectId} />}
      {tab === 'drawings' && <DrawingList projectId={projectId} />}
      {tab === 'schedule' && <ScheduleTab projectId={projectId} project={project} />}
      {tab === 'money' && <MoneyTab projectId={projectId} />}
      {tab === 'fees' && (owner ? <FeesTab projectId={projectId} /> : <p className="muted">Fees are visible to owners only.</p>)}
      {tab === 'decisions' && <DecisionsTab projectId={projectId} />}
      {tab === 'procurement' && <ProcurementTab projectId={projectId} />}
      {tab === 'deck' && <DeckTab projectId={projectId} />}
      {tab === 'reports' && <Reports projectId={projectId} />}
      {tab === 'review' && <ReviewTab projectId={projectId} />}
    </main>
  )
}
