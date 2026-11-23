import { describe, expect, it } from 'vitest'
import { estimateTotals, lineAmount } from './estimate'
import { feeBasis, feeChecks, feeTotal, milestoneAmounts, stageAmounts, withGst, type FeeInputs } from './feeMath'
import { inr } from './format'
import { clauseText, CLAUSE_KEYS, REFERENCE_CLAUSES } from './clauses'

describe('estimate (Project Studio formulas)', () => {
  // Worked by hand: flooring 1,000 sq ft × ₹120 + 5% wastage = 1,26,000; wardrobe 2 × ₹45,000 = 90,000;
  // optional bar unit ₹60,000 left out. Subtotal 2,16,000; contingency 5% = 10,800; taxable 2,26,800;
  // GST 18% = 40,824; total 2,67,624.
  const lines = [
    { category: 'Flooring and skirting', quantity: 1000, rate: 120, wastage_pct: 5, optional: false },
    { category: 'Wardrobes and storage', quantity: 2, rate: 45000, wastage_pct: 0, optional: false },
    { category: 'Loose furniture', quantity: 1, rate: 60000, wastage_pct: 0, optional: true },
    { category: 'Kitchen', quantity: 1, rate: 99999, wastage_pct: 0, optional: false, removed_at: '2026-11-20T00:00:00Z' },
  ]
  const s = { contingency_pct: 5, estimate_gst_rate: 18, client_budget: 250000, budget_includes_gst: false, area: 1200, area_unit: 'sq. ft.' }

  it('adds wastage to a line', () => {
    expect(lineAmount(lines[0])).toBe(126000)
  })

  it('totals non-optional, non-removed lines with contingency and GST', () => {
    const t = estimateTotals(lines, s)
    expect(t.byCategory).toEqual({ 'Flooring and skirting': 126000, 'Wardrobes and storage': 90000 })
    expect([t.subtotal, t.contingency, t.taxable, t.gst, t.total]).toEqual([216000, 10800, 226800, 40824, 267624])
    expect(t.perSqft).toBe(189) // 2,26,800 / 1,200
  })

  it('compares the budget with taxable or total depending on GST', () => {
    expect(estimateTotals(lines, s).variance).toBe(23200) // 2,50,000 − 2,26,800
    expect(estimateTotals(lines, { ...s, budget_includes_gst: true }).variance).toBe(-17624) // over by 17,624
    expect(estimateTotals(lines, { ...s, client_budget: null }).variance).toBeNull()
  })
})

describe('fee proposal (Project Studio formulas)', () => {
  const p: FeeInputs = {
    method: 'percent', fixed_fee: null, percent: 8, rate_psf: null,
    stage_pct: [20, 30, 30, 20], stage_override: [null, null, null, null],
    milestones: [{ name: 'A', pct: 20 }, { name: 'B', pct: 30 }, { name: 'C', pct: 30 }, { name: 'D', pct: 20 }],
  }
  const c = { client_budget: 2500000, area: 2000, area_unit: 'sq. ft.' }

  it('works out the fee by each method', () => {
    expect(feeTotal(p, c)).toBe(200000) // 8% of 25 lakh
    expect(feeTotal({ ...p, method: 'fixed', fixed_fee: 175000 }, c)).toBe(175000)
    expect(feeTotal({ ...p, method: 'per_sqft', rate_psf: 90 }, c)).toBe(180000)
    expect(feeTotal({ ...p, method: 'per_sqft', rate_psf: 90 }, { ...c, area: 100, area_unit: 'sq. m.' })).toBe(96875.1) // 1,076.39 sq ft × 90
  })

  it('splits by stage, honours overrides and checks the sums', () => {
    expect(stageAmounts(p, 200000)).toEqual([40000, 60000, 60000, 40000])
    const over = { ...p, stage_override: [50000, null, null, null] }
    expect(stageAmounts(over, 200000)).toEqual([50000, 60000, 60000, 40000])
    expect(feeChecks(p, 200000)).toEqual({ stageSum: 200000, stagesReconcile: true, milestonePct: 100, milestonesTotal100: true })
    expect(feeChecks(over, 200000).stagesReconcile).toBe(false)
    expect(feeChecks({ ...p, milestones: [{ name: 'A', pct: 90 }] }, 200000).milestonesTotal100).toBe(false)
  })

  it('adds GST and lists milestone amounts', () => {
    expect(withGst(200000, 18)).toEqual({ gst: 36000, total: 236000 })
    expect(withGst(200000, 0)).toEqual({ gst: 0, total: 200000 })
    expect(milestoneAmounts(p, 200000).map((m) => m.amount)).toEqual([40000, 60000, 60000, 40000])
    expect(feeBasis(p, c, inr)).toBe('8% × client budget ₹ 25,00,000')
  })
})

describe('clause library', () => {
  it('has reference text for every clause and applies overrides', () => {
    for (const k of CLAUSE_KEYS) expect(REFERENCE_CLAUSES[k].length).toBeGreaterThan(40)
    expect(clauseText('about', { about: 'Our own text' })).toBe('Our own text')
    expect(clauseText('about', {})).toBe(REFERENCE_CLAUSES.about)
  })
})
