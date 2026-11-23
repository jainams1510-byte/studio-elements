/**
 * Estimate maths, the same formulas as Jainam's Project Studio tool:
 * line amount = quantity × rate × (1 + wastage %); optional lines are shown but not totalled;
 * contingency on the subtotal; GST on (subtotal + contingency); budget compared with the total
 * when the client's budget includes GST, otherwise with the taxable amount.
 */
import { areaSqft, num, round2 } from './format'

export type EstimateLine = { category: string; quantity: number; rate: number; wastage_pct: number; optional: boolean; removed_at?: string | null }

export type EstimateSettings = {
  contingency_pct: number
  estimate_gst_rate: number
  client_budget: number | null
  budget_includes_gst: boolean
  area: number | null
  area_unit: string
}

export const DEFAULT_ESTIMATE_SETTINGS: EstimateSettings = {
  contingency_pct: 5, estimate_gst_rate: 18, client_budget: null, budget_includes_gst: false, area: null, area_unit: 'sq. ft.',
}

export function lineAmount(l: Pick<EstimateLine, 'quantity' | 'rate' | 'wastage_pct'>): number {
  return num(l.quantity) * num(l.rate) * (1 + num(l.wastage_pct) / 100)
}

export type EstimateTotals = {
  byCategory: Record<string, number>
  subtotal: number
  contingency: number
  taxable: number
  gst: number
  total: number
  budget: number | null
  /** What the budget is compared with: total (budget includes GST) or taxable. */
  compared: number
  /** Budget minus compared amount: negative means over budget. Null without a budget. */
  variance: number | null
  /** Taxable amount per sq. ft.; 0 without an area. */
  perSqft: number
}

export function estimateTotals(lines: EstimateLine[], s: EstimateSettings): EstimateTotals {
  const byCategory: Record<string, number> = {}
  let subtotal = 0
  for (const l of lines) {
    if (l.removed_at || l.optional) continue
    const a = lineAmount(l)
    byCategory[l.category] = (byCategory[l.category] ?? 0) + a
    subtotal += a
  }
  const contingency = (subtotal * num(s.contingency_pct)) / 100
  const taxable = subtotal + contingency
  const gst = (taxable * num(s.estimate_gst_rate)) / 100
  const total = taxable + gst
  const budget = s.client_budget == null || num(s.client_budget) === 0 ? null : num(s.client_budget)
  const compared = s.budget_includes_gst ? total : taxable
  const sqft = areaSqft(s.area, s.area_unit)
  return {
    byCategory: Object.fromEntries(Object.entries(byCategory).map(([k, v]) => [k, round2(v)])),
    subtotal: round2(subtotal),
    contingency: round2(contingency),
    taxable: round2(taxable),
    gst: round2(gst),
    total: round2(total),
    budget,
    compared: round2(compared),
    variance: budget === null ? null : round2(budget - compared),
    perSqft: sqft ? round2(taxable / sqft) : 0,
  }
}
