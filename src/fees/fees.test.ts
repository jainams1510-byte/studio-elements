import { describe, expect, it } from 'vitest'
import type { FeeInvoice, ProcurementItem, ProjectBrief, ProjectFee, RaBill, StudioCost } from '../domain'
import { CLAUSE_TITLES } from '../clauses'
import { feeDrafts } from './drafts'
import { invoiceDue, invoicesFromMilestones, invoiceTotals, milestoneReached, nextInvoiceNo, overdueDays, storedOrTermsDue } from './invoices'
import { cashFlow, margin, mondayOf } from './money'
import { coverRows, proposalBlocks, proposalFileName, TBC, type ProposalInput } from './proposal'
import { billTotal, duplicateVendor, vendorStats, whatsappDigits } from './vendors'
import { invoiceLines, rupeesInWords } from './exportDocs'

function inv(id: string, extra: Partial<FeeInvoice> = {}): FeeInvoice {
  return {
    id, project_id: 'p', milestone: `M ${id}`, task_id: null, amount: 30000, gst_rate: 18, due_date: null, status: 'scheduled',
    invoice_no: null, raised_on: null, paid_on: null, paid_amount: null, note: '', sort_order: 0, removed_at: null, ...extra,
  }
}
function cost(id: string, amount: number, status: 'planned' | 'paid', spent_on = '2026-11-24', extra: Partial<StudioCost> = {}): StudioCost {
  return { id, project_id: 'p', spent_on, category: 'Other', vendor_id: null, amount, status, note: '', removed_at: null, ...extra }
}

describe('invoices from milestones', () => {
  it('splits the agreed fee by milestone % (before GST), in order', () => {
    const rows = invoicesFromMilestones('p', 175000, 18, [
      { name: 'Appointment', pct: 20 }, { name: 'Concept', pct: 30 }, { name: 'Working drawings', pct: 30 }, { name: 'Handover', pct: 20 },
    ], 4)
    expect(rows.map((r) => r.amount)).toEqual([35000, 52500, 52500, 35000])
    expect(rows.map((r) => r.sort_order)).toEqual([4, 5, 6, 7])
    expect(rows.every((r) => r.status === 'scheduled' && r.gst_rate === 18 && r.project_id === 'p')).toBe(true)
  })
  it('rounds to paise and skips blank or 0% milestones', () => {
    const rows = invoicesFromMilestones('p', 155555, 12, [{ name: 'A', pct: 33.33 }, { name: ' ', pct: 10 }, { name: 'B', pct: 0 }])
    expect(rows).toHaveLength(1)
    expect(rows[0].amount).toBe(51846.48) // 155555 × 0.3333 = 51846.4815
  })
  it('totals include GST', () => {
    expect(invoiceTotals({ amount: 35000, gst_rate: 18 })).toEqual({ amount: 35000, gst: 6300, total: 41300 })
  })
})

describe('due dates and flags', () => {
  const ends: Record<string, string> = { t1: '2026-12-10' }
  const end = (id: string) => ends[id]
  it('a scheduled invoice linked to a milestone is due on its forecast end + terms', () => {
    expect(invoiceDue(inv('a', { task_id: 't1', due_date: '2027-01-01' }), end, 7)).toEqual({ due: '2026-12-17', source: 'milestone', milestoneEnd: '2026-12-10' })
    expect(invoiceDue(inv('a', { task_id: 't1' }), end, 30).due).toBe('2027-01-09')
  })
  it('falls back to the stored date when the milestone has no date, and once raised', () => {
    expect(invoiceDue(inv('a', { task_id: 'gone', due_date: '2026-12-31' }), end, 7)).toEqual({ due: '2026-12-31', source: 'stored', milestoneEnd: null })
    expect(invoiceDue(inv('a', { task_id: 't1', status: 'raised', due_date: '2026-12-01' }), end, 7).due).toBe('2026-12-01')
    expect(invoiceDue(inv('a'), end, 7)).toEqual({ due: null, source: 'none', milestoneEnd: null })
  })
  it('counts overdue days only for raised, unpaid, not removed invoices', () => {
    expect(overdueDays(inv('a', { status: 'raised' }), '2026-11-20', '2026-11-25')).toBe(5)
    expect(overdueDays(inv('a', { status: 'raised' }), '2026-11-25', '2026-11-25')).toBe(0)
    expect(overdueDays(inv('a', { status: 'raised' }), '2026-11-30', '2026-11-25')).toBe(0)
    expect(overdueDays(inv('a', { status: 'paid' }), '2026-11-20', '2026-11-25')).toBe(0)
    expect(overdueDays(inv('a', { status: 'scheduled' }), '2026-11-20', '2026-11-25')).toBe(0)
    expect(overdueDays(inv('a', { status: 'raised', removed_at: 'x' }), '2026-11-20', '2026-11-25')).toBe(0)
  })
  it('milestone reached: linked task done and invoice still scheduled', () => {
    const done = new Set(['t1'])
    expect(milestoneReached(inv('a', { task_id: 't1' }), done)).toBe(true)
    expect(milestoneReached(inv('a', { task_id: 't1', status: 'raised' }), done)).toBe(false)
    expect(milestoneReached(inv('a', { task_id: 't2' }), done)).toBe(false)
    expect(milestoneReached(inv('a'), done)).toBe(false)
  })
  it('raised invoices with no stored due date use raised date + terms', () => {
    expect(storedOrTermsDue(inv('a', { raised_on: '2026-11-10' }), { payment_terms_days: 7 })).toBe('2026-11-17')
    expect(storedOrTermsDue(inv('a', { raised_on: '2026-11-10', due_date: '2026-11-12' }), { payment_terms_days: 7 })).toBe('2026-11-12')
  })
  it('suggests the next invoice number', () => {
    expect(nextInvoiceNo(['SE/26-27/007', 'SE/26-27/009', null], 'SE')).toBe('SE/26-27/010')
    expect(nextInvoiceNo([], 'SE')).toBe('SE-001')
  })
})

describe('margin', () => {
  it('to date counts paid costs; forecast adds planned; removed costs are ignored', () => {
    const m = margin(150000, [cost('a', 12000, 'paid'), cost('b', 8000, 'paid'), cost('c', 25000, 'planned'), cost('d', 99999, 'paid', '2026-11-24', { removed_at: 'x' })])
    expect(m).toEqual({ fee: 150000, paidCosts: 20000, plannedCosts: 25000, toDate: 130000, toDatePct: 86.7, forecast: 105000, forecastPct: 70 })
  })
  it('has no percentage without a fee', () => {
    expect(margin(0, [cost('a', 500, 'paid')]).toDatePct).toBeNull()
  })
})

describe('cash-flow forecast', () => {
  it('uses Monday-start weeks', () => {
    expect(mondayOf('2026-11-25')).toBe('2026-11-23')
    expect(mondayOf('2026-11-23')).toBe('2026-11-23')
    expect(mondayOf('2026-11-29')).toBe('2026-11-23') // Sunday
  })
  it('buckets invoices and costs, puts overdue in week 1, runs the balance and flags negative weeks (hand-worked)', () => {
    const lbl = (i: FeeInvoice) => ({ inv: i, due: i.due_date, label: i.milestone })
    const weeks = cashFlow({
      today: '2026-11-25',
      openingCash: 20000,
      invoices: [
        lbl(inv('A', { status: 'raised', due_date: '2026-11-20', amount: 30000 })), // overdue → week 1, 35,400
        lbl(inv('B', { status: 'raised', due_date: '2026-12-02', amount: 50000 })), // week 2, 59,000
        lbl(inv('C', { status: 'scheduled', due_date: '2026-12-14', amount: 20000 })), // Monday of week 4, 23,600
        lbl(inv('D', { status: 'scheduled' })), // no date: left out
        lbl(inv('E', { status: 'paid', due_date: '2026-12-02' })), // paid: left out
        lbl(inv('F', { status: 'raised', due_date: '2027-02-01' })), // after week 8: left out
        lbl(inv('G', { status: 'raised', due_date: '2026-12-02', removed_at: 'x' })), // removed: left out
      ],
      costs: [
        { cost: cost('x', 10000, 'planned', '2026-11-24'), label: 'x' }, // week 1
        { cost: cost('y', 120000, 'planned', '2026-12-06'), label: 'y' }, // Sunday → week 2
        { cost: cost('z', 5000, 'paid', '2026-12-01'), label: 'z' }, // paid: not a future payment
      ],
    })
    expect(weeks).toHaveLength(8)
    expect(weeks[0].start).toBe('2026-11-23')
    expect(weeks[0].end).toBe('2026-11-29')
    expect(weeks[7].start).toBe('2027-01-11')
    expect(weeks.map((w) => w.cashIn)).toEqual([35400, 59000, 0, 23600, 0, 0, 0, 0])
    expect(weeks.map((w) => w.cashOut)).toEqual([10000, 120000, 0, 0, 0, 0, 0, 0])
    expect(weeks.map((w) => w.balance)).toEqual([45400, -15600, -15600, 8000, 8000, 8000, 8000, 8000])
    expect(weeks.map((w) => w.negative)).toEqual([false, true, true, false, false, false, false, false])
    expect(weeks[0].ins[0].overdue).toBe(true)
  })
})

describe('vendors', () => {
  const pi = (id: string, extra: Partial<ProcurementItem>): ProcurementItem => ({
    id, project_id: 'p', item: id, trade: null, room: null, task_id: null, need_by: null, lead_days: 14, vendor_id: 'v1', spec_approved: true,
    status: 'on_site', ordered_on: null, expected_on: null, delivered_on: null, note: '', removed_at: null, ...extra,
  })
  const bill = (id: string, status: RaBill['status'], certified: number | null, extra: Partial<RaBill> = {}): RaBill => ({
    id, project_id: 'p', vendor_id: 'v1', work_order_id: null, bill_no: id, bill_date: '2026-11-01', claimed_amount: 0, certified_amount: certified,
    gst_rate: 18, status, certified_on: null, client_approved_on: null, paid_on: null, paid_amount: null, note: '', file_link: null, removed_at: null, ...extra,
  })
  it('on-time % counts delivered items with an expected date', () => {
    const s = vendorStats('v1', {
      workOrders: [], bills: [], quotes: [],
      procurement: [
        pi('a', { expected_on: '2026-12-01', delivered_on: '2026-11-30' }),
        pi('b', { expected_on: '2026-12-01', delivered_on: '2026-12-01' }),
        pi('c', { expected_on: '2026-12-01', delivered_on: '2026-12-03' }),
        pi('d', { delivered_on: '2026-12-03' }),
        pi('e', { expected_on: '2026-12-01', status: 'ordered' }),
        pi('f', { expected_on: '2026-12-01', delivered_on: '2026-12-09', vendor_id: 'v2' }),
      ],
    })
    expect(s.onTimePct).toBe(67)
    expect(s.delivered).toBe(3)
    expect(vendorStats('v9', { workOrders: [], bills: [], quotes: [], procurement: [] }).onTimePct).toBeNull()
  })
  it('totals bills: certified, paid, and client-approved or certified unpaid with GST', () => {
    const s = vendorStats('v1', {
      workOrders: [{ id: 'w', project_id: 'p', vendor_id: 'v1', quote_id: null, trade: null, amount: 400000, issued_on: '2026-10-01', note: '', file_link: null, removed_at: null }],
      bills: [bill('1', 'paid', 100000, { paid_amount: 118000 }), bill('2', 'client_approved', 50000), bill('3', 'certified', 10000), bill('4', 'measured', null), bill('5', 'paid', 7, { removed_at: 'x' })],
      quotes: [],
      procurement: [],
    })
    expect(s).toMatchObject({ workOrders: 1, workOrderTotal: 400000, certified: 160000, paid: 118000, unpaidBills: 2, unpaidAmount: 70800 })
    expect(billTotal({ certified_amount: 50000, gst_rate: 18 })).toBe(59000)
  })
  it('spots duplicates and builds WhatsApp numbers', () => {
    expect(duplicateVendor('  sharma  interiors ', [{ id: '1', name: 'Sharma  Interiors' }])).toBe(true)
    expect(duplicateVendor('Sharma Interiors', [{ id: '1', name: 'Sharma Interiors' }], '1')).toBe(false)
    expect(whatsappDigits('98250 12345')).toBe('919825012345')
    expect(whatsappDigits('+91 98250-12345')).toBe('919825012345')
    expect(whatsappDigits('09825012345')).toBe('919825012345')
    expect(whatsappDigits('12345')).toBeNull()
  })
})

describe('fee drafts', () => {
  const fees: ProjectFee[] = [{ project_id: 'p', fee_amount: 175000, gst_rate: 18, payment_terms_days: 7 }]
  const briefs = [{ project_id: 'p', client_name: 'Mr Sunil Shah' } as ProjectBrief]
  const projects = [{ id: 'p', name: 'Sparsh Ekaya' }]
  const raised = inv('i1', { status: 'raised', invoice_no: 'SE-001', raised_on: '2026-11-13', due_date: '2026-11-20' })
  const run = (today: string, invoices: FeeInvoice[] = [raised], done = new Set<string>()) => feeDrafts({ projects, invoices, fees, briefs, doneTaskIds: done, today })

  it('reminds 3 and 10 days after the due date, with a separate key for each stage', () => {
    expect(run('2026-11-22')).toEqual([])
    expect(run('2026-11-23').map((d) => d.key)).toEqual(['fee:i1:3'])
    expect(run('2026-11-29').map((d) => d.key)).toEqual(['fee:i1:3'])
    expect(run('2026-11-30').map((d) => d.key)).toEqual(['fee:i1:10'])
  })
  it('writes a polite client message with the amount incl. GST and the dates', () => {
    const [d] = run('2026-11-23')
    expect(d.kind).toBe('client')
    expect(d.to).toBe('Mr Sunil Shah')
    expect(d.body).toContain('Dear Mr Sunil Shah')
    expect(d.body).toContain('₹ 35,400.00')
    expect(d.body).toContain('20 Nov 2026')
    expect(d.body).toContain('SE-001')
    const [late] = run('2026-12-05')
    expect(late.subject).toMatch(/^Second reminder/)
    expect(late.body).toContain('15 days overdue')
  })
  it('uses raised date + terms when no due date is stored; skips paid and removed', () => {
    const noDue = inv('i3', { status: 'raised', raised_on: '2026-11-10' })
    expect(run('2026-11-20', [noDue]).map((d) => d.key)).toEqual(['fee:i3:3'])
    expect(run('2026-12-20', [inv('i4', { status: 'paid', due_date: '2026-11-01' }), { ...raised, removed_at: 'x' }])).toEqual([])
  })
  it('prompts the team to raise an invoice when its milestone task is done', () => {
    const linked = inv('i2', { task_id: 't9', amount: 52500 })
    expect(run('2026-11-23', [linked])).toEqual([])
    const [d] = run('2026-11-23', [linked], new Set(['t9']))
    expect(d.key).toBe('feeraise:i2')
    expect(d.kind).toBe('team')
    expect(d.body).toContain('₹ 61,950.00')
  })
})

describe('proposal document model', () => {
  const studio = { name: 'Studio Elements', tagline: 'Architecture · Interior Design · Project Management', website: 'w', email: 'e', phone: 'ph', clauses: {} }
  const base: ProposalInput = {
    projectName: 'Sparsh Ekaya',
    brief: null,
    gstRate: 18,
    studio,
    proposal: { method: 'fixed', fixed_fee: 175000, percent: null, rate_psf: null, stage_pct: [20, 30, 30, 20], stage_override: [null, null, null, null],
      milestones: [{ name: 'Appointment and commencement', pct: 20 }, { name: 'Concept approval', pct: 30 }, { name: 'Working drawing issue', pct: 30 }, { name: 'Final handover', pct: 20 }] },
  }
  const text = (b: ReturnType<typeof proposalBlocks>) => b.map((x) => ('text' in x ? x.text : 'rows' in x ? x.rows.flat().join(' | ') : '[sig]')).join('\n')

  it('keeps the reference section order', () => {
    const heads = proposalBlocks(base).filter((b) => b.k === 'h').map((b) => (b as { text: string }).text)
    expect(heads).toEqual([
      CLAUSE_TITLES.about, '2. PROJECT DETAILS', CLAUSE_TITLES.scope, CLAUSE_TITLES.timeline, '4B. FEE STRUCTURE & PAYMENT SCHEDULE', CLAUSE_TITLES.payment,
      CLAUSE_TITLES.resp, CLAUSE_TITLES.site, CLAUSE_TITLES.change, CLAUSE_TITLES.ip, CLAUSE_TITLES.conf, CLAUSE_TITLES.term, CLAUSE_TITLES.liab,
      CLAUSE_TITLES.dispute, CLAUSE_TITLES.general, CLAUSE_TITLES.accept,
    ])
    const blocks = proposalBlocks(base)
    expect(blocks[blocks.length - 1]).toEqual({ k: 'sig' })
  })
  it('puts the fee numbers, words and GST line in (hand-worked: ₹1,75,000 at 18%)', () => {
    const t = text(proposalBlocks(base))
    expect(t).toContain('Stage 1 | Initial Consultation, Site Analysis & Concept Development | 20% | ₹ 35,000')
    expect(t).toContain('Stage 2 | Schematic Design, 3D Visualization & Material Selection | 30% | ₹ 52,500')
    expect(t).toContain('TOTAL DESIGN FEE |  | 100% | ₹ 1,75,000')
    expect(t).toContain('Total Fee in Words: Rupees One Lakh Seventy Five Thousand Only')
    expect(t).toContain('GST @ 18%: ₹ 31,500   |   Total payable including GST: ₹ 2,06,500')
    expect(t).toContain('Final handover | 20% | ₹ 35,000')
  })
  it('shows red placeholders for missing details', () => {
    const details = proposalBlocks(base).find((b) => b.k === 't')!
    expect(details.k === 't' && details.rows.map((r) => r[1])).toEqual(['Sparsh Ekaya', TBC, TBC, TBC, TBC, TBC])
    expect(coverRows(base).map((r) => r[1])).toEqual(['Sparsh Ekaya', TBC, TBC, TBC, TBC, TBC, 'Interior Design'])
  })
  it('fills details from the brief, works out other fee methods, and uses clause overrides', () => {
    const brief = { client_name: 'Mr Sunil Shah', site_address: 'Sparsh Ekaya, Bopal', city: 'Ahmedabad', area: 1200, area_unit: 'sq. ft.' as const,
      duration_months: 10, agreement_date: '2026-11-20', issue_date: '2026-11-23', start_date: '2026-12-01', client_budget: 2000000 }
    const psf = proposalBlocks({ ...base, brief, proposal: { ...base.proposal, method: 'per_sqft', rate_psf: 150 }, studio: { ...studio, clauses: { site: 'Two visits a month.' } } })
    const t = text(psf)
    expect(t).toContain('Project Location : | Sparsh Ekaya, Bopal, Ahmedabad')
    expect(t).toContain('Project Area : | 1200 sq. ft.')
    expect(t).toContain('Estimated Duration : | 10 Months from commencement')
    expect(t).toContain('Date of Agreement : | 20 November 2026')
    expect(t).toContain('TOTAL DESIGN FEE |  | 100% | ₹ 1,80,000')
    expect(t).toContain('Two visits a month.')
    expect(t).not.toContain('4 site visits per month')
    const pct = text(proposalBlocks({ ...base, brief, proposal: { ...base.proposal, method: 'percent', percent: 10 } }))
    expect(pct).toContain('TOTAL DESIGN FEE |  | 100% | ₹ 2,00,000')
    expect(coverRows({ ...base, brief })[3][1]).toBe('1 December 2026')
  })
  it('names the files after the project', () => {
    expect(proposalFileName('Sparsh Ekaya', 'docx')).toBe('Sparsh-Ekaya-Fee-Proposal.docx')
    expect(proposalFileName('A & B / C', 'pdf')).toBe('A-B-C-Fee-Proposal.pdf')
  })
})

describe('invoice document', () => {
  it('writes amounts in words with paise, and placeholders for missing details', () => {
    expect(rupeesInWords(41300)).toBe('Rupees Forty One Thousand Three Hundred Only')
    expect(rupeesInWords(61182.25)).toBe('Rupees Sixty One Thousand One Hundred Eighty Two and Twenty Five Paise Only')
    const lines = invoiceLines({ projectName: 'Sparsh Ekaya', brief: null, invoice: inv('a'), due: '2026-12-17', studio: { name: 'S', tagline: '', website: '', email: '', phone: '', gstin: '' } })
    expect(lines.map((l) => l.value)).toEqual([TBC, TBC, '17 December 2026', 'Sparsh Ekaya', TBC, TBC])
  })
})
