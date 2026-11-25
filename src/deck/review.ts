/**
 * "Review before export": the checks from Project Studio's vReview, on the app's own data.
 * Pure function; the Review tab loads the rows and shows the result with links to where to fix each one.
 */
import { CLAUSE_KEYS, CLAUSE_TITLES, clauseText } from '../clauses'
import type { BoqItem, FeeProposal, ProjectBrief } from '../domain'
import { estimateTotals } from '../estimate'
import { feeChecks, feeTotal } from '../feeMath'
import { inr, num } from '../format'
import { briefDateWarnings } from './brief'
import { deckDefault, emptySlots, type Slide } from './deck'

export type Fix = 'edit' | 'money' | 'fees' | 'deck' | 'settings'
export type Check = { level: 'bad' | 'warn' | 'ok'; text: string; fix?: Fix }

export type ReviewInput = {
  project: { name: string | null; rooms: string[] } | null
  brief: Partial<ProjectBrief> | null
  boq: Pick<BoqItem, 'item' | 'category' | 'quantity' | 'rate' | 'wastage_pct' | 'optional' | 'verified' | 'removed_at'>[]
  owner: boolean
  /** Owners only (fee_proposals is owner-only). Null when none is saved yet. */
  proposal: FeeProposal | null
  clauses: Record<string, string> | null
  /** The saved deck, or null when none is saved (the default deck from rooms is used). */
  deck: { slides: Slide[]; key_plan_path: string | null } | null
}

/** How many lines to list one by one before summing up the rest. */
export const LINE_LIMIT = 5

const blank = (v: unknown) => v == null || String(v).trim() === '' || (typeof v === 'number' && v === 0)

export const MUMBAI = /\bmumbai\b/i
export const CITY_PLACEHOLDER = '[City]'

/** Clause problems shared by Review and Studio settings. */
export function clauseChecks(overrides: Record<string, string> | null): Check[] {
  const out: Check[] = []
  const withCity = CLAUSE_KEYS.filter((k) => clauseText(k, overrides).includes(CITY_PLACEHOLDER))
  if (withCity.length)
    out.push({
      level: 'bad',
      text: `A clause still contains the placeholder [City] (jurisdiction): ${withCity.map((k) => CLAUSE_TITLES[k]).join(', ')}. Fill it in after legal advice.`,
      fix: 'settings',
    })
  if (MUMBAI.test(clauseText('about', overrides)))
    out.push({ level: 'warn', text: 'The “About Studio Elements” clause says the studio is based in Mumbai. The studio is in Ahmedabad.', fix: 'settings' })
  return out
}

export function reviewChecks(input: ReviewInput): Check[] {
  const out: Check[] = []
  const b = input.brief ?? {}
  const p = input.project

  const required: [string, unknown][] = [
    ['Project name', p?.name],
    ['Client name', b.client_name],
    ['Site address', b.site_address],
    ['Area', b.area],
    ['Client budget', b.client_budget],
    ['Issue date', b.issue_date],
    ['Agreement date', b.agreement_date],
    ['Start date', b.start_date],
  ]
  for (const [label, v] of required) if (blank(v)) out.push({ level: 'bad', text: `Missing: ${label}`, fix: 'edit' })

  for (const w of briefDateWarnings({
    issue_date: b.issue_date ?? null,
    agreement_date: b.agreement_date ?? null,
    start_date: b.start_date ?? null,
    end_date: b.end_date ?? null,
  }))
    out.push({ ...w, fix: 'edit' })

  const lines = input.boq.filter((l) => !l.removed_at)
  const totals = estimateTotals(lines, {
    contingency_pct: num(b.contingency_pct ?? 5),
    estimate_gst_rate: num(b.estimate_gst_rate ?? 18),
    client_budget: b.client_budget ?? null,
    budget_includes_gst: Boolean(b.budget_includes_gst),
    area: b.area ?? null,
    area_unit: b.area_unit ?? 'sq. ft.',
  })
  if (totals.variance !== null && totals.variance < 0)
    out.push({ level: 'bad', text: `Estimate is over the client budget by ${inr(-totals.variance)}.`, fix: 'money' })

  const unverified = lines.filter((l) => !l.verified).length
  if (unverified) out.push({ level: 'warn', text: `${unverified} estimate line${unverified === 1 ? '' : 's'} unverified.`, fix: 'money' })

  const incomplete = lines.filter((l) => !num(l.quantity) || !num(l.rate))
  incomplete.slice(0, LINE_LIMIT).forEach((l) =>
    out.push({ level: 'bad', text: `Line “${l.item.trim() || 'untitled'}” is missing quantity or rate.`, fix: 'money' }),
  )
  if (incomplete.length > LINE_LIMIT) {
    const more = incomplete.length - LINE_LIMIT
    out.push({ level: 'bad', text: `${more} more line${more === 1 ? ' is' : 's are'} missing quantity or rate.`, fix: 'money' })
  }

  if (!input.owner) {
    out.push({ level: 'ok', text: 'Fee checks are visible to owners.' })
  } else if (!input.proposal) {
    out.push({ level: 'warn', text: 'No fee proposal saved yet, so stage fees, milestones and the legal review cannot be checked.', fix: 'fees' })
  } else {
    const pr = input.proposal
    const total = feeTotal(pr, { client_budget: b.client_budget ?? null, area: b.area ?? null, area_unit: b.area_unit ?? 'sq. ft.' })
    const fc = feeChecks(pr, total)
    if (!fc.stagesReconcile)
      out.push({ level: 'bad', text: `Stage fees add up to ${inr(fc.stageSum)}, not the total fee of ${inr(total)}.`, fix: 'fees' })
    if (!fc.milestonesTotal100) out.push({ level: 'bad', text: `Payment milestones total ${fc.milestonePct}%, not 100%.`, fix: 'fees' })
    if (!pr.legal_reviewed) out.push({ level: 'warn', text: 'Agreement clauses not yet marked as legally reviewed.', fix: 'fees' })
  }

  out.push(...clauseChecks(input.clauses))

  const rooms = (p?.rooms ?? []).filter((r) => r.trim())
  if (!rooms.length) out.push({ level: 'warn', text: 'No rooms added, so no room slides will be made.', fix: 'edit' })

  const deck = input.deck ?? { slides: deckDefault(rooms), key_plan_path: null }
  const empty = emptySlots(deck.slides, deck.key_plan_path)
  if (empty)
    out.push({
      level: 'warn',
      text: `${empty} image slot${empty === 1 ? '' : 's'} in the presentation ${empty === 1 ? 'is' : 'are'} empty and will export as blank boxes.`,
      fix: 'deck',
    })

  const rank = { bad: 0, warn: 1, ok: 2 }
  return out.map((c, i) => ({ c, i })).sort((x, y) => rank[x.c.level] - rank[y.c.level] || x.i - y.i).map((x) => x.c)
}
