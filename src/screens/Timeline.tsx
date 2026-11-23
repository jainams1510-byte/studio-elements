import { useEffect, useMemo, useRef, useState } from 'react'
import { cacheGet } from '../db'
import { todayLocal } from '../drawings'
import { go } from '../hooks'
import { calendarDaysBetween, formatDay, isMilestone, shiftDays, isoWeekday, type Task } from '../schedule'
import { supabase } from '../supabase'
import { isOwner, useTeam } from '../team'
import { STAGES, type Project } from '../types'
import { useSchedule } from '../useSchedule'
import TaskEditor from './TaskEditor'

const ROW = 30
const HEAD = 46
const COLORS = {
  ink: '#2B2B29',
  muted: '#5F5C56',
  line: '#D9D6CF',
  soft: '#EAE7E0',
  accent: '#2F5D46',
  done: '#B9B5AC',
}

type Line = { kind: 'stage'; stage: number } | { kind: 'task'; task: Task }

export default function Timeline({ projectId }: { projectId: string }) {
  const [project, setProject] = useState<Project | null>(null)
  const data = useSchedule(projectId)
  const { me } = useTeam()
  const [selected, setSelected] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [zoom, setZoom] = useState(() => (window.innerWidth < 700 ? 6 : 14))
  const [viewW, setViewW] = useState(() => window.innerWidth)
  const wide = viewW >= 900
  const phone = viewW < 700
  const NAME_W = phone ? 128 : 300
  const chartRef = useRef<HTMLDivElement>(null)
  const scrolledFor = useRef<string | null>(null)

  useEffect(() => {
    const onResize = () => setViewW(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

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
      .then(({ data: row }) => {
        if (live && row) setProject(row as Project)
      })
    return () => {
      live = false
    }
  }, [projectId])

  const today = todayLocal()
  const { tasks, result, settings, calendar } = data
  const planned = useMemo(() => result?.tasks ?? {}, [result])

  // Open the chart at today (a little before it), once per zoom level.
  const ready = Boolean(settings && calendar && result)
  useEffect(() => {
    const el = chartRef.current
    const key = `${zoom}`
    if (!el || !ready || scrolledFor.current === key) return
    const marker = el.querySelector<SVGLineElement>('line[data-today]')
    if (marker) {
      el.scrollLeft = Math.max(0, Number(marker.getAttribute('x1')) - el.clientWidth / 4)
      scrolledFor.current = key
    }
  })

  const lines: Line[] = useMemo(() => {
    const live = tasks.filter((t) => !t.removed_at && planned[t.id])
    const out: Line[] = []
    for (const stage of [...new Set(live.map((t) => t.stage))].sort((a, b) => a - b)) {
      out.push({ kind: 'stage', stage })
      live
        .filter((t) => t.stage === stage)
        .sort((a, b) => planned[a.id].es - planned[b.id].es || a.sort_order - b.sort_order)
        .forEach((task) => out.push({ kind: 'task', task }))
    }
    return out
  }, [tasks, planned])

  if (data.state === 'loading') return <main className="screen"><p className="muted">Loading</p></main>
  if (!settings || !calendar || !result) {
    return (
      <main className="screen">
        <BackBar projectId={projectId} name={project?.name} />
        <p className="muted">No schedule yet. Set it up in the Schedule tab.</p>
      </main>
    )
  }

  // Date range: a few days either side of everything shown.
  const dates = Object.values(planned).flatMap((p) => [p.start, p.end])
  for (const t of tasks) if (!t.removed_at && t.baseline_start && t.baseline_end) dates.push(t.baseline_start, t.baseline_end)
  dates.push(settings.start_date, today)
  const first = shiftDays(dates.reduce((a, b) => (a < b ? a : b)), -3)
  const last = shiftDays(dates.reduce((a, b) => (a > b ? a : b)), 7)
  // Begin on a Monday so the week grid lines up.
  const rangeStart = shiftDays(first, -(isoWeekday(first) - 1))
  const totalDays = calendarDaysBetween(rangeStart, last) + 1
  const width = totalDays * zoom
  const height = HEAD + lines.length * ROW + 8
  const x = (iso: string) => calendarDaysBetween(rangeStart, iso) * zoom
  const rowOf = new Map<string, number>()
  lines.forEach((l, i) => {
    if (l.kind === 'task') rowOf.set(l.task.id, i)
  })
  const yOf = (i: number) => HEAD + i * ROW

  const sel = selected ? tasks.find((t) => t.id === selected) ?? null : null
  const selPreds = sel ? sel.after_ids.filter((id) => rowOf.has(id)) : []
  const selSuccs = sel ? tasks.filter((t) => !t.removed_at && t.after_ids.includes(sel.id) && rowOf.has(t.id)).map((t) => t.id) : []

  // Month labels and Monday ticks.
  const months: { x: number; label: string }[] = []
  const mondays: { x: number; label: string }[] = []
  const offDays: number[] = []
  for (let i = 0; i < totalDays; i++) {
    const d = shiftDays(rangeStart, i)
    if (d.endsWith('-01') || i === 0) {
      months.push({ x: i * zoom, label: new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' }) })
    }
    if (isoWeekday(d) === 1) mondays.push({ x: i * zoom, label: String(Number(d.slice(8))) })
    if (!calendar.isWorkDay(d)) offDays.push(i * zoom)
  }

  const barEnd = (iso: string) => x(iso) + zoom // a bar covers its whole last day
  const anchorOut = (id: string) => {
    const p = planned[id]
    const t = tasks.find((k) => k.id === id)!
    return { x: isMilestone(t) ? x(p.end) + zoom / 2 + 6 : barEnd(p.end), y: yOf(rowOf.get(id)!) + ROW / 2 }
  }
  const anchorIn = (id: string) => {
    const p = planned[id]
    const t = tasks.find((k) => k.id === id)!
    return { x: isMilestone(t) ? x(p.end) + zoom / 2 - 6 : x(p.start), y: yOf(rowOf.get(id)!) + ROW / 2 }
  }
  const arrow = (from: string, to: string, key: string) => {
    const a = anchorOut(from)
    const b = anchorIn(to)
    const midX = Math.max(a.x + 6, Math.min(b.x - 6, a.x + 12))
    return <path key={key} d={`M${a.x},${a.y} H${midX} V${b.y} H${b.x - 1}`} fill="none" stroke={COLORS.ink} strokeWidth={1.25} markerEnd="url(#arrowhead)" />
  }

  return (
    <main className="screen timeline-screen">
      <BackBar projectId={projectId} name={project?.name} />
      <div className="timeline-tools">
        <span className="small">
          Forecast finish <strong>{formatDay(result.finish)}</strong>
          {result.baselineFinish && (
            <>
              {' '}· baseline <strong>{formatDay(result.baselineFinish)}</strong>
              {result.slip ? <strong className={result.slip > 0 ? 'late' : ''}> {result.slip > 0 ? `+${result.slip}` : result.slip}d</strong> : ' on time'}
            </>
          )}
        </span>
        <span className="legend small" aria-hidden="true">
          <span><i className="lg crit" />Critical</span>
          <span><i className="lg norm" />Other</span>
          <span><i className="lg float" />Spare days</span>
          <span><i className="lg base" />Baseline</span>
          <span><i className="lg ms" />Milestone</span>
        </span>
        <span className="zoom">
          <button type="button" className={zoom === 6 ? 'chip on' : 'chip'} onClick={() => setZoom(6)}>Months</button>
          <button type="button" className={zoom === 14 ? 'chip on' : 'chip'} onClick={() => setZoom(14)}>Weeks</button>
          <button type="button" className={zoom === 28 ? 'chip on' : 'chip'} onClick={() => setZoom(28)}>Days</button>
        </span>
      </div>
      {phone && <p className="muted small">Swipe the chart sideways. Tap a task for its dates and links.</p>}

      <div className={editing && sel && wide ? 'timeline-layout with-panel' : 'timeline-layout'}>
        <div className="gantt" role="region" aria-label="Timeline" tabIndex={0}>
          <div className="gantt-names" style={{ width: NAME_W, height }}>
            <div className="gantt-head" style={{ height: HEAD }}>
              <span>Task</span>
              <span>After</span>
            </div>
            {lines.map((l, i) =>
              l.kind === 'stage' ? (
                <div key={`s${l.stage}`} className="gantt-stage" style={{ top: yOf(i), height: ROW }}>
                  {l.stage}. {STAGES[l.stage - 1]}
                </div>
              ) : (
                <button
                  key={l.task.id}
                  type="button"
                  className={`gantt-name${selected === l.task.id ? ' on' : ''}${planned[l.task.id].critical ? ' crit' : ''}`}
                  style={{ top: yOf(i), height: ROW }}
                  onClick={() => {
                    setSelected(selected === l.task.id ? null : l.task.id)
                    setEditing(false)
                  }}
                  aria-pressed={selected === l.task.id}
                >
                  <span className="nm">{l.task.name}</span>
                  <span className="af">{l.task.after_ids.filter((id) => rowOf.has(id)).length || ''}</span>
                </button>
              ),
            )}
          </div>
          <div className="gantt-chart" ref={chartRef}>
            <svg width={width} height={height} role="img" aria-label="Bars for each task">
              <defs>
                <marker id="arrowhead" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                  <path d="M0,0 L8,4 L0,8 z" fill={COLORS.ink} />
                </marker>
              </defs>
              {offDays.map((ox) => (
                <rect key={`o${ox}`} x={ox} y={HEAD} width={zoom} height={height - HEAD} fill={COLORS.soft} opacity={0.6} />
              ))}
              {lines.map((l, i) =>
                l.kind === 'stage' ? <rect key={`sb${i}`} x={0} y={yOf(i)} width={width} height={ROW} fill="#F0EDE6" /> : null,
              )}
              {sel && rowOf.has(sel.id) && <rect x={0} y={yOf(rowOf.get(sel.id)!)} width={width} height={ROW} fill="#E3EBE6" />}
              {mondays.map((m) => (
                <g key={`m${m.x}`}>
                  <line x1={m.x} x2={m.x} y1={24} y2={height} stroke={COLORS.line} strokeWidth={1} />
                  {zoom >= 14 && (
                    <text x={m.x + 3} y={40} fontSize={11} fill={COLORS.muted}>
                      {m.label}
                    </text>
                  )}
                </g>
              ))}
              {months.map((m) => (
                <text key={`mo${m.x}`} x={m.x + 3} y={16} fontSize={12} fontWeight={600} fill={COLORS.ink}>
                  {m.label}
                </text>
              ))}
              <line x1={0} x2={width} y1={HEAD - 0.5} y2={HEAD - 0.5} stroke={COLORS.line} />

              {lines.map((l, i) => {
                if (l.kind !== 'task') return null
                const t = l.task
                const p = planned[t.id]
                const y = yOf(i)
                const fill = t.status === 'done' ? COLORS.done : p.critical ? COLORS.accent : COLORS.muted
                const ms = isMilestone(t)
                return (
                  <g key={t.id} onClick={() => { setSelected(t.id); setEditing(false) }} style={{ cursor: 'pointer' }}>
                    <title>
                      {`${t.name}: ${ms ? formatDay(p.end) : `${formatDay(p.start)} – ${formatDay(p.end)}`}${p.critical ? ', critical' : p.float > 0 && t.status !== 'done' ? `, ${p.float} spare working days` : ''}`}
                    </title>
                    {t.baseline_end && t.baseline_start && (
                      <line x1={x(t.baseline_start)} x2={barEnd(t.baseline_end)} y1={y + ROW - 5} y2={y + ROW - 5} stroke={COLORS.ink} strokeWidth={1.5} />
                    )}
                    {!ms && t.status !== 'done' && p.float > 0 && (
                      <rect
                        x={barEnd(p.end)}
                        y={y + 8}
                        width={Math.max(0, barEnd(calendar.dateOf(p.ef + p.float - 1)) - barEnd(p.end))}
                        height={ROW - 18}
                        fill="none"
                        stroke={COLORS.muted}
                        strokeWidth={1}
                        rx={2}
                      />
                    )}
                    {ms ? (
                      <rect
                        x={x(p.end) + zoom / 2 - 6}
                        y={y + ROW / 2 - 6}
                        width={12}
                        height={12}
                        transform={`rotate(45 ${x(p.end) + zoom / 2} ${y + ROW / 2})`}
                        fill={t.status === 'done' ? COLORS.done : p.critical ? COLORS.accent : COLORS.ink}
                      />
                    ) : (
                      <rect x={x(p.start)} y={y + 8} width={Math.max(2, barEnd(p.end) - x(p.start))} height={ROW - 18} fill={fill} rx={2} />
                    )}
                  </g>
                )
              })}

              {sel && selPreds.map((id) => arrow(id, sel.id, `in${id}`))}
              {sel && selSuccs.map((id) => arrow(sel.id, id, `out${id}`))}

              <line data-today="" x1={x(today) + zoom / 2} x2={x(today) + zoom / 2} y1={HEAD} y2={height} stroke={COLORS.accent} strokeWidth={1.5} strokeDasharray="4 3" />
              <text x={x(today) + zoom / 2 + 4} y={HEAD + 12} fontSize={11} fontWeight={600} fill={COLORS.accent}>
                Today
              </text>
            </svg>
          </div>
        </div>

        {sel && !editing && (
          <div className="timeline-detail card">
            <div className="card-head">
              <strong>{sel.name}</strong>
              <span className="muted small">{planned[sel.id]?.critical ? 'Critical' : planned[sel.id] ? `${planned[sel.id].float}d spare` : ''}</span>
            </div>
            <p className="small">
              {planned[sel.id] && (isMilestone(sel) ? formatDay(planned[sel.id].end) : `${formatDay(planned[sel.id].start)} – ${formatDay(planned[sel.id].end)}, ${sel.duration} working days`)}
              {sel.baseline_end ? ` · baseline end ${formatDay(sel.baseline_end)}` : ''}
            </p>
            <p className="small muted">
              After: {sel.after_ids.map((id) => tasks.find((t) => t.id === id)?.name).filter(Boolean).join(', ') || 'nothing (starts at the schedule start)'}
            </p>
            {wide && data.state === 'ready' && (
              <button type="button" className="secondary" onClick={() => setEditing(true)}>
                Edit task
              </button>
            )}
            {!wide && (
              <button type="button" className="secondary" onClick={() => go(`/project/${projectId}/schedule`)}>
                Edit in the Schedule tab
              </button>
            )}
          </div>
        )}
        {sel && editing && wide && project && (
          <div className="timeline-panel">
            <TaskEditor
              projectId={projectId}
              task={sel}
              tasks={tasks}
              planned={planned}
              drawings={data.drawings}
              trades={project.trades}
              rooms={project.rooms}
              frozen={Boolean(settings.baseline_at)}
              owner={isOwner(me)}
              defaultStage={sel.stage}
              onDone={() => {
                setEditing(false)
                void data.reload()
              }}
              onCancel={() => setEditing(false)}
            />
          </div>
        )}
      </div>
    </main>
  )
}

function BackBar({ projectId, name }: { projectId: string; name: string | undefined }) {
  return (
    <header className="topbar">
      <div>
        <button type="button" className="link back" onClick={() => go(`/project/${projectId}/schedule`)}>
          {name ?? 'Project'} · Schedule
        </button>
        <h1>Timeline</h1>
      </div>
    </header>
  )
}
