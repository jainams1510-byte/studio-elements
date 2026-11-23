import { useState } from 'react'
import { saveFile } from '../../backup'
import { FEE_STAGES, type FeeProposal } from '../../domain'
import { feeBasis, feeChecks, feeTotal, milestoneAmounts, stageAmounts, withGst, type FeeInputs } from '../../feeMath'
import { amountInWords, inr, num } from '../../format'
import { loadLogo, proposalDocx, proposalPdf } from '../../fees/exportDocs'
import { proposalFileName, type ProposalInput } from '../../fees/proposal'
import { supabase } from '../../supabase'
import type { FeesData } from './FeesTab'
import { NumField, errorText } from './parts'

export type ProposalDraft = FeeInputs & { legal_reviewed: boolean }

export const DEFAULT_MILESTONES = [
  { name: 'Appointment and commencement', pct: 20 },
  { name: 'Concept approval', pct: 30 },
  { name: 'Working drawing issue', pct: 30 },
  { name: 'Final handover', pct: 20 },
]

export function draftFrom(p: FeeProposal | null): ProposalDraft {
  return {
    method: p?.method ?? 'fixed',
    fixed_fee: p?.fixed_fee != null ? num(p.fixed_fee) : null,
    percent: p?.percent != null ? num(p.percent) : null,
    rate_psf: p?.rate_psf != null ? num(p.rate_psf) : null,
    stage_pct: (p?.stage_pct ?? [20, 30, 30, 20]).map(num),
    stage_override: (p?.stage_override ?? [null, null, null, null]).map((v) => (v == null ? null : num(v))),
    milestones: (p?.milestones ?? DEFAULT_MILESTONES).map((m) => ({ name: m.name, pct: num(m.pct) })),
    legal_reviewed: p?.legal_reviewed ?? false,
  }
}

const METHODS: [FeeInputs['method'], string][] = [
  ['fixed', 'Fixed fee'],
  ['percent', '% of client budget'],
  ['per_sqft', 'Per sq. ft.'],
]

export default function ProposalSection({
  projectId, data, gstRate, termsDays, readOnly, onSaved,
}: {
  projectId: string
  data: FeesData
  gstRate: number
  termsDays: number
  readOnly: boolean
  onSaved: () => Promise<void>
}) {
  const [d, setD] = useState<ProposalDraft>(() => draftFrom(data.proposal))
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const brief = data.brief
  const ctx = { client_budget: brief?.client_budget ?? null, area: brief?.area ?? null, area_unit: brief?.area_unit ?? 'sq. ft.' }
  const total = feeTotal(d, ctx)
  const stages = stageAmounts(d, total)
  const checks = feeChecks(d, total)
  const { gst, total: payable } = withGst(total, gstRate)
  const miles = milestoneAmounts(d, total)
  const set = (patch: Partial<ProposalDraft>) => {
    setNote(null)
    setD((x) => ({ ...x, ...patch }))
  }

  const missing: string[] = []
  if (d.method === 'percent' && !num(brief?.client_budget)) missing.push('the client budget')
  if (d.method === 'per_sqft' && !num(brief?.area)) missing.push('the project area')

  function row(): FeeProposal {
    return {
      project_id: projectId, method: d.method, fixed_fee: d.fixed_fee, percent: d.percent, rate_psf: d.rate_psf,
      stage_pct: d.stage_pct.map(num), stage_override: d.stage_override, milestones: d.milestones.map((m) => ({ name: m.name.trim(), pct: num(m.pct) })),
      legal_reviewed: d.legal_reviewed,
    }
  }

  async function save(agree: boolean) {
    setBusy(agree ? 'agree' : 'save')
    setError(null)
    setNote(null)
    const { error: e1 } = await supabase.from('fee_proposals').upsert(row(), { onConflict: 'project_id' })
    let e2 = null
    if (!e1 && agree) {
      const res = await supabase
        .from('project_fees')
        .upsert({ project_id: projectId, fee_amount: total, gst_rate: gstRate, payment_terms_days: termsDays }, { onConflict: 'project_id' })
      e2 = res.error
    }
    setBusy(null)
    const err = errorText(e1 ?? e2)
    if (err) return setError(err)
    setNote(agree ? `Saved. The agreed fee is now ${inr(total)} before GST.` : 'Proposal saved.')
    await onSaved()
  }

  async function exportDoc(kind: 'docx' | 'pdf') {
    setBusy(kind)
    setError(null)
    try {
      const input: ProposalInput = { projectName: data.projectName, brief, proposal: d, gstRate, studio: data.settings }
      const logo = await loadLogo(data.settings.logo_path)
      const blob = kind === 'docx' ? await proposalDocx(input, logo) : await proposalPdf(input, logo)
      await saveFile(blob, proposalFileName(data.projectName, kind))
    } catch (err) {
      setError(`Could not make the ${kind.toUpperCase()}: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="stack fees-proposal" aria-label="Fee proposal">
      <div className="card stack">
        <h2>Fee method</h2>
        <div className="chips" role="group" aria-label="Fee method">
          {METHODS.map(([m, label]) => (
            <button key={m} type="button" className={d.method === m ? 'chip on' : 'chip'} aria-pressed={d.method === m} disabled={readOnly} onClick={() => set({ method: m })}>
              {label}
            </button>
          ))}
        </div>
        {d.method === 'fixed' && <NumField label="Fixed fee (₹)" value={d.fixed_fee} disabled={readOnly} onChange={(v) => set({ fixed_fee: v })} />}
        {d.method === 'percent' && (
          <>
            <NumField label="Percentage of client budget (%)" value={d.percent} disabled={readOnly} onChange={(v) => set({ percent: v })} />
            <p className="muted small">Client budget: {num(brief?.client_budget) ? inr(num(brief?.client_budget)) : 'not set'}</p>
          </>
        )}
        {d.method === 'per_sqft' && (
          <>
            <NumField label="Rate per sq. ft. (₹)" value={d.rate_psf} disabled={readOnly} onChange={(v) => set({ rate_psf: v })} />
            <p className="muted small">Area: {num(brief?.area) ? `${num(brief?.area)} ${brief?.area_unit}` : 'not set'}</p>
          </>
        )}
        {missing.length > 0 && (
          <p className="notice" role="status">
            Needed for this method: {missing.join(' and ')}. Add it to the project brief.
          </p>
        )}
        <p className="muted small fees-basis">Basis: {feeBasis(d, ctx, inr)}. Only the selected method is applied.</p>
      </div>

      <div className="card stack">
        <h2>Stages</h2>
        <ul className="fees-stages">
          {FEE_STAGES.map((name, i) => (
            <li key={name} className="fees-stage">
              <span className="small fees-stage-name">{name}</span>
              <div className="fees-stage-grid">
                <NumField label="%" value={d.stage_pct[i]} disabled={readOnly} onChange={(v) => set({ stage_pct: d.stage_pct.map((x, k) => (k === i ? num(v) : x)) })} />
                <NumField
                  label="Override ₹"
                  placeholder="auto"
                  value={d.stage_override[i]}
                  disabled={readOnly}
                  onChange={(v) => set({ stage_override: d.stage_override.map((x, k) => (k === i ? v : x)) })}
                />
                <div className="fees-amount">
                  <span className="muted small">Fee</span>
                  <b data-testid={`stage-${i + 1}`}>{inr(stages[i])}</b>
                </div>
              </div>
            </li>
          ))}
        </ul>
        <div className="row-line fees-total-line">
          <span>Total professional fee (before tax)</span>
          <b data-testid="fee-total">{inr(total)}</b>
        </div>
        {checks.stagesReconcile ? (
          <p className="fees-ok small">Stage fees reconcile with the total.</p>
        ) : (
          <p className="error" role="alert">
            Stage fees add up to {inr(checks.stageSum)}, which differs from the total by {inr(checks.stageSum - total)}. Adjust percentages or overrides.
          </p>
        )}
      </div>

      <div className="card stack fees-payable">
        <p>
          <b className="nowrap">{inr(total)}</b> plus GST {num(gstRate)}% <span className="nowrap">{inr(gst)}</span> = <b className="nowrap" data-testid="fee-payable">{inr(payable)}</b>
        </p>
        <p className="muted small" data-testid="fee-words">
          In words: Rupees {amountInWords(total)} Only (fee before GST). Reimbursables billed at actuals with prior approval, as in the reference proposal.
        </p>
        <p className="muted small">GST rate comes from the agreed fee settings below.</p>
      </div>

      <div className="card stack">
        <h2>Payment milestones</h2>
        <ul className="stack-tight">
          {d.milestones.map((m, i) => (
            <li key={i} className="fees-mile">
              <label className="field fees-mile-name">
                <span>Milestone {i + 1}</span>
                <input value={m.name} disabled={readOnly} onChange={(e) => set({ milestones: d.milestones.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)) })} />
              </label>
              <div className="fees-mile-grid">
                <NumField label="%" value={m.pct} disabled={readOnly} onChange={(v) => set({ milestones: d.milestones.map((x, k) => (k === i ? { ...x, pct: num(v) } : x)) })} />
                <div className="fees-amount">
                  <span className="muted small">Amount</span>
                  <b>{inr(miles[i]?.amount ?? 0)}</b>
                </div>
                {!readOnly && (
                  <button type="button" className="pill" aria-label={`Remove milestone ${i + 1}`} onClick={() => set({ milestones: d.milestones.filter((_, k) => k !== i) })}>
                    Remove
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
        {!readOnly && (
          <button type="button" className="secondary" onClick={() => set({ milestones: [...d.milestones, { name: '', pct: 0 }] })}>
            Add a milestone
          </button>
        )}
        {checks.milestonesTotal100 ? (
          <p className="fees-ok small">Milestones total 100%.</p>
        ) : (
          <p className="error" role="alert">
            Milestones total {checks.milestonePct}%, not 100%.
          </p>
        )}
      </div>

      <div className="card stack">
        <label className="check">
          <input type="checkbox" checked={d.legal_reviewed} disabled={readOnly} onChange={(e) => set({ legal_reviewed: e.target.checked })} />
          Contract clauses reviewed by a legal professional
        </label>
        <p className="muted small">
          The agreement text (termination, liability, arbitration, jurisdiction) must be reviewed before signing. Clause text comes from the studio
          clause library and is used as written in the reference proposal. Exports always carry the DRAFT note and show missing details in red.
        </p>
      </div>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {note && <p className="notice">{note}</p>}
      {!readOnly && (
        <div className="stack-tight">
          <button type="button" className="primary" disabled={busy !== null} onClick={() => save(true)}>
            {busy === 'agree' ? 'Saving' : 'Use as the agreed fee'}
          </button>
          <button type="button" className="secondary" disabled={busy !== null} onClick={() => save(false)}>
            {busy === 'save' ? 'Saving' : 'Save proposal'}
          </button>
        </div>
      )}
      <div className="button-row">
        <button type="button" className="secondary" disabled={busy !== null} onClick={() => exportDoc('docx')}>
          {busy === 'docx' ? 'Making' : 'Export DOCX'}
        </button>
        <button type="button" className="secondary" disabled={busy !== null} onClick={() => exportDoc('pdf')}>
          {busy === 'pdf' ? 'Making' : 'Export PDF'}
        </button>
      </div>
      <p className="muted small">Exports are drafts on this phone; nothing is sent. Check them, then share them yourself.</p>
    </section>
  )
}
