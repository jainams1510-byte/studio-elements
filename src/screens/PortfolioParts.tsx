import { go } from '../hooks'
import { HEALTH_LABEL, type Health, type ProjectState } from '../portfolio'
import { formatDay } from '../schedule'
import { STAGES } from '../types'

export function HealthTag({ health }: { health: Health }) {
  return <span className={`htag ${health}`}>{HEALTH_LABEL[health]}</span>
}

/** Done so far as a bar; the tick marks where the baseline says it should be today. */
export function ProgressBar({ progress, plan }: { progress: number | null; plan: number | null }) {
  if (progress === null) return null
  return (
    <span className="pbar" role="img" aria-label={`${progress}% done${plan !== null ? `, plan ${plan}%` : ''}`}>
      <i style={{ width: `${progress}%` }} />
      {plan !== null && <u style={{ left: `${plan}%` }} />}
    </span>
  )
}

export function ProjectCard({ s }: { s: ProjectState }) {
  const p = s.project
  return (
    <li>
      <button type="button" className="row pcard" onClick={() => go(`/project/${p.id}${s.health === 'none' ? '' : '/schedule'}`)}>
        <span className="row-line">
          <span className="row-title">{p.name}</span>
          <HealthTag health={s.health} />
        </span>
        {s.progress !== null ? (
          <ProgressBar progress={s.progress} plan={s.plan} />
        ) : (
          <span className="stagebar" aria-hidden="true">
            {STAGES.map((_, i) => (
              <span key={i} className={i + 1 < p.stage ? 'done' : i + 1 === p.stage ? 'now' : ''} />
            ))}
          </span>
        )}
        <span className="pstats">
          <span>
            <b>{s.progress !== null ? `${s.progress}%` : `${p.stage}/8`}</b>
            {s.progress !== null ? (s.plan !== null ? `done · plan ${s.plan}%` : 'done') : 'stage'}
          </span>
          <span>
            <b>{s.daysLeft !== null ? `${s.daysLeft} d` : '—'}</b>
            {s.finish ? `to ${formatDay(s.finish)}` : 'no finish date'}
          </span>
          <span>
            <b>{s.overdue.length}</b>overdue
          </span>
        </span>
        <span className="muted small">
          {s.reasons.length
            ? s.reasons.join(' · ')
            : s.nextMilestone
              ? `Next: ${s.nextMilestone.task.name}, ${formatDay(s.nextMilestone.end)}`
              : `Stage ${p.stage} · ${STAGES[p.stage - 1]}`}
        </span>
      </button>
    </li>
  )
}

const DOT: Record<Health, string> = { ok: '#2F5D46', risk: '#A97C1D', late: '#8A2B1D', none: '#8E8A82' }

/** Each project's forecast handover on one line. Scales to the screen; labels alternate above and below. */
export function HandoverChart({ states, today }: { states: ProjectState[]; today: string }) {
  const dated = states.filter((s) => s.finish).sort((a, b) => a.finish!.localeCompare(b.finish!))
  if (dated.length === 0) return null
  const W = 340
  const H = 112
  const pad = 22
  const start = new Date(`${today}T00:00:00Z`).getTime()
  const lastFinish = new Date(`${dated[dated.length - 1].finish}T00:00:00Z`).getTime()
  const span = Math.max(30 * 86_400_000, lastFinish - start)
  const x = (iso: string) => pad + ((new Date(`${iso}T00:00:00Z`).getTime() - start) / span) * (W - pad * 2)
  // Month ticks
  const ticks: { x: number; label: string }[] = []
  const d = new Date(start)
  d.setUTCDate(1)
  d.setUTCMonth(d.getUTCMonth() + 1)
  while (d.getTime() <= start + span) {
    const iso = d.toISOString().slice(0, 10)
    // Leave room for the "Today" label at the left end.
    if (x(iso) > pad + 40) ticks.push({ x: x(iso), label: d.toLocaleDateString('en-IN', { month: 'short', timeZone: 'UTC' }) })
    d.setUTCMonth(d.getUTCMonth() + (span > 300 * 86_400_000 ? 2 : 1))
  }
  return (
    <svg className="handover" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Forecast handovers: ${dated.map((s) => `${s.project.name} ${formatDay(s.finish)}`).join(', ')}`}>
      <line x1={pad} x2={W - pad} y1={56} y2={56} stroke="#D9D6CF" />
      {ticks.map((t) => (
        <g key={t.x}>
          <line x1={t.x} x2={t.x} y1={52} y2={60} stroke="#D9D6CF" />
          <text x={t.x} y={106} textAnchor="middle" fontSize={10} fill="#5F5C56">
            {t.label}
          </text>
        </g>
      ))}
      <line x1={pad} x2={pad} y1={50} y2={62} stroke="#2F5D46" strokeWidth={2} />
      <text x={pad - 4} y={106} textAnchor="start" fontSize={10} fill="#2F5D46" fontWeight={600}>
        Today
      </text>
      {dated.map((s, i) => {
        const cx = Math.min(W - pad, Math.max(pad, x(s.finish!)))
        const up = i % 2 === 0
        const label = s.project.name.length > 16 ? `${s.project.name.slice(0, 15)}…` : s.project.name
        return (
          <g key={s.project.id}>
            <circle cx={cx} cy={56} r={6} fill={DOT[s.health]} />
            <text x={cx} y={up ? 38 : 82} textAnchor={cx < 60 ? 'start' : cx > W - 60 ? 'end' : 'middle'} fontSize={11} fill="#2B2B29">
              {label}
            </text>
            <text x={cx} y={up ? 24 : 95} textAnchor={cx < 60 ? 'start' : cx > W - 60 ? 'end' : 'middle'} fontSize={10} fill="#5F5C56">
              {formatDay(s.finish)}
            </text>
          </g>
        )
      })}
    </svg>
  )
}
