import { useState, type FormEvent } from 'react'
import { friendly, useProcurementData } from '../../decisions/data'
import { procurementDrafts } from '../../decisions/drafts'
import { isOrdered, materialGate, procurementState, sameVendorName, sortProcurement, type ProcState } from '../../decisions/logic'
import { PROCUREMENT_STEP_LABEL, PROCUREMENT_STEPS, type ProcurementItem, type ProcurementStatus, type Vendor } from '../../domain'
import { todayLocal } from '../../drawings'
import { useProjects } from '../../hooks'
import type { Draft } from '../../portfolio'
import { formatDay, shiftDays, type Planned, type Task } from '../../schedule'
import { supabase } from '../../supabase'
import { isOwner, useTeam } from '../../team'
import { useSchedule } from '../../useSchedule'
import DraftBox from './DraftBox'

export default function ProcurementTab({ projectId }: { projectId: string }) {
  const data = useProcurementData(projectId)
  const schedule = useSchedule(projectId)
  const { projects } = useProjects()
  const project = projects.find((p) => p.id === projectId)
  const { me } = useTeam()
  const owner = isOwner(me)
  const [editing, setEditing] = useState<string | 'new' | null>(null)
  const [draft, setDraft] = useState<{ id: string; draft: Draft } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const today = todayLocal()
  const offline = data.state === 'offline'
  // The phone's copy is read-only, including the moment before fresh data arrives.
  const readOnly = offline || data.state === 'stale'

  if (data.state === 'loading') return <p className="muted">Loading</p>

  const planned: Record<string, Planned> = schedule.result?.tasks ?? {}
  const tasks = schedule.tasks.filter((t) => !t.removed_at)
  const taskById = new Map(schedule.tasks.map((t) => [t.id, t]))
  const vendorById = new Map(data.vendors.map((v) => [v.id, v]))
  const live = data.items.filter((i) => !i.removed_at)
  const removed = data.items.filter((i) => i.removed_at)
  const stateOf = (it: ProcurementItem): ProcState => {
    const t = it.task_id ? taskById.get(it.task_id) : undefined
    return procurementState(it, today, t ? { name: t.name, start: planned[t.id]?.start } : null)
  }
  const rows = sortProcurement(live.map((item) => ({ item, state: stateOf(item) })))
  const gate = materialGate(live, tasks, planned, today)
  const drafts = new Map(
    procurementDrafts({
      today,
      projects: [{ id: projectId, name: project?.name ?? 'Project' }],
      items: live,
      vendors: data.vendors,
      tasks,
      taskStarts: Object.fromEntries(Object.values(planned).map((p) => [p.id, p.start])),
    }).map((d) => [d.key.split(':')[1], d]),
  )

  async function restore(it: ProcurementItem) {
    setError(null)
    const { error: err } = await supabase.from('procurement_items').update({ removed_at: null }).eq('id', it.id)
    if (err) setError(friendly(err.message, 'Restoring'))
    await data.reload()
  }

  const done = async () => {
    await data.reload() // close the form only once the fresh row is on show
    setEditing(null)
  }
  const form = (it: ProcurementItem | null) => (
    <ProcurementForm
      projectId={projectId}
      item={it}
      tasks={tasks}
      planned={planned}
      vendors={data.vendors}
      trades={project?.trades ?? []}
      rooms={project?.rooms ?? []}
      owner={owner}
      onVendorAdded={data.reload}
      onDone={done}
      onCancel={() => setEditing(null)}
    />
  )

  return (
    <section className="stack" data-state={data.state === 'ready' && schedule.state !== 'loading' ? 'ready' : data.state}>
      {offline && <p className="notice">No signal. Showing procurement as last seen on this phone. Changes need a connection.</p>}
      {data.error && <p className="error">{data.error}</p>}

      {schedule.state === 'loading' && <p className="muted small">Loading the schedule for task dates</p>}
      {gate.length > 0 && (
        <div className="stack-tight" aria-label="Material not on site">
          <h2>Material not on site</h2>
          <ul className="stack-tight">
            {gate.map((g) => (
              <li key={g.task.id} className="flag flagrow dc-gate">
                <span className="dot" aria-hidden="true" />
                <span>
                  <strong>{g.task.name}</strong> {g.started ? 'has started' : `starts ${formatDay(g.start)}`}: waiting on{' '}
                  {g.items.map((i) => `${i.item} (${PROCUREMENT_STEP_LABEL[i.status].toLowerCase()})`).join(', ')}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="muted small">Order-by date = the date it is needed on site (the linked task’s forecast start, or a date) minus the lead time.</p>

      {!readOnly && editing !== 'new' && (
        <button type="button" className="secondary" onClick={() => setEditing('new')}>
          Add an item
        </button>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {editing === 'new' && form(null)}
      {rows.length === 0 && editing !== 'new' && <p className="muted">No items yet. Add long-lead materials first.</p>}

      <ul className="stack">
        {rows.map(({ item: it, state }) => {
          if (editing === it.id) return <li key={it.id}>{form(it)}</li>
          const task = it.task_id ? taskById.get(it.task_id) : undefined
          const vendor = it.vendor_id ? vendorById.get(it.vendor_id) : undefined
          const reminder = drafts.get(it.id)
          return (
            <li key={it.id} className={it.status === 'on_site' ? 'card faded dc-card' : 'card dc-card'} data-item={it.id}>
              <div className="dc-tags">
                <span className={it.status === 'on_site' ? 'tag ok' : 'tag muted'}>{PROCUREMENT_STEP_LABEL[it.status]}</span>
                {state.flags.map((f) => (
                  <span key={f.kind} className={`htag ${f.level}`} data-flag={f.kind}>
                    {f.text}
                  </span>
                ))}
              </div>
              <p className="row-title">{it.item}</p>
              {(it.room || it.trade) && <span className="muted small">{[it.room, it.trade].filter(Boolean).join(' · ')}</span>}
              <dl className="dc-facts small">
                <div>
                  <dt>Needed</dt>
                  <dd className="dc-need">
                    {state.need
                      ? `${formatDay(state.need)}${state.needSource === 'task' && task ? ` (${task.name} starts)` : ''}`
                      : 'Link a task or set a need-by date'}
                  </dd>
                </div>
                <div>
                  <dt>Order by</dt>
                  <dd className="dc-orderby">
                    {state.orderBy ? formatDay(state.orderBy) : '—'} · {it.lead_days} days lead
                  </dd>
                </div>
                <div>
                  <dt>Vendor</dt>
                  <dd>{vendor ? `${vendor.name}${vendor.phone ? ` · ${vendor.phone}` : ''}` : 'Not chosen'}</dd>
                </div>
                <div>
                  <dt>Spec</dt>
                  <dd>{it.spec_approved ? 'Approved' : 'Not approved yet'}</dd>
                </div>
                {(it.ordered_on || it.expected_on || it.delivered_on) && (
                  <div>
                    <dt>Dates</dt>
                    <dd>
                      {[it.ordered_on && `ordered ${formatDay(it.ordered_on)}`, it.expected_on && `expected ${formatDay(it.expected_on)}`, it.delivered_on && `on site ${formatDay(it.delivered_on)}`]
                        .filter(Boolean)
                        .join(' · ')}
                    </dd>
                  </div>
                )}
              </dl>
              {it.note.trim() && <p className="small">{it.note}</p>}
              {draft?.id === it.id ? (
                <DraftBox draft={draft.draft} onClose={() => setDraft(null)} />
              ) : (
                <div className="button-row dc-actions">
                  {!readOnly && (
                    <button type="button" className="secondary" onClick={() => setEditing(it.id)}>
                      Edit
                    </button>
                  )}
                  {reminder && (
                    <button type="button" className="secondary" onClick={() => setDraft({ id: it.id, draft: reminder })}>
                      Draft order reminder
                    </button>
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ul>

      {owner && removed.length > 0 && (
        <details>
          <summary className="muted small">Removed items ({removed.length})</summary>
          <ul className="rows">
            {removed.map((it) => (
              <li key={it.id} className="row-line padded">
                <span className="small grow">{it.item}</span>
                {!readOnly && (
                  <button type="button" className="pill" onClick={() => restore(it)}>
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

function ProcurementForm(p: {
  projectId: string
  item: ProcurementItem | null
  tasks: Task[]
  planned: Record<string, Planned>
  vendors: Vendor[]
  trades: string[]
  rooms: string[]
  owner: boolean
  onVendorAdded: () => Promise<void>
  onDone: () => Promise<void> | void
  onCancel: () => void
}) {
  const it = p.item
  const [name, setName] = useState(it?.item ?? '')
  const [trade, setTrade] = useState(it?.trade ?? '')
  const [room, setRoom] = useState(it?.room ?? '')
  const [task, setTask] = useState(it?.task_id ?? '')
  const [needBy, setNeedBy] = useState(it?.need_by ?? '')
  const [lead, setLead] = useState(String(it?.lead_days ?? 14))
  const [vendor, setVendor] = useState(it?.vendor_id ?? '')
  const [spec, setSpec] = useState(it?.spec_approved ?? false)
  const [status, setStatus] = useState<ProcurementStatus>(it?.status ?? 'specified')
  const [orderedOn, setOrderedOn] = useState(it?.ordered_on ?? '')
  const [expectedOn, setExpectedOn] = useState(it?.expected_on ?? '')
  const [deliveredOn, setDeliveredOn] = useState(it?.delivered_on ?? '')
  const [note, setNote] = useState(it?.note ?? '')
  const [addingVendor, setAddingVendor] = useState(false)
  const [vName, setVName] = useState('')
  const [vTrade, setVTrade] = useState('')
  const [vPhone, setVPhone] = useState('')
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [vendorNote, setVendorNote] = useState<string | null>(null)

  const leadDays = Math.round(Number(lead))
  const taskStart = task ? p.planned[task]?.start : undefined
  const need = taskStart ?? (needBy || null)
  const vendors = p.vendors.filter((v) => !v.archived || v.id === vendor).sort((a, b) => a.name.localeCompare(b.name))
  const tasks = [...p.tasks].sort((a, b) => (p.planned[a.id]?.es ?? 0) - (p.planned[b.id]?.es ?? 0) || a.stage - b.stage)
  const ordered = isOrdered(status)

  async function addVendor() {
    setVendorNote(null)
    const n = vName.trim()
    if (!n) return setVendorNote('Give the vendor a name.')
    const existing = p.vendors.find((v) => sameVendorName(v.name, n))
    if (existing) {
      setVendor(existing.id)
      return setVendorNote(`${existing.name} is already in the vendor list. Selected it.`)
    }
    setBusy(true)
    const id = crypto.randomUUID()
    const { error: err } = await supabase.from('vendors').insert({ id, name: n, kind: 'supplier', trade: vTrade || null, phone: vPhone.trim() || null })
    setBusy(false)
    if (err) return setVendorNote(err.code === '23505' ? `A vendor named ${n} already exists.` : friendly(err.message, 'Adding a vendor'))
    await p.onVendorAdded()
    setVendor(id)
    setAddingVendor(false)
    setVName('')
    setVTrade('')
    setVPhone('')
    setVendorNote(`Added ${n}.`)
  }

  async function save(e: FormEvent) {
    e.preventDefault()
    if (!name.trim()) return setError('Name the item.')
    if (!(leadDays >= 0 && leadDays <= 365)) return setError('Lead time must be 0 to 365 days.')
    setBusy(true)
    setError(null)
    const fields = {
      item: name.trim(),
      trade: trade || null,
      room: room || null,
      task_id: task || null,
      need_by: needBy || null,
      lead_days: leadDays,
      vendor_id: vendor || null,
      spec_approved: spec || status !== 'specified',
      status,
      ordered_on: ordered ? orderedOn || todayLocal() : null,
      expected_on: expectedOn || null,
      delivered_on: status === 'on_site' ? deliveredOn || todayLocal() : null,
      note: note.trim(),
    }
    const { error: err } = it
      ? await supabase.from('procurement_items').update(fields).eq('id', it.id)
      : await supabase.from('procurement_items').insert({ ...fields, id: crypto.randomUUID(), project_id: p.projectId })
    if (err) {
      setBusy(false)
      return setError(friendly(err.message, 'Saving an item'))
    }
    await p.onDone()
  }

  async function remove() {
    if (!it) return
    setBusy(true)
    const { error: err } = await supabase.from('procurement_items').update({ removed_at: new Date().toISOString() }).eq('id', it.id)
    if (err) {
      setBusy(false)
      return setError(friendly(err.message, 'Removing'))
    }
    await p.onDone()
  }

  return (
    <form onSubmit={save} className="stack card editor dc-form">
      <h2>{it ? 'Edit item' : 'Add an item'}</h2>
      <label className="field">
        <span>Item</span>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Kitchen granite slab, 20 mm" />
      </label>
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
        <span>Needed on site before this task starts</span>
        <select value={task} onChange={(e) => setTask(e.target.value)}>
          <option value="">No task: use a date</option>
          {tasks.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
              {p.planned[t.id] ? ` (starts ${formatDay(p.planned[t.id].start)})` : ''}
            </option>
          ))}
        </select>
      </label>
      <div className="two">
        <label className="field">
          <span>{task ? 'Need-by if no schedule' : 'Need on site by'}</span>
          <input type="date" value={needBy} onChange={(e) => setNeedBy(e.target.value)} />
        </label>
        <label className="field">
          <span>Lead time (days)</span>
          <input type="number" inputMode="numeric" min={0} max={365} value={lead} onChange={(e) => setLead(e.target.value)} />
        </label>
      </div>
      <p className="muted small dc-calc">
        {need && leadDays >= 0
          ? `Needed ${formatDay(need)}${taskStart ? ' (task forecast start)' : ''} → order by ${formatDay(shiftDays(need, -leadDays))}`
          : 'Link a task or set a date to get an order-by date.'}
      </p>

      <label className="field">
        <span>Vendor</span>
        <select value={vendor} onChange={(e) => setVendor(e.target.value)}>
          <option value="">Not chosen</option>
          {vendors.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
              {v.trade ? ` · ${v.trade}` : ''}
            </option>
          ))}
        </select>
      </label>
      {!addingVendor && (
        <button type="button" className="link left" onClick={() => setAddingVendor(true)}>
          Add a vendor
        </button>
      )}
      {addingVendor && (
        <div className="confirm stack" role="group" aria-label="New vendor">
          <label className="field">
            <span>Vendor name</span>
            <input type="text" value={vName} onChange={(e) => setVName(e.target.value)} />
          </label>
          <div className="two">
            <label className="field">
              <span>Vendor trade</span>
              <select value={vTrade} onChange={(e) => setVTrade(e.target.value)}>
                <option value="">None</option>
                {p.trades.map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Phone</span>
              <input type="tel" value={vPhone} onChange={(e) => setVPhone(e.target.value)} />
            </label>
          </div>
          <div className="button-row">
            <button type="button" className="secondary" disabled={busy} onClick={addVendor}>
              Save vendor
            </button>
            <button type="button" className="secondary" onClick={() => setAddingVendor(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {vendorNote && <p className="small">{vendorNote}</p>}

      <label className="check">
        <input type="checkbox" checked={spec || status !== 'specified'} disabled={status !== 'specified'} onChange={(e) => setSpec(e.target.checked)} />
        <span>Spec approved</span>
      </label>
      <div className="field">
        <span>Status</span>
        <div className="dc-seg dc-steps" role="group" aria-label="Status">
          {PROCUREMENT_STEPS.map((s, i) => (
            <button
              key={s}
              type="button"
              className={status === s ? 'on' : PROCUREMENT_STEPS.indexOf(status) > i ? 'past' : ''}
              aria-pressed={status === s}
              onClick={() => {
                setStatus(s)
                if (isOrdered(s) && !orderedOn) setOrderedOn(todayLocal())
                if (s === 'on_site' && !deliveredOn) setDeliveredOn(todayLocal())
              }}
            >
              {PROCUREMENT_STEP_LABEL[s]}
            </button>
          ))}
        </div>
      </div>
      {ordered && (
        <div className="two">
          <label className="field">
            <span>Ordered on</span>
            <input type="date" value={orderedOn} onChange={(e) => setOrderedOn(e.target.value)} />
          </label>
          <label className="field">
            <span>Expected on site</span>
            <input type="date" value={expectedOn} onChange={(e) => setExpectedOn(e.target.value)} />
          </label>
        </div>
      )}
      {status === 'on_site' && (
        <label className="field">
          <span>Delivered on</span>
          <input type="date" value={deliveredOn} onChange={(e) => setDeliveredOn(e.target.value)} />
        </label>
      )}
      <label className="field">
        <span>Note</span>
        <input type="text" value={note} onChange={(e) => setNote(e.target.value)} />
      </label>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="button-row">
        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Saving' : it ? 'Save' : 'Add item'}
        </button>
        <button type="button" className="secondary" onClick={p.onCancel}>
          Cancel
        </button>
      </div>
      {it && p.owner && !confirmRemove && (
        <button type="button" className="link left" onClick={() => setConfirmRemove(true)}>
          Remove this item
        </button>
      )}
      {it && p.owner && confirmRemove && (
        <div className="confirm stack">
          <p className="small">Remove “{it.item}”? It can be restored.</p>
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
