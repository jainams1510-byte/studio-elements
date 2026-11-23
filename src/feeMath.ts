/**
 * Fee proposal maths, the same as Jainam's Project Studio tool:
 * total fee by one method (fixed, % of client budget, per sq. ft.); four stage amounts from percentages,
 * each replaceable by an override; payment milestones as percentages of the total.
 */
import { areaSqft, num, round2 } from './format'

export type FeeInputs = {
  method: 'fixed' | 'percent' | 'per_sqft'
  fixed_fee: number | null
  percent: number | null
  rate_psf: number | null
  stage_pct: number[]
  stage_override: (number | null)[]
  milestones: { name: string; pct: number }[]
}

export type FeeContext = { client_budget: number | null; area: number | null; area_unit: string }

export function feeTotal(p: FeeInputs, c: FeeContext): number {
  if (p.method === 'fixed') return round2(num(p.fixed_fee))
  if (p.method === 'percent') return round2((num(c.client_budget) * num(p.percent)) / 100)
  return round2(areaSqft(c.area, c.area_unit) * num(p.rate_psf))
}

/** Each stage: its override if given, else the rounded percentage of the total. */
export function stageAmounts(p: FeeInputs, total: number): number[] {
  return p.stage_pct.map((pct, i) => {
    const o = p.stage_override[i]
    return o != null && String(o) !== '' ? round2(num(o)) : Math.round((total * num(pct)) / 100)
  })
}

export type FeeCheck = { stageSum: number; stagesReconcile: boolean; milestonePct: number; milestonesTotal100: boolean }

/** Stage amounts must add up to the total (within ₹1) and milestones to 100%. */
export function feeChecks(p: FeeInputs, total: number): FeeCheck {
  const stageSum = stageAmounts(p, total).reduce((a, b) => a + b, 0)
  const milestonePct = round2(p.milestones.reduce((a, m) => a + num(m.pct), 0))
  return { stageSum, stagesReconcile: Math.abs(stageSum - total) <= 1, milestonePct, milestonesTotal100: Math.abs(milestonePct - 100) < 0.01 }
}

export function milestoneAmounts(p: FeeInputs, total: number): { name: string; pct: number; amount: number }[] {
  return p.milestones.map((m) => ({ name: m.name, pct: num(m.pct), amount: round2((total * num(m.pct)) / 100) }))
}

export function withGst(amount: number, gstRate: number): { gst: number; total: number } {
  const gst = round2((amount * num(gstRate)) / 100)
  return { gst, total: round2(amount + gst) }
}

/** How the fee was worked out, in words, for the proposal. */
export function feeBasis(p: FeeInputs, c: FeeContext, inr: (v: number) => string): string {
  if (p.method === 'fixed') return 'Fixed fee entered by the designer'
  if (p.method === 'percent') return `${num(p.percent)}% × client budget ${inr(num(c.client_budget))}`
  return `${num(p.rate_psf)} ₹/sq. ft. × ${Math.round(areaSqft(c.area, c.area_unit))} sq. ft.`
}
