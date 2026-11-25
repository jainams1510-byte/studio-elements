import { go } from '../hooks'
import { isOwner, useTeam } from '../team'
import { APP_VERSION, BUILD_TIME, applyUpdate } from '../update'
import BackupCard from './BackupCard'

type Entry = { path: string; title: string; text: string; owner?: boolean }

const ENTRIES: Entry[] = [
  { path: '/calendar', title: 'Calendar', text: 'Milestones, orders, visits, bills, fees and decisions by date' },
  { path: '/finances', title: 'Finances', text: 'Receivables, payables, margin by project, cash-flow forecast', owner: true },
  { path: '/vendors', title: 'Vendors', text: 'Agencies, suppliers and consultants: bills due, delivery record' },
  { path: '/team', title: 'Team workload', text: 'Open tasks by owner across projects' },
  { path: '/drafts', title: 'Drafts', text: 'Messages ready for you to check and share' },
  { path: '/settings', title: 'Studio settings', text: 'Studio details, logo and the proposal clause library', owner: true },
]

/** The studio-wide screens, in one place. */
export default function Studio() {
  const { me } = useTeam()
  const owner = isOwner(me)
  return (
    <main className="screen">
      <header className="topbar">
        <h1>Studio</h1>
      </header>
      <ul className="rows">
        {ENTRIES.filter((e) => !e.owner || owner).map((e) => (
          <li key={e.path}>
            <button type="button" className="row" onClick={() => go(e.path)}>
              <span className="row-title">{e.title}</span>
              <span className="muted small">{e.text}</span>
            </button>
          </li>
        ))}
      </ul>
      {owner && <BackupCard />}
      <p className="muted small app-version">
        App version {APP_VERSION}, built{' '}
        {new Date(BUILD_TIME).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' })}.{' '}
        <button type="button" className="link" onClick={applyUpdate}>
          Reload to check for updates
        </button>
      </p>
    </main>
  )
}
