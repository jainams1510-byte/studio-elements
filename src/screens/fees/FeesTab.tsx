import { useState } from 'react'
import {
  BRIEF_SELECT, COST_SELECT, FEE_SELECT, INVOICE_SELECT, PROPOSAL_SELECT, SETTINGS_SELECT, VENDOR_SELECT,
  type FeeInvoice, type FeeProposal, type ProjectBrief, type ProjectFee, type StudioCost, type StudioSettings, type Vendor,
} from '../../domain'
import { inrShort, num } from '../../format'
import { invoiceTotals } from '../../fees/invoices'
import { margin, sum } from '../../fees/money'
import { one, rows, useLoad } from '../../fees/useLoad'
import { supabase } from '../../supabase'
import { isOwner, useTeam } from '../../team'
import { useSchedule } from '../../useSchedule'
import CostsSection from './CostsSection'
import InvoicesSection from './InvoicesSection'
import ProposalSection from './ProposalSection'
import { DEFAULT_SETTINGS, OwnerOnly, Tile } from './parts'

export type FeesData = {
  projectName: string
  projectCode: string | null
  brief: ProjectBrief | null
  proposal: FeeProposal | null
  fee: ProjectFee | null
  invoices: FeeInvoice[]
  costs: StudioCost[]
  vendors: Vendor[]
  settings: StudioSettings
}

async function loadFees(projectId: string): Promise<FeesData> {
  const [p, b, pr, f, i, c, v, s] = await Promise.all([
    supabase.from('projects').select('id, name, code').eq('id', projectId).maybeSingle(),
    supabase.from('project_briefs').select(BRIEF_SELECT).eq('project_id', projectId).maybeSingle(),
    supabase.from('fee_proposals').select(PROPOSAL_SELECT).eq('project_id', projectId).maybeSingle(),
    supabase.from('project_fees').select(FEE_SELECT).eq('project_id', projectId).maybeSingle(),
    supabase.from('fee_invoices').select(INVOICE_SELECT).eq('project_id', projectId).order('sort_order'),
    supabase.from('studio_costs').select(COST_SELECT).eq('project_id', projectId).order('spent_on'),
    supabase.from('vendors').select(VENDOR_SELECT).order('name'),
    supabase.from('studio_settings').select(SETTINGS_SELECT).limit(1).maybeSingle(),
  ])
  const project = one<{ name: string; code: string | null }>(p)
  return {
    projectName: project?.name ?? 'Project',
    projectCode: project?.code ?? null,
    brief: one<ProjectBrief>(b),
    proposal: one<FeeProposal>(pr),
    fee: one<ProjectFee>(f),
    invoices: rows<FeeInvoice>(i),
    costs: rows<StudioCost>(c),
    vendors: v.error ? [] : ((v.data ?? []) as unknown as Vendor[]),
    // Settings only dress the documents: the defaults stand in if they cannot be read.
    settings: { ...DEFAULT_SETTINGS, ...((s.error ? null : (s.data as StudioSettings | null)) ?? {}), clauses: (s.data as StudioSettings | null)?.clauses ?? {} },
  }
}

type Section = 'proposal' | 'invoices' | 'costs'

/** Project → Fees (owners): fee proposal, agreed fee, invoices, studio costs and margin. */
export default function FeesTab({ projectId }: { projectId: string }) {
  const { me } = useTeam()
  const owner = isOwner(me)
  const sched = useSchedule(projectId)
  const load = useLoad<FeesData>(`fees:${projectId}`, () => loadFees(projectId), owner)
  const [section, setSection] = useState<Section | null>(null)

  if (!me) return <p className="muted">Loading</p>
  if (!owner) return <OwnerOnly what="Fees are" />
  const data = load.data
  if (!data) {
    if (load.state === 'offline') return <p className="notice">No signal. Fees have not been opened on this phone yet.</p>
    return <p className="muted">Loading</p>
  }

  const readOnly = load.state !== 'ready'
  const fee = num(data.fee?.fee_amount)
  const live = data.invoices.filter((i) => !i.removed_at)
  const received = sum(live.filter((i) => i.status === 'paid').map((i) => num(i.paid_amount)))
  const outstanding = sum(live.filter((i) => i.status === 'raised').map((i) => invoiceTotals(i).total))
  const m = margin(fee, data.costs)
  const shown: Section = section ?? (data.fee || live.length ? 'invoices' : 'proposal')
  const reload = load.reload

  return (
    <section className="stack fees">
      {readOnly && <p className="notice">No signal. Showing fees as last seen on this phone (read-only). Changes need a connection.</p>}
      {load.error && <p className="error">{load.error}</p>}

      <div className="tiles fees-tiles" aria-label="Fee summary">
        <Tile value={data.fee ? inrShort(fee) : '—'} label="Agreed fee (before GST)" />
        <Tile value={inrShort(received)} label="Received" />
        <Tile value={inrShort(outstanding)} label="Raised, unpaid" />
        <Tile value={m.forecastPct === null ? '—' : `${m.forecastPct}%`} label="Margin (forecast)" tone={m.forecastPct !== null && m.forecastPct < 10 ? 'danger' : undefined} />
      </div>

      <div className="chips" role="group" aria-label="Fees sections">
        {(
          [
            ['proposal', 'Proposal'],
            ['invoices', `Invoices ${live.length}`],
            ['costs', 'Costs and margin'],
          ] as const
        ).map(([id, label]) => (
          <button key={id} type="button" className={shown === id ? 'chip on' : 'chip'} aria-pressed={shown === id} onClick={() => setSection(id)}>
            {label}
          </button>
        ))}
      </div>

      {shown === 'proposal' && <ProposalSection key={`p-${load.state}-${data.proposal ? 1 : 0}`} projectId={projectId} data={data} gstRate={data.fee ? num(data.fee.gst_rate) : 18} termsDays={data.fee ? num(data.fee.payment_terms_days) : 7} readOnly={readOnly} onSaved={async () => { setSection('proposal'); await reload() }} />}
      {shown === 'invoices' && (
        <InvoicesSection
          key={`i-${load.state}-${data.fee?.fee_amount}-${data.fee?.gst_rate}-${data.fee?.payment_terms_days}`}
          projectId={projectId}
          data={data}
          sched={sched}
          readOnly={readOnly}
          reload={async () => {
            await Promise.all([reload(), sched.reload()])
          }}
        />
      )}
      {shown === 'costs' && <CostsSection projectId={projectId} data={data} readOnly={readOnly} reload={reload} />}
    </section>
  )
}
