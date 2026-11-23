/**
 * The Design Fee Proposal as a list of blocks, in the same order and wording as Jainam's Project Studio
 * tool (propDoc / coverRows). The DOCX and PDF exporters (proposalExport.ts) only lay these blocks out,
 * so the document's content is tested here without a browser.
 */
import type { ProjectBrief } from '../domain'
import { amountInWords, inr, num } from '../format'
import { feeTotal, milestoneAmounts, stageAmounts, withGst, type FeeInputs } from '../feeMath'
import { CLAUSE_TITLES, PROPOSAL_TIMELINE, SIGNATURE_BLOCK, STAGE_SERVICES, clauseText, type ClauseKey } from '../clauses'
import { FEE_STAGES } from '../domain'

export type Block =
  | { k: 'h'; text: string } // section heading
  | { k: 'p'; text: string } // paragraph
  | { k: 's'; text: string } // stage sub-heading inside a clause
  | { k: 'b'; text: string } // bullet line ("– …")
  | { k: 't'; rows: string[][]; widths: number[]; header: 0 | 1 | 2 } // table: 1 = header row, 2 = label column
  | { k: 'sig' }

export type StudioInfo = { name: string; tagline: string; website: string; email: string; phone: string; clauses: Record<string, string> | null }

export type ProposalInput = {
  projectName: string
  brief: Partial<ProjectBrief> | null
  proposal: FeeInputs
  gstRate: number
  studio: StudioInfo
}

export const TBC = '[to be confirmed]'

/** A value, or a fallback, or the red placeholder. */
export function P(v: string | null | undefined, d?: string): string {
  return (v && String(v).trim()) || d || TBC
}

/** Text the exporters show in red: missing details and placeholders left in the clauses. */
export function isPlaceholder(text: string): boolean {
  return /\[(City|to be|Insert|Client Name|Date)/.test(text)
}

/** "12 November 2026", as in the reference proposal. */
export function fd(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
}

/** File name stem from the project name: "Sparsh Ekaya" → "Sparsh-Ekaya". */
export function fileStem(name: string): string {
  return (name.trim() || 'Project').replace(/[^\w-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'Project'
}

export function proposalFileName(projectName: string, ext: 'docx' | 'pdf'): string {
  return `${fileStem(projectName)}-Fee-Proposal.${ext}`
}

function ctx(b: Partial<ProjectBrief> | null) {
  return { client_budget: b?.client_budget ?? null, area: b?.area ?? null, area_unit: b?.area_unit ?? 'sq. ft.' }
}

/** Rows of the cover page's details table. */
export function coverRows(input: ProposalInput): string[][] {
  const b = input.brief
  return [
    ['Project Name :', P(input.projectName)],
    ['Client Name :', P(b?.client_name)],
    ['Project Location :', P(b?.city || b?.site_address)],
    ['Start Date:', P(fd(b?.start_date))],
    ['Estimated Duration :', b?.duration_months ? `${num(b.duration_months)} Months` : TBC],
    ['Date of Issue :', P(fd(b?.issue_date))],
    ['Project Services :', 'Interior Design'],
  ]
}

export function headerText(input: ProposalInput): string {
  return `${input.studio.name} · Interior Design Services · Design Fee Proposal   ${P(input.brief?.client_name, '[Client Name]')} · ${P(fd(input.brief?.issue_date), '[Date]')}`
}

export function footerText(studioName: string): string {
  return `${studioName} — Confidential & Proprietary`
}

export const DRAFT_NOTE = 'DRAFT — the agreement clauses require review by a legal professional before execution.'

export function proposalBlocks(input: ProposalInput): Block[] {
  const { proposal: p, brief: b } = input
  const t = feeTotal(p, ctx(b))
  const a = stageAmounts(p, t)
  const { gst, total } = withGst(t, input.gstRate)
  const B: Block[] = []
  const H = (text: string) => B.push({ k: 'h', text })
  const X = (key: ClauseKey) => {
    for (const line of clauseText(key, input.studio.clauses).split('\n')) {
      B.push({ k: line.startsWith('– ') ? 'b' : /^Stage \d/.test(line) ? 's' : 'p', text: line })
    }
  }

  H(CLAUSE_TITLES.about)
  X('about')
  H('2. PROJECT DETAILS')
  B.push({
    k: 't',
    rows: [
      ['Project Name :', P(input.projectName)],
      ['Client Name :', P(b?.client_name)],
      ['Project Location :', P(b?.site_address) + (b?.city ? `, ${b.city}` : '')],
      ['Project Area :', b?.area ? `${num(b.area)} ${b.area_unit ?? 'sq. ft.'}` : TBC],
      ['Estimated Duration :', b?.duration_months ? `${num(b.duration_months)} Months from commencement` : TBC],
      ['Date of Agreement :', P(fd(b?.agreement_date))],
    ],
    widths: [30, 70],
    header: 2,
  })
  H(CLAUSE_TITLES.scope)
  X('scope')
  H(CLAUSE_TITLES.timeline)
  X('timeline')
  B.push({ k: 't', rows: [['PHASE / ACTIVITY', '', 'INDICATIVE DURATION'], ...PROPOSAL_TIMELINE.map((r) => [...r])], widths: [20, 50, 30], header: 1 })
  H('4B. FEE STRUCTURE & PAYMENT SCHEDULE')
  B.push({ k: 'p', text: 'The total design fee for the scope defined above is structured as follows. Fees are exclusive of GST and reimbursable expenses.' })
  B.push({
    k: 't',
    rows: [
      ['Stage', 'Services Included', 'Payment %', 'Fee (₹)'],
      ...FEE_STAGES.map((_, i) => [`Stage ${i + 1}`, STAGE_SERVICES[i], `${num(p.stage_pct[i])}%`, inr(a[i])]),
      ['TOTAL DESIGN FEE', '', '100%', inr(t)],
    ],
    widths: [14, 50, 16, 20],
    header: 1,
  })
  B.push({ k: 'p', text: `Total Fee in Words: Rupees ${amountInWords(t)} Only` })
  B.push({ k: 'p', text: 'All amounts are exclusive of GST at applicable rates. Reimbursable expenses (printing, travel beyond city, physical samples) billed at actuals with prior approval.' })
  B.push({ k: 'p', text: `GST @ ${num(input.gstRate)}%: ${inr(gst)}   |   Total payable including GST: ${inr(total)}` })
  H(CLAUSE_TITLES.payment)
  X('payment')
  B.push({
    k: 't',
    rows: [['Milestone', 'Payment %', 'Amount (₹)'], ...milestoneAmounts(p, t).map((m) => [m.name, `${m.pct}%`, inr(m.amount)])],
    widths: [56, 16, 28],
    header: 1,
  })
  for (const key of ['resp', 'site', 'change', 'ip', 'conf', 'term', 'liab', 'dispute', 'general'] as const) {
    H(CLAUSE_TITLES[key])
    X(key)
  }
  H(CLAUSE_TITLES.accept)
  X('accept')
  B.push({ k: 'p', text: 'Proposal Type: Interior Design Services | Prepared by: Studio Elements | Valid for 30 days from date of issue' })
  B.push({ k: 'sig' })
  return B
}

export const SIGNATURE = SIGNATURE_BLOCK
