import type { Session } from '@supabase/supabase-js'
import { useEffect, useState } from 'react'
import { go, useAutoSync, useHashRoute, useOnline, useOutboxCount } from './hooks'
import NewLog from './screens/NewLog'
import DrawingDetail from './screens/DrawingDetail'
import Drafts from './screens/Drafts'
import EditProject from './screens/EditProject'
import ProjectPage, { PROJECT_TABS, type ProjectTab } from './screens/ProjectPage'
import Studio from './screens/Studio'
import Calendar from './screens/decisions/Calendar'
import StudioSettings from './screens/deck/StudioSettings'
import Finances from './screens/fees/Finances'
import Vendors from './screens/fees/Vendors'
import Projects from './screens/Projects'
import Review from './screens/Review'
import Timeline from './screens/Timeline'
import SignIn from './screens/SignIn'
import Team from './screens/Team'
import Today from './screens/Today'
import { supabase } from './supabase'

const LAST_USER = 'studio.lastUser'

export default function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined)
  const route = useHashRoute()
  const online = useOnline()
  const outbox = useOutboxCount()

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data: sub } = supabase.auth.onAuthStateChange((event, next) => {
      setSession(next)
      if (next) localStorage.setItem(LAST_USER, next.user.id)
      if (event === 'SIGNED_OUT') localStorage.removeItem(LAST_USER)
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  useAutoSync(Boolean(session))

  if (session === undefined) return <div className="center muted">Opening</div>

  // On site with no signal, a sign-in that has timed out must not block a log.
  // Someone who has signed in on this phone before can still capture; the log
  // uploads after they are online and signed in again.
  const captureOnly = !session && !online && localStorage.getItem(LAST_USER) !== null
  if (!session && !captureOnly) return <SignIn />

  if (captureOnly) {
    return (
      <div className="app">
        <NewLog offlineOnly outbox={outbox} />
      </div>
    )
  }

  // Routes: /log, /projects, /project/:id(/drawings|/schedule|/reports|/timeline|/edit), /drawing/:id, /review
  const [section, id, sub] = route.split('/').filter(Boolean)
  let screen
  if (section === 'log') screen = <NewLog outbox={outbox} />
  else if (section === 'projects') screen = <Projects />
  else if (section === 'project' && id && sub === 'edit') screen = <EditProject key={id} projectId={id} />
  else if (section === 'project' && id && sub === 'timeline') screen = <Timeline key={id} projectId={id} />
  else if (section === 'project' && id) {
    const tab: ProjectTab = PROJECT_TABS.some(([t]) => t === sub) ? (sub as ProjectTab) : 'logs'
    screen = <ProjectPage key={id} projectId={id} tab={tab} />
  }
  else if (section === 'drawing' && id) screen = <DrawingDetail key={id} drawingId={id} />
  else if (section === 'review') screen = <Review />
  else if (section === 'drafts') screen = <Drafts />
  else if (section === 'team') screen = <Team />
  else if (section === 'studio') screen = <Studio />
  else if (section === 'finances') screen = <Finances />
  else if (section === 'vendors') screen = <Vendors />
  else if (section === 'calendar') screen = <Calendar />
  else if (section === 'settings') screen = <StudioSettings />
  else screen = <Today outbox={outbox} online={online} />

  const onLog = section === 'log'
  const wide = (section === 'project' && sub === 'timeline') || section === 'calendar'
  return (
    <div className={wide ? 'app wide' : 'app'}>
      {screen}
      {!onLog && (
        <nav className="tabbar" aria-label="Main">
          <button type="button" className={route === '/' || section === 'drafts' ? 'tab active' : 'tab'} onClick={() => go('/')}>
            Today
          </button>
          <button type="button" className={section === 'review' ? 'tab active' : 'tab'} onClick={() => go('/review')}>
            Review
          </button>
          <button type="button" className="fab" aria-label="New site log" onClick={() => go('/log')}>
            <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M12 5v14" />
              <path d="M5 12h14" />
            </svg>
          </button>
          <button
            type="button"
            className={section === 'projects' || section === 'project' || section === 'drawing' ? 'tab active' : 'tab'}
            onClick={() => go('/projects')}
          >
            Projects
          </button>
          <button
            type="button"
            className={['studio', 'finances', 'vendors', 'calendar', 'settings', 'team'].includes(section ?? '') ? 'tab active' : 'tab'}
            onClick={() => go('/studio')}
          >
            Studio
          </button>
        </nav>
      )}
    </div>
  )
}
