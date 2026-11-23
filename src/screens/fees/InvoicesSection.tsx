import { useState } from 'react'
import { saveFile } from '../../backup'
import { todayLocal } from '../../drawings'
import type { FeeInvoice } from '../../domain'
import { inr, inrExact, longDate, num } from '../../format'
import { invoiceFileName, invoicePdf, loadLogo } from '../../fees/exportDocs'
import {
  DEFAULT_GST, DEFAULT_TERMS_DAYS, STATUS_LABEL, dueOnRaise, invoiceDue, invoicesFromMilestones, invoiceTotals,
  milestoneReached, nextInvoiceNo, overdueDays, type DueInfo,
} from '../../fees/invoices'
import { isMilestone } from '../../schedule'
import { supabase } from '../../supabase'
import type { ScheduleData } from '../../useSchedule'
import type { FeesData } from './FeesTab'
import { NumField, errorText } from './parts'
import { DEFAULT_MILESTONES } from './ProposalSection'

type Open = { id: string; mode: 'raise' | 'paid' | 'edit' } | null

export default function InvoicesSection({
  projectId, data, sched, readOnly, reload,
}: {
  projectId: string
  data: FeesData
  sched: ScheduleData
  readOnly: boolean
  reload: () => Promise<void>
}) {
  const fee = data.fee
  const feeAmount = num(fee?.fee_amount)
  const gstRate = fee ? num(fee.gst_rate) : DEFAULT_GST
  const terms = fee ? num(fee.payment_terms_days) : DEFAULT_TERMS_DAYS
  const [feeForm, setFeeForm] = useState({ fee_amount: fee ? feeAmount : null, gst_rate: gstRate as number | null, payment_terms_days: terms as number | null })
  const [open, setOpen] = useState<Open>(null)
  const [confirmMore, setConfirmMore] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const today = todayLocal()

  const milestones = sched.tasks.filter((t) => !t.removed_at && isMilestone(t))
  const endOf = (taskId: string) => sched.result?.tasks[taskId]?.end ?? null
  const done = new Set(sched.tasks.filter((t) => t.status === 'done' && !t.removed_at).map((t) => t.id))
  const live = data.invoices.filter((i) => !i.removed_at).sort((a, b) => a.sort_order - b.sort_order)
  const removed = data.invoices.filter((i) => i.removed_at)
  const sourceMilestones = data.proposal?.milestones ?? DEFAULT_MILESTONES
  const milePct = sourceMilestones.reduce((a, m) => a + num(m.pct), 0)

  async function act(run: () => PromiseLike<{ error: { message: string } | null }>) {
    setBusy(true)
    setError(null)
    const { error: e } = await run()
    setBusy(false)
    const msg = errorText(e)
    if (msg) {
      setError(msg)
      return false
    }
    setOpen(null)
    await reload()
    return true
  }

  async function saveFee() {
    if (feeForm.fee_amount == null || feeForm.fee_amount < 0) return setError('Enter the agreed fee.')
    const g = num(feeForm.gst_rate)
    const t = num(feeForm.payment_terms_days)
    if (g < 0 || g > 28) return setError('GST must be between 0 and 28%.')
    if (t < 0 || t > 180) return setError('Payment terms must be between 0 and 180 days.')
    await act(() =>
      supabase.from('project_fees').upsert({ project_id: projectId, fee_amount: feeForm.fee_amount, gst_rate: g, payment_terms_days: Math.round(t) }, { onConflict: 'project_id' }),
    )
  }

  async function createFromMilestones(force: boolean) {
    setError(null)
    if (!feeAmount) return setError('Set the agreed fee first (above, or "Use as the agreed fee" in the proposal).')
    if (Math.abs(milePct - 100) > 0.01) return setError(`The proposal's milestones total ${milePct}%, not 100%. Fix them in the proposal first.`)
    if (live.length && !force) return setConfirmMore(true)
    setConfirmMore(false)
    const first = live.reduce((m, i) => Math.max(m, i.sort_order + 1), 0)
    await act(() => supabase.from('fee_invoices').insert(invoicesFromMilestones(projectId, feeAmount, gstRate, sourceMilestones, first)))
  }

  return (
    <section className="stack" aria-label="Agreed fee and invoices">
      <div className="card stack">
        <h2>Agreed fee</h2>
        <NumField label="Fee before GST (₹)" value={feeForm.fee_amount} disabled={readOnly} onChange={(v) => setFeeForm({ ...feeForm, fee_amount: v })} />
        <div className="two">
          <NumField label="GST %" value={feeForm.gst_rate} disabled={readOnly} onChange={(v) => setFeeForm({ ...feeForm, gst_rate: v })} />
          <NumField label="Payment terms (days)" step="1" value={feeForm.payment_terms_days} disabled={readOnly} onChange={(v) => setFeeForm({ ...feeForm, payment_terms_days: v })} />
        </div>
        {!readOnly && (
          <button type="button" className="secondary" disabled={busy} onClick={saveFee}>
            Save agreed fee
          </button>
        )}
      </div>

      <div className="stack-tight">
        <h2>Invoices</h2>
        {!readOnly && (
          <>
            <button type="button" className="secondary" disabled={busy} onClick={() => createFromMilestones(false)}>
              Create invoices from milestones
            </button>
            <p className="muted small">
              Uses the agreed fee ({inr(feeAmount)}) and the {data.proposal ? 'saved proposal’s' : 'default'} payment milestones ({sourceMilestones.length}).
            </p>
          </>
        )}
        {confirmMore && (
          <div className="confirm stack-tight" role="alertdialog" aria-label="Invoices already exist">
            <p>
              {live.length} invoice{live.length === 1 ? '' : 's'} already exist. Add another {sourceMilestones.length}?
            </p>
            <div className="button-row">
              <button type="button" className="primary" onClick={() => createFromMilestones(true)}>
                Add them
              </button>
              <button type="button" className="secondary" onClick={() => setConfirmMore(false)}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {live.length === 0 && <p className="muted">No invoices yet.</p>}
      <ul className="stack">
        {live.map((inv) => {
          const due = invoiceDue(inv, endOf, terms)
          return (
            <InvoiceCard
              key={inv.id}
              inv={inv}
              due={due}
              terms={terms}
              late={overdueDays(inv, due.due, today)}
              reached={milestoneReached(inv, done)}
              milestones={milestones.map((t) => ({ id: t.id, name: t.name, end: endOf(t.id) }))}
              open={open?.id === inv.id ? open.mode : null}
              setOpen={(mode) => setOpen(mode ? { id: inv.id, mode } : null)}
              readOnly={readOnly}
              busy={busy}
              act={act}
              data={data}
              suggestNo={nextInvoiceNo(data.invoices.map((i) => i.invoice_no), data.projectCode || 'SE')}
              setError={setError}
            />
          )
        })}
      </ul>

      {removed.length > 0 && (
        <details>
          <summary className="small">Removed invoices ({removed.length})</summary>
          <ul className="rows">
            {removed.map((inv) => (
              <li key={inv.id} className="row-line padded">
                <span className="small">
                  {inv.milestone} · {inrExact(invoiceTotals(inv).total)}
                </span>
                {!readOnly && (
                  <button type="button" className="pill" onClick={() => act(() => supabase.from('fee_invoices').update({ removed_at: null }).eq('id', inv.id))}>
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

function InvoiceCard({
  inv, due, terms, late, reached, milestones, open, setOpen, readOnly, busy, act, data, suggestNo, setError,
}: {
  inv: FeeInvoice
  due: DueInfo
  terms: number
  late: number
  reached: boolean
  milestones: { id: string; name: string; end: string | null }[]
  open: 'raise' | 'paid' | 'edit' | null
  setOpen: (m: 'raise' | 'paid' | 'edit' | null) => void
  readOnly: boolean
  busy: boolean
  act: (run: () => PromiseLike<{ error: { message: string } | null }>) => Promise<boolean>
  data: FeesData
  suggestNo: string
  setError: (s: string | null) => void
}) {
  const { amount, gst, total } = invoiceTotals(inv)
  const today = todayLocal()
  const [raise, setRaise] = useState({ no: inv.invoice_no || suggestNo, on: today, due: dueOnRaise(due.due, today, terms) })
  const [paid, setPaid] = useState({ on: today, amount: total as number | null })
  const [edit, setEdit] = useState({ milestone: inv.milestone, amount: amount as number | null, gst: num(inv.gst_rate) as number | null, task: inv.task_id ?? '', due: inv.due_date ?? '', note: inv.note ?? '' })
  const [pdfBusy, setPdfBusy] = useState(false)
  const linked = milestones.find((m) => m.id === inv.task_id)
  const upd = (patch: Record<string, unknown>) => act(() => supabase.from('fee_invoices').update(patch).eq('id', inv.id))

  async function pdf() {
    setPdfBusy(true)
    setError(null)
    try {
      const logo = await loadLogo(data.settings.logo_path)
      const blob = await invoicePdf({ projectName: data.projectName, brief: data.brief, invoice: inv, due: due.due, studio: data.settings }, logo)
      await saveFile(blob, invoiceFileName(data.projectName, inv))
    } catch (err) {
      setError(`Could not make the PDF: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setPdfBusy(false)
    }
  }

  return (
    <li className="card stack-tight fees-invoice" data-status={inv.status}>
      <div className="card-head">
        <strong className="row-title">{inv.milestone}</strong>
        <span className={inv.status === 'paid' ? 'tag ok' : inv.status === 'raised' ? 'tag' : 'tag muted'}>{STATUS_LABEL[inv.status]}</span>
      </div>
      <p className="small">
        <span className="nowrap">{inrExact(amount)}</span> + GST {num(inv.gst_rate)}% <span className="nowrap">{inrExact(gst)}</span> ={' '}
        <b className="nowrap" data-testid="invoice-total">{inrExact(total)}</b>
      </p>
      <p className="muted small" data-testid="invoice-due">
        {due.due
          ? `Due ${longDate(due.due)}${due.source === 'milestone' ? ` (milestone forecast ${longDate(due.milestoneEnd)} + ${terms} days)` : ''}`
          : 'No due date yet: link a schedule milestone or enter a date.'}
        {linked && due.source !== 'milestone' ? ` · Milestone: ${linked.name}` : ''}
      </p>
      {inv.status !== 'scheduled' && (
        <p className="muted small">
          Raised {inv.invoice_no ? `${inv.invoice_no} ` : ''}on {longDate(inv.raised_on)}
          {inv.status === 'paid' && (
            <>
              {' · Paid '}
              <span className="nowrap">{inrExact(num(inv.paid_amount))}</span> on {longDate(inv.paid_on)}
            </>
          )}
        </p>
      )}
      {late > 0 && (
        <p>
          <span className="htag late">Overdue {late} day{late === 1 ? '' : 's'}</span>
        </p>
      )}
      {reached && <p className="flag small">Milestone reached — raise the invoice</p>}

      {!readOnly && open === 'raise' && (
        <div className="stack-tight fees-form">
          <label className="field">
            <span>Invoice no.</span>
            <input value={raise.no} onChange={(e) => setRaise({ ...raise, no: e.target.value })} />
          </label>
          <div className="two">
            <label className="field">
              <span>Invoice date</span>
              <input type="date" value={raise.on} onChange={(e) => setRaise({ ...raise, on: e.target.value })} />
            </label>
            <label className="field">
              <span>Due date</span>
              <input type="date" value={raise.due} onChange={(e) => setRaise({ ...raise, due: e.target.value })} />
            </label>
          </div>
          <div className="button-row">
            <button
              type="button"
              className="primary"
              disabled={busy || !raise.no.trim() || !raise.on}
              onClick={() => upd({ status: 'raised', invoice_no: raise.no.trim(), raised_on: raise.on, due_date: raise.due || null })}
            >
              Save as raised
            </button>
            <button type="button" className="secondary" onClick={() => setOpen(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {!readOnly && open === 'paid' && (
        <div className="stack-tight fees-form">
          <div className="two">
            <label className="field">
              <span>Paid on</span>
              <input type="date" value={paid.on} onChange={(e) => setPaid({ ...paid, on: e.target.value })} />
            </label>
            <NumField label="Amount received (₹)" value={paid.amount} onChange={(v) => setPaid({ ...paid, amount: v })} />
          </div>
          <p className="muted small">Default is the total including GST.</p>
          <div className="button-row">
            <button type="button" className="primary" disabled={busy || !paid.on} onClick={() => upd({ status: 'paid', paid_on: paid.on, paid_amount: paid.amount ?? total })}>
              Save as paid
            </button>
            <button type="button" className="secondary" onClick={() => setOpen(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {!readOnly && open === 'edit' && (
        <div className="stack-tight fees-form">
          <label className="field">
            <span>Milestone</span>
            <input value={edit.milestone} onChange={(e) => setEdit({ ...edit, milestone: e.target.value })} />
          </label>
          <div className="two">
            <NumField label="Amount before GST (₹)" value={edit.amount} onChange={(v) => setEdit({ ...edit, amount: v })} />
            <NumField label="GST %" value={edit.gst} onChange={(v) => setEdit({ ...edit, gst: v })} />
          </div>
          <label className="field">
            <span>Schedule milestone</span>
            <select value={edit.task} onChange={(e) => setEdit({ ...edit, task: e.target.value })}>
              <option value="">Not linked (enter a due date)</option>
              {milestones.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                  {m.end ? ` · ${longDate(m.end)}` : ''}
                </option>
              ))}
            </select>
          </label>
          {milestones.length === 0 && <p className="muted small">The schedule has no milestones yet.</p>}
          <label className="field">
            <span>{edit.task ? 'Due date if the milestone has no date' : 'Due date'}</span>
            <input type="date" value={edit.due} onChange={(e) => setEdit({ ...edit, due: e.target.value })} />
          </label>
          <label className="field">
            <span>Note</span>
            <input value={edit.note} onChange={(e) => setEdit({ ...edit, note: e.target.value })} />
          </label>
          <div className="button-row">
            <button
              type="button"
              className="primary"
              disabled={busy || !edit.milestone.trim()}
              onClick={() =>
                upd({ milestone: edit.milestone.trim(), amount: num(edit.amount), gst_rate: num(edit.gst), task_id: edit.task || null, due_date: edit.due || null, note: edit.note })
              }
            >
              Save
            </button>
            <button type="button" className="secondary" onClick={() => setOpen(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {open === null && (
        <div className="fees-actions">
          {!readOnly && inv.status === 'scheduled' && (
            <button
              type="button"
              className="pill"
              onClick={() => {
                setRaise({ no: inv.invoice_no || suggestNo, on: today, due: dueOnRaise(due.due, today, terms) })
                setOpen('raise')
              }}
            >
              Raise
            </button>
          )}
          {!readOnly && inv.status === 'raised' && (
            <button
              type="button"
              className="pill"
              onClick={() => {
                setPaid({ on: today, amount: total })
                setOpen('paid')
              }}
            >
              Mark paid
            </button>
          )}
          {!readOnly && (
            <button type="button" className="pill" onClick={() => setOpen('edit')}>
              Edit
            </button>
          )}
          <button type="button" className="pill" disabled={pdfBusy} onClick={pdf}>
            {pdfBusy ? 'Making' : 'PDF'}
          </button>
          {!readOnly && inv.status !== 'scheduled' && (
            <button
              type="button"
              className="pill"
              onClick={() => upd(inv.status === 'paid' ? { status: 'raised', paid_on: null, paid_amount: null } : { status: 'scheduled', raised_on: null })}
            >
              Undo {inv.status === 'paid' ? 'paid' : 'raise'}
            </button>
          )}
          {!readOnly && (
            <button type="button" className="pill" onClick={() => upd({ removed_at: new Date().toISOString() })}>
              Remove
            </button>
          )}
        </div>
      )}
    </li>
  )
}
