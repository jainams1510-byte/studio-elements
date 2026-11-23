import { useState, type FormEvent } from 'react'
import { todayLocal, type Drawing } from '../drawings'
import { formatDay, isMilestone, makesLoop, type Planned, type Task, type TaskStatus } from '../schedule'
import { supabase } from '../supabase'
import { STAGES } from '../types'

type Props = {
  projectId: string
  task: Task | null // null = new task
  tasks: Task[]
  planned: Record<string, Planned>
  drawings: Drawing[]
  trades: string[]
  rooms: string[]
  frozen: boolean
  owner: boolean
  defaultStage: number
  onDone: () => void
  onCancel: () => void
}

function friendly(message: string): string {
  if (!navigator.onLine) return 'No signal. Schedule changes need a connection.'
  return message
}

export default function TaskEditor(p: Props) {
  const t = p.task
  const [name, setName] = useState(t?.name ?? '')
  const [stage, setStage] = useState(t?.stage ?? p.defaultStage)
  const [milestone, setMilestone] = useState(t ? isMilestone(t) : false)
  const [duration, setDuration] = useState(String(t?.duration ?? 1))
  const [after, setAfter] = useState<string[]>(t?.after_ids ?? [])
  const [trade, setTrade] = useState(t?.trade ?? '')
  const [room, setRoom] = useState(t?.room ?? '')
  const [ownerName, setOwnerName] = useState(t?.owner_name ?? '')
  const [gate, setGate] = useState(t?.gate_drawing_id ?? '')
  const [status, setStatus] = useState<TaskStatus>(t?.status ?? 'planned')
  const [actualStart, setActualStart] = useState(t?.actual_start ?? '')
  const [actualEnd, setActualEnd] = useState(t?.actual_end ?? '')
  const [reason, setReason] = useState('')
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const live = p.tasks.filter((x) => !x.removed_at && x.id !== t?.id)
  const byId = new Map(p.tasks.map((x) => [x.id, x]))
  const days = milestone ? 0 : Math.max(0, Math.round(Number(duration) || 0))
  const scheduleChanges = !t || days !== t.duration || after.join() !== t.after_ids.join()
  const needsReason = p.frozen && scheduleChanges
  const dependents = t ? live.filter((x) => x.after_ids.includes(t.id)) : []
  const candidates = live
    .filter((x) => !after.includes(x.id))
    .filter((x) => !t || !makesLoop(p.tasks, t.id, [x.id]))
    .sort((a, b) => a.stage - b.stage || (p.planned[a.id]?.es ?? 0) - (p.planned[b.id]?.es ?? 0))

  async function save(e: FormEvent) {
    e.preventDefault()
    if (!name.trim()) return setError('Give the task a name.')
    if (!milestone && days < 1) return setError('Duration must be at least 1 working day, or tick Milestone.')
    if (needsReason && !reason.trim()) return setError('The baseline is frozen. Say why the schedule changes.')
    if (status === 'done' && actualStart && actualEnd && actualEnd < actualStart) return setError('Finish date is before the start date.')
    setBusy(true)
    setError(null)
    const fields = {
      stage,
      name: name.trim(),
      trade: trade || null,
      room: room || null,
      owner_name: ownerName.trim() || null,
      duration: days,
      milestone,
      after_ids: after,
      gate_drawing_id: gate || null,
      status,
      actual_start: status === 'planned' ? null : actualStart || null,
      actual_end: status === 'done' ? actualEnd || null : null,
      change_reason: reason.trim() || null,
    }
    const sortOrder = Math.max(0, ...p.tasks.filter((x) => x.stage === stage).map((x) => x.sort_order)) + 1
    const { error: err } = t
      ? await supabase.from('tasks').update(fields).eq('id', t.id)
      : await supabase.from('tasks').insert({ ...fields, id: crypto.randomUUID(), project_id: p.projectId, sort_order: sortOrder })
    setBusy(false)
    if (err) return setError(friendly(err.message))
    p.onDone()
  }

  async function remove() {
    if (!t) return
    if (p.frozen && !reason.trim()) return setError('The baseline is frozen. Say why this task is removed.')
    setBusy(true)
    const { error: err } = await supabase
      .from('tasks')
      .update({ removed_at: new Date().toISOString(), change_reason: reason.trim() || null })
      .eq('id', t.id)
    setBusy(false)
    if (err) return setError(friendly(err.message))
    p.onDone()
  }

  return (
    <form onSubmit={save} className="stack card editor">
      <h2>{t ? 'Edit task' : 'Add a task'}</h2>
      <label className="field">
        <span>Task</span>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} required />
      </label>
      <div className="two">
        <label className="field">
          <span>Stage</span>
          <select value={stage} onChange={(e) => setStage(Number(e.target.value))}>
            {STAGES.map((s, i) => (
              <option key={s} value={i + 1}>
                {i + 1} {s}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Working days</span>
          <input type="number" inputMode="numeric" min={milestone ? 0 : 1} value={milestone ? '0' : duration} disabled={milestone} onChange={(e) => setDuration(e.target.value)} />
        </label>
      </div>
      <label className="check">
        <input type="checkbox" checked={milestone} onChange={(e) => setMilestone(e.target.checked)} />
        <span>Milestone (a gate, takes no days)</span>
      </label>

      <div className="field">
        <span>After (starts when these finish)</span>
        {after.length > 0 && (
          <ul className="chips">
            {after.map((id) => (
              <li key={id}>
                <button type="button" className="chip on" onClick={() => setAfter(after.filter((a) => a !== id))} aria-label={`Remove link to ${byId.get(id)?.name ?? 'task'}`}>
                  {byId.get(id)?.name ?? 'Removed task'} ×
                </button>
              </li>
            ))}
          </ul>
        )}
        <select
          value=""
          aria-label="Add an After task"
          onChange={(e) => {
            if (e.target.value) setAfter([...after, e.target.value])
          }}
        >
          <option value="">{after.length ? 'Add another' : 'No link: starts at the schedule start'}</option>
          {candidates.map((x) => (
            <option key={x.id} value={x.id}>
              {x.stage}. {x.name}
              {p.planned[x.id] ? ` (ends ${formatDay(p.planned[x.id].end)})` : ''}
            </option>
          ))}
        </select>
      </div>

      <div className="two">
        <label className="field">
          <span>Trade</span>
          <select value={trade} onChange={(e) => setTrade(e.target.value)}>
            <option value="">None</option>
            {[...new Set([...p.trades, ...(trade ? [trade] : [])])].map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Room</span>
          <select value={room} onChange={(e) => setRoom(e.target.value)}>
            <option value="">Whole project</option>
            {[...new Set([...p.rooms, ...(room ? [room] : [])])].map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </label>
      </div>
      <label className="field">
        <span>Owner</span>
        <input type="text" value={ownerName} onChange={(e) => setOwnerName(e.target.value)} placeholder="Who answers for it, e.g. Bhavin or the carpentry agency" />
      </label>
      <label className="field">
        <span>Needs sheet at R0 before starting</span>
        <select value={gate} onChange={(e) => setGate(e.target.value)}>
          <option value="">No sheet gate</option>
          {[...p.drawings].sort((a, b) => a.number.localeCompare(b.number, 'en', { numeric: true })).map((d) => (
            <option key={d.id} value={d.id}>
              {d.number} {d.title}
            </option>
          ))}
        </select>
      </label>

      <div className="field">
        <span>Status</span>
        <div className="chips">
          {(
            [
              ['planned', 'Planned'],
              ['in_progress', 'In progress'],
              ['done', 'Done'],
              ['blocked', 'Blocked'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={status === value ? 'chip on' : 'chip'}
              aria-pressed={status === value}
              onClick={() => {
                setStatus(value)
                if ((value === 'in_progress' || value === 'done') && !actualStart) setActualStart(todayLocal())
                if (value === 'done' && !actualEnd) setActualEnd(todayLocal())
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {status !== 'planned' && (
        <div className="two">
          <label className="field">
            <span>Started on</span>
            <input type="date" value={actualStart} onChange={(e) => setActualStart(e.target.value)} />
          </label>
          {status === 'done' && (
            <label className="field">
              <span>Finished on</span>
              <input type="date" value={actualEnd} onChange={(e) => setActualEnd(e.target.value)} />
            </label>
          )}
        </div>
      )}

      {(needsReason || (p.frozen && confirmRemove)) && (
        <label className="field">
          <span>Why the schedule changes (kept in the change log)</span>
          <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Client added a study; decision on site 24 Nov" />
        </label>
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="button-row">
        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Saving' : t ? 'Save' : 'Add task'}
        </button>
        <button type="button" className="secondary" onClick={p.onCancel}>
          Cancel
        </button>
      </div>

      {t && p.owner && !confirmRemove && (
        <button type="button" className="link left" onClick={() => setConfirmRemove(true)}>
          Remove this task
        </button>
      )}
      {t && p.owner && confirmRemove && (
        <div className="confirm stack">
          <p className="small">
            Remove “{t.name}”? It can be restored.
            {dependents.length > 0 && ` ${dependents.length} task${dependents.length === 1 ? '' : 's'} come after it and will lose this link.`}
          </p>
          <div className="button-row">
            <button type="button" className="danger" disabled={busy} onClick={remove}>
              Remove
            </button>
            <button type="button" className="secondary" onClick={() => setConfirmRemove(false)}>
              Keep
            </button>
          </div>
        </div>
      )}
    </form>
  )
}
