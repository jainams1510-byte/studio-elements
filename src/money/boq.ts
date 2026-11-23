/** BOQ helpers: estimate settings from the brief, category order and grouping, and the CSV export rows. */
import { ESTIMATE_CATEGORIES, type BoqItem, type ProjectBrief } from '../domain'
import { DEFAULT_ESTIMATE_SETTINGS, estimateTotals, lineAmount, type EstimateSettings } from '../estimate'
import { num, round2 } from '../format'
import type { Cell } from './csv'

export function settingsFromBrief(brief: Partial<ProjectBrief> | null | undefined): EstimateSettings {
  if (!brief) return { ...DEFAULT_ESTIMATE_SETTINGS }
  return {
    contingency_pct: brief.contingency_pct == null ? DEFAULT_ESTIMATE_SETTINGS.contingency_pct : num(brief.contingency_pct),
    estimate_gst_rate: brief.estimate_gst_rate == null ? DEFAULT_ESTIMATE_SETTINGS.estimate_gst_rate : num(brief.estimate_gst_rate),
    client_budget: brief.client_budget == null ? null : num(brief.client_budget),
    budget_includes_gst: Boolean(brief.budget_includes_gst),
    area: brief.area == null ? null : num(brief.area),
    area_unit: brief.area_unit ?? 'sq. ft.',
  }
}

export function categoryRank(category: string): number {
  const i = (ESTIMATE_CATEGORIES as readonly string[]).indexOf(category)
  return i < 0 ? ESTIMATE_CATEGORIES.length : i
}

/** Live lines in Project Studio order: category, then the order they were added. */
export function sortedLines(items: BoqItem[]): BoqItem[] {
  return items
    .filter((i) => !i.removed_at)
    .sort((a, b) => categoryRank(a.category) - categoryRank(b.category) || a.category.localeCompare(b.category) || num(a.sort_order) - num(b.sort_order) || a.item.localeCompare(b.item))
}

export function groupByCategory(items: BoqItem[]): { category: string; items: BoqItem[] }[] {
  const out: { category: string; items: BoqItem[] }[] = []
  for (const i of sortedLines(items)) {
    const last = out[out.length - 1]
    if (last && last.category === i.category) last.items.push(i)
    else out.push({ category: i.category, items: [i] })
  }
  return out
}

export const CSV_HEADER = ['Category', 'Item', 'Room', 'Trade', 'Quantity', 'Unit', 'Rate', 'Wastage %', 'Amount', 'Optional', 'Rate source', 'Status']

/** Every live line, then the totals, as CSV rows (plain numbers, no ₹). */
export function estimateCsvRows(items: BoqItem[], s: EstimateSettings): Cell[][] {
  const lines = sortedLines(items)
  const t = estimateTotals(lines, s)
  const rows: Cell[][] = [CSV_HEADER]
  for (const i of lines) {
    rows.push([
      i.category, i.item, i.room ?? '', i.trade ?? '', num(i.quantity), i.unit, num(i.rate), num(i.wastage_pct),
      round2(lineAmount(i)), i.optional, i.rate_source ?? '', i.verified ? 'Verified' : 'Unverified',
    ])
  }
  rows.push([])
  rows.push(['Subtotal (optional lines left out)', '', '', '', '', '', '', '', t.subtotal])
  rows.push([`Contingency ${num(s.contingency_pct)}%`, '', '', '', '', '', '', '', t.contingency])
  rows.push(['Taxable amount', '', '', '', '', '', '', '', t.taxable])
  rows.push([`GST ${num(s.estimate_gst_rate)}%`, '', '', '', '', '', '', '', t.gst])
  rows.push(['Total', '', '', '', '', '', '', '', t.total])
  return rows
}

/** A file-name-safe version of a project name. */
export function fileSlug(name: string): string {
  return name.trim().replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'project'
}
