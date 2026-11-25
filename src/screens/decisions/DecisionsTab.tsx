import { useState, type FormEvent } from 'react'
import { friendly, useDecisionsData, type DecisionsRaw } from '../../decisions/data'
import { approvalReminderDraft, confirmationDraft, kindText } from '../../decisions/drafts'
import { decisionOverdue, nextRevisionRound, sortDecisions } from '../../decisions/logic'
import {
  DECISION_KIND_LABEL,
  DECISION_KINDS,
  DECISION_STEPS,
  type Decision,
  type DecisionKind,
  type DecisionStatus,
  type Variation,
} from '../../domain'
import { todayLocal } from '../../drawings'
import { inr, num } from '../../format'
import { useProjects } from '../../hooks'
import type { Draft } from '../../portfolio'
import { formatDay } from '../../schedule'
import { supabase } from '../../supabase'
import { isOwner, useTeam } from '../../team'
import DraftBox from './DraftBox'

const STATUS_LABEL: Record<DecisionStatus, string> = { open: 'Open', answered: 'Answered', confirmed: 'Confirmed', closed: 'Closed' }
const VARIATION_LABEL: Record<Variation['status'], string> = {
  proposed: 'proposed', costed: 'costed', client_approved: 'client approved', executed: 'executed', billed: 'billed',
}

/** Names of the records a decision links to, for its card and its confirmation message. */
function linkNames(d: Decision, raw: DecisionsRaw): string[] {
  const out: string[] = []
  const sheet = raw.sheets.find((s) => s.id === d.drawing_id)
  if (sheet) out.push(`Sheet ${sheet.number} ${sheet.title}`)
  const boq = raw.boq.find((b) => b.id === d.boq_item_id)
  if (boq) out.push(`BOQ ${boq.item}${boq.room ? ` (${boq.room})` : ''}`)
  const task = raw.tasks.find((t) => t.id === d.task_id)
  if (task) out.push(`Task ${task.name}`)
  return out
}

export default function DecisionsTab({ projectId }: { projectId: string }) {
  const data = useDecisionsData(projectId)
  const { projects } = useProjects()
  const projectName = projects.find((p) => p.id === projectId)?.name ?? 'the project'
  const { me } = useTeam()
  const owner = isOwner(me)
  const [kind, setKind] = useState<DecisionKind | 'all'>('all')
  const [status, setStatus] = useState<DecisionStatus | 'all'>('all')
  const [editing, setEditing] = useState<string | 'new' | null>(null)
  const [draft, setDraft] = useState<{ id: string; draft: Draft } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const today = todayLocal()
  const offline = data.state === 'offline'
  // The phone's copy is read-only, including the moment before fresh data arrives.
  const readOnly = offline || data.state === 'stale'

  if (data.state === 'loading') return <p className="muted">Loading</p>

  const live = data.decisions.filter((d) => !d.removed_at)
  const removed = data.decisions.filter((d) => d.removed_at)
  const shown = sortDecisions(live.filter((d) => (kind === 'all' || d.kind === kind) && (status === 'all' || d.status === status)))
  const overdueCount = live.filter((d) => decisionOverdue(d, today)).length

  async function restore(d: Decision) {
    setError(null)
    const { error: err } = await supabase.from('decisions').update({ removed_at: null }).eq('id', d.id)
    if (err) setError(friendly(err.message, 'Restoring'))
    await data.reload()
  }

  const done = async () => {
    await data.reload() // close the form only once the fresh row is on show
    setEditing(null)
  }

  return (
    <section className="stack" data-state={data.state}>
      {offline && <p className="notice">No signal. Showing decisions as last seen on this phone. Changes need a connection.</p>}
      {data.error && <p className="error">{data.error}</p>}
      <p className="muted small">RFIs, approvals, site instructions and design revisions in one list. Open ones come first.</p>
      {overdueCount > 0 && (
        <p className="flag flagrow">
          <span className="dot" aria-hidden="true" />
          <span>
            {overdueCount} open past the need-by date
          </span>
        </p>
      )}

      <div className="chips" role="group" aria-label="Filter by kind">
        <button type="button" className={kind === 'all' ? 'chip on' : 'chip'} aria-pressed={kind === 'all'} onClick={() => setKind('all')}>
          All {live.length}
        </button>
        {DECISION_KINDS.map((k) => (
          <button key={k} type="button" className={kind === k ? 'chip on' : 'chip'} aria-pressed={kind === k} onClick={() => setKind(k)}>
            {DECISION_KIND_LABEL[k]} {live.filter((d) => d.kind === k).length}
          </button>
        ))}
      </div>
      <div className="dc-toolbar">
        <label className="select">
          <span className="sr">Status</span>
          <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value as DecisionStatus | 'all')}>
            <option value="all">All statuses</option>
            {DECISION_STEPS.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]} ({live.filter((d) => d.status === s).length})
              </option>
            ))}
          </select>
        </label>
        {!readOnly && editing !== 'new' && (
          <button type="button" className="pill dc-add" onClick={() => setEditing('new')}>
            Add a decision
          </button>
        )}
      </div>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {editing === 'new' && <DecisionForm projectId={projectId} decision={null} raw={data} owner={owner} defaultKind={kind === 'all' ? 'rfi' : kind} onDone={done} onCancel={() => setEditing(null)} />}

      {shown.length === 0 && editing !== 'new' && <p className="muted">{live.length ? 'Nothing matches these filters.' : 'No decisions yet.'}</p>}

      <ul className="stack">
        {shown.map((d) =>
          editing === d.id ? (
            <li key={d.id}>
              <DecisionForm projectId={projectId} decision={d} raw={data} owner={owner} defaultKind={d.kind} onDone={done} onCancel={() => setEditing(null)} />
            </li>
          ) : (
            <DecisionCard
              key={d.id}
              d={d}
              raw={data}
              today={today}
              offline={readOnly}
              draft={draft?.id === d.id ? draft.draft : null}
              onEdit={() => setEditing(d.id)}
              onDraft={(x) => setDraft(x ? { id: d.id, draft: x } : null)}
              projectName={projectName}
            />
          ),
        )}
      </ul>

      {owner && removed.length > 0 && (
        <details>
          <summary className="muted small">Removed decisions ({removed.length})</summary>
          <ul className="rows">
            {removed.map((d) => (
              <li key={d.id} className="row-line padded">
                <span className="small grow">{d.question}</span>
                {!readOnly && (
                  <button type="button" className="pill" onClick={() => restore(d)}>
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

function DecisionCard(p: {
  d: Decision
  raw: DecisionsRaw
  today: string
  offline: boolean
  draft: Draft | null
  projectName: string
  onEdit: () => void
  onDraft: (d: Draft | null) => void
}) {
  const { d, raw, today } = p
  const overdue = decisionOverdue(d, today)
  const variation = raw.variations.find((v) => v.decision_id === d.id && !v.removed_at)
  const links = linkNames(d, raw)
  const log = raw.logs.find((l) => l.id === d.source_log_id)
  const cost = d.cost_impact !== null && num(d.cost_impact) !== 0
  const reminder = d.kind === 'approval' && overdue

  return (
    <li className={d.status === 'closed' ? 'card faded dc-card' : 'card dc-card'} data-decision={d.id}>
      <div className="dc-tags">
        <span className="tag">{kindText(d)}</span>
        <span className={d.status === 'open' ? 'tag muted dc-status' : 'tag ok dc-status'}>{STATUS_LABEL[d.status]}</span>
        {overdue && <span className="htag late">Overdue</span>}
      </div>
      <p className="row-title">{d.question}</p>
      <dl className="dc-facts small">
        {d.need_by && (
          <div>
            <dt>Need by</dt>
            <dd className={overdue ? 'late' : ''}>{formatDay(d.need_by)}</dd>
          </div>
        )}
        {d.blocks.trim() && (
          <div>
            <dt>Blocks</dt>
            <dd>{d.blocks}</dd>
          </div>
        )}
        {links.length > 0 && (
          <div>
            <dt>Links</dt>
            <dd>{links.join(' · ')}</dd>
          </div>
        )}
        {log && (
          <div>
            <dt>From log</dt>
            <dd>
              {formatDay(log.logged_at.slice(0, 10))} {log.note ? `· ${log.note}` : ''}
            </dd>
          </div>
        )}
        {cost && (
          <div>
            <dt>Cost</dt>
            <dd>
              {inr(num(d.cost_impact))} · {variation ? `variation ${VARIATION_LABEL[variation.status]}` : 'variation to follow in Money'}
            </dd>
          </div>
        )}
      </dl>
      {d.answer.trim() && <p className="why dc-answer">{d.answer}</p>}
      {(d.decided_by || d.decided_on) && (
        <p className="muted small">
          Decided{d.decided_by ? ` by ${d.decided_by}` : ''}
          {d.decided_on ? ` on ${formatDay(d.decided_on)}` : ''}
        </p>
      )}
      {p.draft ? (
        <DraftBox draft={p.draft} onClose={() => p.onDraft(null)} />
      ) : (
        <div className="button-row dc-actions">
          {!p.offline && (
            <button type="button" className="secondary" onClick={p.onEdit}>
              Edit
            </button>
          )}
          {d.status === 'confirmed' && (
            <button type="button" className="secondary" onClick={() => p.onDraft(confirmationDraft(d, p.projectName, links))}>
              Draft confirmation for the WhatsApp group
            </button>
          )}
          {reminder && (
            <button type="button" className="secondary" onClick={() => p.onDraft(approvalReminderDraft(d, p.projectName, today))}>
              Draft reminder to the client
            </button>
          )}
        </div>
      )}
    </li>
  )
}

function DecisionForm(p: {
  projectId: string
  decision: Decision | null
  raw: DecisionsRaw
  owner: boolean
  defaultKind: DecisionKind
  onDone: () => Promise<void> | void
  onCancel: () => void
}) {
  const d = p.decision
  const [kind, setKind] = useState<DecisionKind>(d?.kind ?? p.defaultKind)
  const [approvalKind, setApprovalKind] = useState<'client' | 'material'>(d?.approval_kind ?? 'client')
  const suggested = nextRevisionRound(p.raw.decisions, d?.id)
  const [round, setRound] = useState(String(d?.revision_round ?? suggested))
  const [raisedBy, setRaisedBy] = useState<'client' | 'internal'>(d?.raised_by === 'internal' ? 'internal' : 'client')
  const [question, setQuestion] = useState(d?.question ?? '')
  const [needBy, setNeedBy] = useState(d?.need_by ?? '')
  const [blocks, setBlocks] = useState(d?.blocks ?? '')
  const [sheet, setSheet] = useState(d?.drawing_id ?? '')
  const [boq, setBoq] = useState(d?.boq_item_id ?? '')
  const [task, setTask] = useState(d?.task_id ?? '')
  const [log, setLog] = useState(d?.source_log_id ?? '')
  const [cost, setCost] = useState(d?.cost_impact === null || d?.cost_impact === undefined ? '' : String(num(d.cost_impact)))
  const [answer, setAnswer] = useState(d?.answer ?? '')
  const [decidedBy, setDecidedBy] = useState(d?.decided_by ?? '')
  const [decidedOn, setDecidedOn] = useState(d?.decided_on ?? '')
  const [status, setStatus] = useState<DecisionStatus>(d?.status ?? 'open')
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const sheets = [...p.raw.sheets].sort((a, b) => a.number.localeCompare(b.number, 'en', { numeric: true }))
  const boqItems = p.raw.boq.filter((b) => !b.removed_at || b.id === boq)
  const tasks = p.raw.tasks.filter((t) => !t.removed_at || t.id === task).sort((a, b) => a.stage - b.stage || a.name.localeCompare(b.name))

  async function save(e: FormEvent) {
    e.preventDefault()
    if (!question.trim()) return setError('Write the question or instruction.')
    const roundNo = Math.round(Number(round))
    if (kind === 'revision' && !(roundNo >= 1 && roundNo <= 50)) return setError('Revision round must be between 1 and 50.')
    const costNo = cost.trim() === '' ? null : Number(cost.replace(/,/g, ''))
    if (costNo !== null && !Number.isFinite(costNo)) return setError('Cost impact must be a number in rupees.')
    if (status !== 'open' && !answer.trim()) return setError(`Write the answer before marking it ${STATUS_LABEL[status].toLowerCase()}.`)
    setBusy(true)
    setError(null)
    const fields = {
      kind,
      approval_kind: kind === 'approval' ? approvalKind : null,
      revision_round: kind === 'revision' ? roundNo : null,
      raised_by: kind === 'revision' ? raisedBy : null,
      question: question.trim(),
      answer: answer.trim(),
      need_by: needBy || null,
      blocks: blocks.trim(),
      drawing_id: sheet || null,
      boq_item_id: boq || null,
      task_id: task || null,
      source_log_id: log || null,
      cost_impact: costNo,
      decided_by: decidedBy.trim() || null,
      decided_on: status === 'open' ? null : decidedOn || todayLocal(),
      status,
    }
    const { error: err } = d
      ? await supabase.from('decisions').update(fields).eq('id', d.id)
      : await supabase.from('decisions').insert({ ...fields, id: crypto.randomUUID(), project_id: p.projectId })
    if (err) {
      setBusy(false)
      return setError(friendly(err.message, 'Saving a decision'))
    }
    await p.onDone()
  }

  async function remove() {
    if (!d) return
    setBusy(true)
    const { error: err } = await supabase.from('decisions').update({ removed_at: new Date().toISOString() }).eq('id', d.id)
    if (err) {
      setBusy(false)
      return setError(friendly(err.message, 'Removing'))
    }
    await p.onDone()
  }

  return (
    <form onSubmit={save} className="stack card editor dc-form">
      <h2>{d ? 'Edit decision' : 'Add a decision'}</h2>
      <div className="field">
        <span>Kind</span>
        <div className="chips" role="group" aria-label="Kind">
          {DECISION_KINDS.map((k) => (
            <button key={k} type="button" className={kind === k ? 'chip on' : 'chip'} aria-pressed={kind === k} onClick={() => setKind(k)}>
              {DECISION_KIND_LABEL[k]}
            </button>
          ))}
        </div>
      </div>

      {kind === 'approval' && (
        <div className="field">
          <span>Approval of</span>
          <div className="dc-seg" role="group" aria-label="Approval of">
            {(['client', 'material'] as const).map((a) => (
              <button key={a} type="button" className={approvalKind === a ? 'on' : ''} aria-pressed={approvalKind === a} onClick={() => setApprovalKind(a)}>
                {a === 'client' ? 'Client approval' : 'Material approval'}
              </button>
            ))}
          </div>
        </div>
      )}

      {kind === 'revision' && (
        <div className="two">
          <label className="field">
            <span>Revision round</span>
            <input type="number" inputMode="numeric" min={1} max={50} value={round} onChange={(e) => setRound(e.target.value)} />
          </label>
          <label className="field">
            <span>Raised by</span>
            <select value={raisedBy} onChange={(e) => setRaisedBy(e.target.value as 'client' | 'internal')}>
              <option value="client">Client</option>
              <option value="internal">Internal</option>
            </select>
          </label>
        </div>
      )}
      {kind === 'revision' && !d && <p className="muted small">Round {suggested} suggested: one after the last revision on this project.</p>}

      <label className="field">
        <span>{kind === 'site_instruction' ? 'Instruction' : kind === 'revision' ? 'What changes' : 'Question'}</span>
        <textarea rows={3} value={question} onChange={(e) => setQuestion(e.target.value)} />
      </label>
      <div className="two">
        <label className="field">
          <span>Need by</span>
          <input type="date" value={needBy} onChange={(e) => setNeedBy(e.target.value)} />
        </label>
        <label className="field">
          <span>Cost impact (₹)</span>
          <input type="text" inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} placeholder="None" />
        </label>
      </div>
      <p className="muted small">A cost creates a proposed variation in Money.</p>
      <label className="field">
        <span>Blocks (what waits on it)</span>
        <input type="text" value={blocks} onChange={(e) => setBlocks(e.target.value)} placeholder="e.g. Kitchen carcass production" />
      </label>

      <label className="field">
        <span>Sheet</span>
        <select value={sheet} onChange={(e) => setSheet(e.target.value)}>
          <option value="">No sheet</option>
          {sheets.map((s) => (
            <option key={s.id} value={s.id}>
              {s.number} {s.title}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>BOQ line</span>
        <select value={boq} onChange={(e) => setBoq(e.target.value)}>
          <option value="">No BOQ line</option>
          {boqItems.map((b) => (
            <option key={b.id} value={b.id}>
              {b.item}
              {b.room ? ` · ${b.room}` : ''}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Task</span>
        <select value={task} onChange={(e) => setTask(e.target.value)}>
          <option value="">No task</option>
          {tasks.map((t) => (
            <option key={t.id} value={t.id}>
              {t.stage}. {t.name}
            </option>
          ))}
        </select>
      </label>
      {(p.raw.logs.length > 0 || log) && (
        <label className="field">
          <span>From site log (optional)</span>
          <select value={log} onChange={(e) => setLog(e.target.value)}>
            <option value="">None</option>
            {p.raw.logs.map((l) => (
              <option key={l.id} value={l.id}>
                {formatDay(l.logged_at.slice(0, 10))} {l.room ? `${l.room} · ` : ''}
                {(l.note || 'Voice or photo log').slice(0, 40)}
              </option>
            ))}
          </select>
        </label>
      )}

      <label className="field">
        <span>Answer</span>
        <textarea rows={3} value={answer} onChange={(e) => setAnswer(e.target.value)} />
      </label>
      <div className="two">
        <label className="field">
          <span>Decided by</span>
          <input type="text" value={decidedBy} onChange={(e) => setDecidedBy(e.target.value)} placeholder="e.g. Mr Shah" />
        </label>
        <label className="field">
          <span>Decided on</span>
          <input type="date" value={decidedOn} disabled={status === 'open'} onChange={(e) => setDecidedOn(e.target.value)} />
        </label>
      </div>

      <div className="field">
        <span>Status</span>
        <div className="dc-seg dc-steps" role="group" aria-label="Status">
          {DECISION_STEPS.map((s, i) => (
            <button
              key={s}
              type="button"
              className={status === s ? 'on' : DECISION_STEPS.indexOf(status) > i ? 'past' : ''}
              aria-pressed={status === s}
              onClick={() => {
                setStatus(s)
                if (s !== 'open' && !decidedOn) setDecidedOn(todayLocal())
              }}
            >
              {STATUS_LABEL[s]}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="button-row">
        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Saving' : d ? 'Save' : 'Add decision'}
        </button>
        <button type="button" className="secondary" onClick={p.onCancel}>
          Cancel
        </button>
      </div>
      {d && p.owner && !confirmRemove && (
        <button type="button" className="link left" onClick={() => setConfirmRemove(true)}>
          Remove this decision
        </button>
      )}
      {d && p.owner && confirmRemove && (
        <div className="confirm stack">
          <p className="small">Remove this decision? It can be restored.</p>
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
