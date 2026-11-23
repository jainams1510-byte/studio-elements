import { todayLocal } from '../drawings'
import { go } from '../hooks'
import { teamLoad } from '../portfolio'
import { formatDay } from '../schedule'
import { usePortfolio } from '../usePortfolio'

/** Unfinished tasks by owner, across projects: what is running and what starts in the next four weeks. */
export default function Team() {
  const { states, ready, offline } = usePortfolio()
  const loads = teamLoad(states, todayLocal())

  return (
    <main className="screen">
      <header className="topbar">
        <div>
          <button type="button" className="link back" onClick={() => go('/projects')}>
            Projects
          </button>
          <h1>Team workload</h1>
        </div>
      </header>
      <p className="muted small">Unfinished tasks by owner across all projects: running now or starting within four weeks. Set a task’s owner in its editor.</p>
      {offline && <p className="notice">No signal. Showing the data last seen on this phone.</p>}
      {!ready && <p className="muted">Loading</p>}
      {ready && loads.length === 0 && <p className="muted">No open tasks in the next four weeks.</p>}
      {loads.map((l) => (
        <section key={l.owner} className="stack-tight">
          <h2>
            {l.owner} · {l.open.length} task{l.open.length === 1 ? '' : 's'}
            {l.overdue ? ` · ${l.overdue} overdue` : ''}
          </h2>
          <ul className="rows">
            {l.open.map(({ task, project, end, overdue, critical }) => (
              <li key={task.id} className="row-line padded">
                <span className="stack-tight">
                  <span>{task.name}</span>
                  <span className="muted small">
                    {project}
                    {end ? ` · ends ${formatDay(end)}` : ''}
                    {critical ? ' · critical' : ''}
                  </span>
                </span>
                <span className={overdue ? 'htag late' : task.status === 'in_progress' ? 'tag muted' : 'tag muted'}>
                  {overdue ? 'Overdue' : task.status === 'in_progress' ? 'In progress' : task.status === 'blocked' ? 'Blocked' : 'Planned'}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </main>
  )
}
