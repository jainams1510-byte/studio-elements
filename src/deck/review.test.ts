import { describe, expect, it } from 'vitest'
import { REFERENCE_CLAUSES } from '../clauses'
import type { FeeProposal, ProjectBrief } from '../domain'
import { briefDateWarnings, briefNumberProblem, parseNum } from './brief'
import { deckDefault, setSlot } from './deck'
import { clauseChecks, reviewChecks, type ReviewInput } from './review'

const goodBrief: Partial<ProjectBrief> = {
  client_name: 'Sunil Shah', site_address: 'Sparsh Ekaya, Ahmedabad', area: 1200, area_unit: 'sq. ft.',
  client_budget: 500000, budget_includes_gst: false, estimate_gst_rate: 18, contingency_pct: 5,
  issue_date: '2026-11-01', agreement_date: '2026-11-10', start_date: '2026-12-01', end_date: '2027-04-30',
}
const fixedClauses = {
  about: 'Studio Elements is a multidisciplinary design practice based in Ahmedabad, India.',
  dispute: REFERENCE_CLAUSES.dispute.replace('[City]', 'Ahmedabad'),
}
const proposal: FeeProposal = {
  project_id: 'p', method: 'fixed', fixed_fee: 100000, percent: null, rate_psf: null, stage_pct: [20, 30, 30, 20],
  stage_override: [null, null, null, null], milestones: [{ name: 'A', pct: 50 }, { name: 'B', pct: 50 }], legal_reviewed: true,
}
const line = (o: Partial<ReviewInput['boq'][number]> = {}) => ({
  item: 'Flooring', category: 'Flooring and skirting', quantity: 1000, rate: 120, wastage_pct: 0, optional: false, verified: true, removed_at: null, ...o,
})
const fullDeck = () => {
  let s = deckDefault(['Living'])
  s = setSlot(s, 0, 'a', 'a.jpg')
  s = setSlot(s, 0, 'b', 'b.jpg')
  s = setSlot(s, 2, 'a', 'l1.jpg')
  s = setSlot(s, 2, 'b', 'l2.jpg')
  return { slides: s, key_plan_path: 'kp.jpg' }
}
const clean = (): ReviewInput => ({
  project: { name: 'Sparsh Ekaya', rooms: ['Living'] }, brief: { ...goodBrief }, boq: [line()], owner: true,
  proposal: { ...proposal }, clauses: { ...fixedClauses }, deck: fullDeck(),
})
const texts = (i: ReviewInput) => reviewChecks(i).map((c) => `${c.level}|${c.fix ?? ''}|${c.text}`)

describe('reviewChecks', () => {
  it('is clean when everything is filled in', () => {
    expect(reviewChecks(clean())).toEqual([])
  })

  it('lists every missing brief field as bad, linking to Edit', () => {
    const t = texts({ ...clean(), project: { name: '', rooms: ['Living'] }, brief: null })
    for (const f of ['Project name', 'Client name', 'Site address', 'Area', 'Client budget', 'Issue date', 'Agreement date', 'Start date'])
      expect(t).toContain(`bad|edit|Missing: ${f}`)
  })

  it('checks date order', () => {
    const t = texts({ ...clean(), brief: { ...goodBrief, issue_date: '2026-11-20', agreement_date: '2026-11-15', start_date: '2026-11-10', end_date: '2026-11-10' } })
    expect(t).toContain('warn|edit|Start date is before the agreement date. Confirm this is intended.')
    expect(t).toContain('warn|edit|Agreement date is before the proposal issue date. Confirm this is intended.')
    expect(t).toContain('bad|edit|Completion date is not after the start date.')
  })

  it('flags an estimate over budget using the brief’s contingency and GST', () => {
    // 1000 × 120 = 1,20,000 + 5% = 1,26,000 taxable. Budget excl. GST 1,20,000 → over by 6,000.
    const i = { ...clean(), brief: { ...goodBrief, client_budget: 120000 } }
    expect(texts(i)).toContain('bad|money|Estimate is over the client budget by ₹ 6,000.')
    // Budget includes GST: 1,26,000 × 1.18 = 1,48,680 → over a 1,50,000 budget? No: within.
    expect(texts({ ...clean(), brief: { ...goodBrief, client_budget: 150000, budget_includes_gst: true } }).some((t) => t.includes('over the client budget'))).toBe(false)
    expect(texts({ ...clean(), brief: { ...goodBrief, client_budget: 148000, budget_includes_gst: true } })).toContain('bad|money|Estimate is over the client budget by ₹ 680.')
    // Removed and optional lines do not count.
    const j = { ...i, boq: [line({ rate: 100 }), line({ rate: 99999, removed_at: '2026-11-01' }), line({ rate: 99999, optional: true })] }
    expect(texts(j).some((t) => t.includes('over the client budget'))).toBe(false)
  })

  it('counts unverified lines and lists lines missing quantity or rate', () => {
    const i = { ...clean(), boq: [line({ verified: false }), line({ verified: false, item: 'Paint', rate: 0 }), line({ item: ' ', quantity: 0, removed_at: null })] }
    const t = texts(i)
    expect(t).toContain('warn|money|2 estimate lines unverified.')
    expect(t).toContain('bad|money|Line “Paint” is missing quantity or rate.')
    expect(t).toContain('bad|money|Line “untitled” is missing quantity or rate.')
    const many = { ...clean(), boq: Array.from({ length: 8 }, (_, k) => line({ item: `L${k}`, rate: 0 })) }
    const m = texts(many)
    expect(m.filter((x) => x.includes('is missing quantity or rate')).length).toBe(5)
    expect(m).toContain('bad|money|3 more lines are missing quantity or rate.')
  })

  it('checks fees for owners', () => {
    const p = { ...proposal, stage_override: [50000, null, null, null], milestones: [{ name: 'A', pct: 60 }], legal_reviewed: false }
    const t = texts({ ...clean(), proposal: p })
    // Stages: 50,000 + 30,000 + 30,000 + 20,000 = 1,30,000 vs 1,00,000.
    expect(t).toContain('bad|fees|Stage fees add up to ₹ 1,30,000, not the total fee of ₹ 1,00,000.')
    expect(t).toContain('bad|fees|Payment milestones total 60%, not 100%.')
    expect(t).toContain('warn|fees|Agreement clauses not yet marked as legally reviewed.')
    expect(texts({ ...clean(), proposal: null })[0]).toMatch(/^warn\|fees\|No fee proposal saved yet/)
  })

  it('skips fee checks for non-owners with one note', () => {
    const r = reviewChecks({ ...clean(), owner: false, proposal: { ...proposal, legal_reviewed: false } })
    expect(r).toEqual([{ level: 'ok', text: 'Fee checks are visible to owners.' }])
  })

  it('flags [City], Mumbai, no rooms and empty slots', () => {
    const t = texts({ ...clean(), clauses: {}, project: { name: 'X', rooms: [] }, deck: null })
    expect(t.some((x) => x.startsWith('bad|settings|A clause still contains the placeholder [City]') && x.includes('13. DISPUTE RESOLUTION'))).toBe(true)
    expect(t.some((x) => x.startsWith('warn|settings|') && x.includes('Mumbai'))).toBe(true)
    expect(t).toContain('warn|edit|No rooms added, so no room slides will be made.')
    // Default deck with no rooms: AS BUILT 2 + KEY PLAN 1 = 3 empty.
    expect(t).toContain('warn|deck|3 image slots in the presentation are empty and will export as blank boxes.')
    const one = fullDeck()
    one.slides = setSlot(one.slides, 2, 'b', null)
    expect(texts({ ...clean(), deck: one })).toEqual(['warn|deck|1 image slot in the presentation is empty and will export as blank boxes.'])
  })

  it('puts bad first, then warnings, then notes', () => {
    const r = reviewChecks({ ...clean(), owner: false, project: { name: 'X', rooms: [] }, brief: { ...goodBrief, client_name: '' } })
    const levels = r.map((c) => c.level)
    expect(levels).toEqual([...levels].sort((a, b) => ['bad', 'warn', 'ok'].indexOf(a) - ['bad', 'warn', 'ok'].indexOf(b)))
    expect(levels[0]).toBe('bad')
    expect(levels.at(-1)).toBe('ok')
  })

  it('clause checks: an override replaces the reference text', () => {
    expect(clauseChecks(fixedClauses)).toEqual([])
    expect(clauseChecks({ about: 'Based in Mumbai.' , dispute: 'Courts of Ahmedabad.' }).map((c) => c.level)).toEqual(['warn'])
  })
})

describe('brief date-order warnings', () => {
  it('warns for each pair that is out of order', () => {
    expect(briefDateWarnings({ issue_date: '2026-11-01', agreement_date: '2026-11-10', start_date: '2026-12-01', end_date: '2027-01-01' })).toEqual([])
    expect(briefDateWarnings({ issue_date: null, agreement_date: '2026-11-10', start_date: '2026-11-05', end_date: null }).map((w) => w.level)).toEqual(['warn'])
    expect(briefDateWarnings({ issue_date: '2026-11-12', agreement_date: '2026-11-10', start_date: null, end_date: null })[0].text).toMatch(/^Agreement date is before/)
    expect(briefDateWarnings({ issue_date: null, agreement_date: null, start_date: '2026-12-01', end_date: '2026-12-01' })).toEqual([
      { level: 'bad', text: 'Completion date is not after the start date.' },
    ])
    expect(briefDateWarnings({ issue_date: '', agreement_date: '', start_date: '', end_date: '' })).toEqual([])
  })
  it('parses and checks numbers', () => {
    expect(parseNum('')).toBe(null)
    expect(parseNum('1,20,000')).toBe(120000)
    expect(parseNum('abc')).toBe('bad')
    const ok = { area: 1200, duration_months: 4, client_budget: null, estimate_gst_rate: 18, contingency_pct: 5 }
    expect(briefNumberProblem(ok)).toBe(null)
    expect(briefNumberProblem({ ...ok, estimate_gst_rate: 30 })).toMatch(/GST/)
    expect(briefNumberProblem({ ...ok, estimate_gst_rate: null })).toMatch(/GST/)
    expect(briefNumberProblem({ ...ok, contingency_pct: 51 })).toMatch(/Contingency/)
    expect(briefNumberProblem({ ...ok, area: -1 })).toMatch(/area/)
  })
})
