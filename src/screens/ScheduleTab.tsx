import { useState, type FormEvent } from 'react'
import { todayLocal } from '../drawings'
import { go } from '../hooks'
import { baselinePlan, formatDay, isMilestone, statusLabel, WEEKDAYS, type Task } from '../schedule'
import { supabase } from '../supabase'
import { isOwner, useTeam } from '../team'
import { templateRows } from '../templates'
import { STAGES, type Project } from '../types'
import { MILESTONE_SLIP_DAYS, useSchedule } from '../useSchedule'
import TaskEditor from './TaskEditor'

const MON_SAT = [1, 2, 3, 4, 5, 6]

export default function ScheduleTab({ projectId, project }: { projectId: string; project: Project | null }) {
  const data = useSchedule(projectId)
  const { me, names } = useTeam()
  const owner = isOwner(me)
  const [editing, setEditing] = useState<string | 'new' | null>(null)
  const [newStage, setNewStage] = useState(project?.stage ?? 1)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!project) return <p className="muted">Loading</p>
  if (data.state === 'loading') return <p className="muted">Loading</p>

  if (!data.settings) {
    if (data.state === 'offline') return <p className="notice">No signal. The schedule has not been opened on this phone yet.</p>
    return <ScheduleSetup project={project} onDone={data.reload} />
  }

  const { settings, tasks, result, gateFlags } = data
  const frozen = Boolean(settings.baseline_at)
  const offline = data.state === 'offline'
  const live = tasks.filter((t) => !t.removed_at)
  const removed = tasks.filter((t) => t.removed_at)
  const planned = result?.tasks ?? {}
  // Flags are for things to act on: each slipped task already carries its own tag in the list.
  const lateMilestone = (t: Task) => isMilestone(t) && t.status !== 'done' && (planned[t.id]?.slip ?? 0) > MILESTONE_SLIP_DAYS
  const flagged = live.filter((t) => planned[t.id]?.overdue || gateFlags[t.id] || t.status === 'blocked' || lateMilestone(t))

  async function quickStatus(t: Task, status: 'in_progress' | 'done') {
    setBusy(true)
    setError(null)
    const { error: err } = await supabase
      .from('tasks')
      .update(status === 'done' ? { status, actual_start: t.actual_start ?? todayLocal(), actual_end: todayLocal() } : { status, actual_start: todayLocal() })
      .eq('id', t.id)
    setBusy(false)
    if (err) setError(navigator.onLine ? err.message : 'No signal. Status changes need a connection.')
    await data.reload()
  }

  async function restore(t: Task) {
    let reason: string | null = null
    if (frozen) {
      reason = window.prompt('The baseline is frozen. Why is this task coming back?')?.trim() || null
      if (!reason) return
    }
    const { error: err } = await supabase.from('tasks').update({ removed_at: null, change_reason: reason }).eq('id', t.id)
    if (err) setError(err.message)
    await data.reload()
  }

  const stages = [...new Set(live.map((t) => t.stage))].sort((a, b) => a - b)
  const sortTasks = (a: Task, b: Task) => (planned[a.id]?.es ?? 0) - (planned[b.id]?.es ?? 0) || a.sort_order - b.sort_order

  return (
    <section className="stack">
      {offline && <p className="notice">No signal. Showing the schedule as last seen on this phone. Changes need a connection.</p>}
      {data.error && <p className="error">{data.error}</p>}
      {result && !result.ok && (
        <p className="error" role="alert">
          These tasks are linked in a loop and have no dates: {result.loop.map((id) => tasks.find((t) => t.id === id)?.name).join(', ')}. Edit their “After” links.
        </p>
      )}

      <div className="summary-row">
        <div>
          <span className="muted small">Forecast finish</span>
          <strong className="big-date">{formatDay(result?.finish ?? null) || '—'}</strong>
        </div>
        <div>
          <span className="muted small">Baseline</span>
          {frozen ? (
            <strong className={(result?.slip ?? 0) > 0 ? 'big-date late' : 'big-date'}>
              {formatDay(result?.baselineFinish ?? null)}
              {result?.slip ? <span className="slip">{result.slip > 0 ? ` +${result.slip}d` : ` ${result.slip}d`}</span> : null}
            </strong>
          ) : (
            <strong className="big-date muted">Not frozen</strong>
          )}
        </div>
      </div>

      {result && result.criticalPath.length > 0 && (
        <div className="stack-tight">
          <h2>Critical path</h2>
          <ol className="crit-strip" aria-label="Critical path">
            {result.criticalPath.map((id) => {
              const t = tasks.find((x) => x.id === id)!
              return (
                <li key={id} className={isMilestone(t) ? 'ms' : ''}>
                  <button type="button" onClick={() => setEditing(id)}>
                    <span>{t.name}</span>
                    <span className="small">{isMilestone(t) ? formatDay(planned[id].end) : `${formatDay(planned[id].start)} – ${formatDay(planned[id].end)}`}</span>
                  </button>
                </li>
              )
            })}
          </ol>
        </div>
      )}

      {flagged.length > 0 && (
        <ul className="stack-tight">
          {flagged.map((t) => (
            <li key={t.id} className="flag flagrow">
              <span className="dot" aria-hidden="true" />
              <span>
                <strong>{t.name}</strong>:{' '}
                {gateFlags[t.id] ?? (t.status === 'blocked' ? 'marked blocked' : planned[t.id]?.overdue ? 'running past its duration' : `forecast ${planned[t.id]?.slip} working days past baseline`)}
              </span>
            </li>
          ))}
        </ul>
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <div className="button-row">
        <button type="button" className="secondary" onClick={() => go(`/project/${projectId}/timeline`)}>
          Timeline
        </button>
        {!offline && (
          <button
            type="button"
            className="secondary"
            onClick={() => {
              setNewStage(project.stage)
              setEditing('new')
            }}
          >
            Add a task
          </button>
        )}
      </div>

      {editing === 'new' && (
        <TaskEditor
          projectId={projectId}
          task={null}
          tasks={tasks}
          planned={planned}
          drawings={data.drawings}
          trades={project.trades}
          rooms={project.rooms}
          frozen={frozen}
          owner={owner}
          defaultStage={newStage}
          onDone={() => {
            setEditing(null)
            void data.reload()
          }}
          onCancel={() => setEditing(null)}
        />
      )}

      {stages.map((stage) => (
        <div key={stage} className="stack-tight">
          <h2>
            {stage}. {STAGES[stage - 1]}
          </h2>
          <ul className="rows">
            {live
              .filter((t) => t.stage === stage)
              .sort(sortTasks)
              .map((t) => {
                const pl = planned[t.id]
                const label = statusLabel(t, pl)
                const ms = isMilestone(t)
                return (
                  <li key={t.id} className={pl?.critical ? 'task crit' : 'task'}>
                    {editing === t.id ? (
                      <TaskEditor
                        projectId={projectId}
                        task={t}
                        tasks={tasks}
                        planned={planned}
                        drawings={data.drawings}
                        trades={project.trades}
                        rooms={project.rooms}
                        frozen={frozen}
                        owner={owner}
                        defaultStage={stage}
                        onDone={() => {
                          setEditing(null)
                          void data.reload()
                        }}
                        onCancel={() => setEditing(null)}
                      />
                    ) : (
                      <div className="task-row">
                        <button type="button" className="row" onClick={() => !offline && setEditing(t.id)} aria-label={`${t.name}, ${label}`}>
                          <span className="row-line">
                            <span className="row-title">
                              {ms && <span className="diamond" aria-hidden="true" />}
                              {t.name}
                            </span>
                            <span className={label === 'Done' ? 'tag ok' : label === 'Planned' || label === 'In progress' ? 'tag muted' : 'tag'}>{label}</span>
                          </span>
                          <span className="muted small">
                            {pl ? (ms ? formatDay(pl.end) : `${formatDay(pl.start)} – ${formatDay(pl.end)} · ${t.duration}d`) : 'No dates'}
                            {pl && !pl.critical && t.status !== 'done' && pl.float > 0 ? ` · ${pl.float}d spare` : ''}
                            {pl?.critical ? ' · critical' : ''}
                            {t.trade ? ` · ${t.trade}` : ''}
                            {t.owner_name ? ` · ${t.owner_name}` : ''}
                          </span>
                        </button>
                        {!offline && !ms && t.status !== 'done' && (
                          <button type="button" className="pill" disabled={busy} onClick={() => quickStatus(t, t.status === 'in_progress' ? 'done' : 'in_progress')}>
                            {t.status === 'in_progress' ? 'Done today' : 'Start today'}
                          </button>
                        )}
                        {!offline && ms && t.status !== 'done' && (
                          <button type="button" className="pill" disabled={busy} onClick={() => quickStatus(t, 'done')}>
                            Reached
                          </button>
                        )}
                      </div>
                    )}
                  </li>
                )
              })}
          </ul>
        </div>
      ))}

      {live.length === 0 && <p className="muted">No tasks yet.</p>}

      <BaselineCard frozen={frozen} owner={owner} offline={offline} baselineAt={settings.baseline_at} baselineBy={settings.baseline_by ? names[settings.baseline_by] : null} onFreeze={async (reason) => {
        if (!result || !result.ok) return 'Fix the loop in the “After” links first.'
        const { error: err } = await supabase
          .from('project_schedules')
          .update({ baseline_at: new Date().toISOString(), baseline_plan: baselinePlan(result), change_reason: reason || null })
          .eq('project_id', projectId)
        await data.reload()
        return err ? err.message : null
      }} />

      <CalendarSettings settings={settings} frozen={frozen} offline={offline} onSaved={data.reload} />

      {data.changes.length > 0 && (
        <details>
          <summary className="small">Change log ({data.changes.length})</summary>
          <ul className="issues">
            {data.changes.map((c) => (
              <li key={c.id}>
                <span>
                  <strong>{changeTitle(c.kind)}</strong> {String(c.after?.name ?? c.before?.name ?? '')}
                  {c.kind === 'changed' && c.before && c.after && c.before.duration !== c.after.duration ? ` ${c.before.duration}d → ${c.after.duration}d` : ''}
                  {c.reason ? `: ${c.reason}` : ''}
                </span>
                <span className="muted">
                  {c.changed_by ? names[c.changed_by] ?? '' : ''} {formatDay(c.changed_at.slice(0, 10))}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {removed.length > 0 && (
        <details>
          <summary className="small">Removed tasks ({removed.length})</summary>
          <ul className="issues">
            {removed.map((t) => (
              <li key={t.id}>
                <span>{t.name}</span>
                {owner && !offline && (
                  <button type="button" className="link" onClick={() => restore(t)}>
                    Restore
                  </button>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}

function changeTitle(kind: string): string {
  return (
    {
      added: 'Added',
      changed: 'Changed',
      removed: 'Removed',
      restored: 'Restored',
      baseline: 'Baseline frozen',
      rebaseline: 'Re-baselined',
      calendar: 'Calendar changed',
    }[kind] ?? kind
  )
}

function BaselineCard(props: {
  frozen: boolean
  owner: boolean
  offline: boolean
  baselineAt: string | null
  baselineBy: string | null
  onFreeze: (reason: string) => Promise<string | null>
}) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const status = props.frozen
    ? `Frozen ${formatDay(props.baselineAt?.slice(0, 10) ?? null)}${props.baselineBy ? ` by ${props.baselineBy}` : ''}. Date changes now need a reason.`
    : 'Not frozen. Freeze it when work orders are issued.'

  return (
    <div className="card stack">
      <h2>Baseline</h2>
      <p className="small">{status}</p>
      {!props.owner && <p className="muted small">Only an owner can freeze or re-baseline.</p>}
      {props.owner && !props.offline && !open && (
        <button type="button" className="secondary" onClick={() => setOpen(true)}>
          {props.frozen ? 'Re-baseline' : 'Freeze baseline'}
        </button>
      )}
      {open && (
        <div className="stack">
          <p className="small">
            {props.frozen
              ? 'Today’s forecast becomes the new baseline. The old one stays in the change log.'
              : 'Today’s forecast dates become the baseline that slippage is measured against.'}
          </p>
          {props.frozen && (
            <label className="field">
              <span>Reason for re-baselining</span>
              <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
            </label>
          )}
          {error && <p className="error">{error}</p>}
          <div className="button-row">
            <button
              type="button"
              className="primary"
              disabled={busy || (props.frozen && !reason.trim())}
              onClick={async () => {
                setBusy(true)
                const err = await props.onFreeze(reason.trim())
                setBusy(false)
                setError(err)
                if (!err) {
                  setOpen(false)
                  setReason('')
                }
              }}
            >
              {busy ? 'Saving' : props.frozen ? 'Re-baseline' : 'Freeze'}
            </button>
            <button type="button" className="secondary" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function WorkDayChips({ value, onChange }: { value: number[]; onChange: (v: number[]) => void }) {
  return (
    <div className="chips" role="group" aria-label="Working days">
      {WEEKDAYS.map((d, i) => {
        const n = i + 1
        const on = value.includes(n)
        return (
          <button
            key={d}
            type="button"
            className={on ? 'chip on' : 'chip'}
            aria-pressed={on}
            onClick={() => {
              const next = on ? value.filter((x) => x !== n) : [...value, n].sort()
              if (next.length) onChange(next)
            }}
          >
            {d}
          </button>
        )
      })}
    </div>
  )
}

function CalendarSettings(props: {
  settings: { project_id: string; start_date: string; work_days: number[]; holidays: string[] }
  frozen: boolean
  offline: boolean
  onSaved: () => Promise<void>
}) {
  const s = props.settings
  const [start, setStart] = useState(s.start_date)
  const [days, setDays] = useState<number[]>(s.work_days)
  const [holidays, setHolidays] = useState(s.holidays.join(', '))
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const list = holidays
    .split(/[\s,]+/)
    .map((h) => h.trim())
    .filter(Boolean)
  const badHoliday = list.find((h) => !/^\d{4}-\d{2}-\d{2}$/.test(h))

  async function save(e: FormEvent) {
    e.preventDefault()
    if (badHoliday) return setError(`“${badHoliday}” is not a date like 2026-11-08.`)
    if (props.frozen && !reason.trim()) return setError('The baseline is frozen. Say why the calendar changes.')
    setBusy(true)
    setError(null)
    const { error: err } = await supabase
      .from('project_schedules')
      .update({ start_date: start, work_days: days, holidays: [...new Set(list)].sort(), change_reason: reason.trim() || null })
      .eq('project_id', s.project_id)
    setBusy(false)
    if (err) return setError(err.message)
    setReason('')
    setSaved(true)
    await props.onSaved()
  }

  return (
    <details>
      <summary className="small">
        Calendar: from {formatDay(s.start_date)}, {s.work_days.length === 6 && !s.work_days.includes(7) ? 'Mon–Sat' : s.work_days.map((d) => WEEKDAYS[d - 1]).join(' ')}
        {s.holidays.length ? `, ${s.holidays.length} holiday${s.holidays.length === 1 ? '' : 's'}` : ''}
      </summary>
      <form onSubmit={save} className="stack card">
        <label className="field">
          <span>Schedule starts on</span>
          <input type="date" value={start} onChange={(e) => setStart(e.target.value)} required />
        </label>
        <div className="field">
          <span>Working days</span>
          <WorkDayChips value={days} onChange={setDays} />
        </div>
        <label className="field">
          <span>Holidays (dates, comma separated)</span>
          <textarea rows={2} value={holidays} onChange={(e) => setHolidays(e.target.value)} placeholder="2026-11-08, 2027-01-14" />
        </label>
        {props.frozen && (
          <label className="field">
            <span>Why the calendar changes</span>
            <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
        )}
        {error && <p className="error">{error}</p>}
        {saved && !error && <p className="muted small">Saved.</p>}
        {!props.offline && (
          <button type="submit" className="secondary" disabled={busy}>
            {busy ? 'Saving' : 'Save calendar'}
          </button>
        )}
      </form>
    </details>
  )
}

function ScheduleSetup({ project, onDone }: { project: Project; onDone: () => Promise<void> }) {
  const [start, setStart] = useState(todayLocal())
  const [days, setDays] = useState<number[]>(MON_SAT)
  const [fromStage, setFromStage] = useState(project.stage)
  const [useTemplate, setUseTemplate] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const count = templateRows(project.id, fromStage, () => 'x').length

  async function create(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const { error: err } = await supabase.from('project_schedules').insert({ project_id: project.id, start_date: start, work_days: days })
    if (err && err.code !== '23505') {
      setBusy(false)
      return setError(navigator.onLine ? err.message : 'No signal. Setting up a schedule needs a connection.')
    }
    if (useTemplate) {
      const { error: taskErr } = await supabase.from('tasks').insert(templateRows(project.id, fromStage))
      if (taskErr) {
        setBusy(false)
        await onDone()
        return setError(`The calendar was saved but the tasks were not: ${taskErr.message}`)
      }
    }
    setBusy(false)
    await onDone()
  }

  return (
    <form onSubmit={create} className="stack card">
      <h2>Set up the schedule</h2>
      <label className="field">
        <span>Schedule starts on</span>
        <input type="date" value={start} onChange={(e) => setStart(e.target.value)} required />
      </label>
      <div className="field">
        <span>Working days</span>
        <WorkDayChips value={days} onChange={setDays} />
      </div>
      <label className="check">
        <input type="checkbox" checked={useTemplate} onChange={(e) => setUseTemplate(e.target.checked)} />
        <span>Start from the stage template</span>
      </label>
      {useTemplate && (
        <label className="field">
          <span>From stage</span>
          <select value={fromStage} onChange={(e) => setFromStage(Number(e.target.value))}>
            {STAGES.map((s, i) => (
              <option key={s} value={i + 1}>
                {i + 1} {s}
              </option>
            ))}
          </select>
        </label>
      )}
      {useTemplate && <p className="muted small">{count} tasks with placeholder durations in working days. Adjust them after.</p>}
      {error && <p className="error">{error}</p>}
      <button type="submit" className="primary" disabled={busy}>
        {busy ? 'Setting up' : 'Create schedule'}
      </button>
    </form>
  )
}
