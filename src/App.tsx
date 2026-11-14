import type { Session } from '@supabase/supabase-js'
import { useEffect, useState } from 'react'
import { go, useAutoSync, useHashRoute, useOnline, useOutboxCount } from './hooks'
import NewLog from './screens/NewLog'
import ProjectLogs from './screens/ProjectLogs'
import Projects from './screens/Projects'
import SignIn from './screens/SignIn'
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

  let screen
  if (route === '/log') screen = <NewLog outbox={outbox} />
  else if (route === '/projects') screen = <Projects />
  else if (route.startsWith('/project/')) screen = <ProjectLogs projectId={route.slice('/project/'.length)} />
  else screen = <Today outbox={outbox} online={online} />

  const onLog = route === '/log'
  return (
    <div className="app">
      {screen}
      {!onLog && (
        <nav className="tabbar" aria-label="Main">
          <button type="button" className={route === '/' ? 'tab active' : 'tab'} onClick={() => go('/')}>
            Today
          </button>
          <button type="button" className="fab" aria-label="New site log" onClick={() => go('/log')}>
            <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M12 5v14" />
              <path d="M5 12h14" />
            </svg>
          </button>
          <button
            type="button"
            className={route === '/projects' || route.startsWith('/project/') ? 'tab active' : 'tab'}
            onClick={() => go('/projects')}
          >
            Projects
          </button>
        </nav>
      )}
    </div>
  )
}
