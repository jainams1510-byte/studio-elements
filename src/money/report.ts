/** The client's read-only budget view as plain text (to share or copy): category totals, then every non-optional line. */
import type { BoqItem } from '../domain'
import { estimateTotals, lineAmount, type EstimateSettings } from '../estimate'
import { inr, num } from '../format'
import { groupByCategory } from './boq'
import { DISCLAIMER } from './clientPdf'

export function clientReportText(a: { projectName: string; clientName: string | null; studioName: string; items: BoqItem[]; settings: EstimateSettings }): string {
  const lines = a.items.filter((i) => !i.removed_at && !i.optional)
  const t = estimateTotals(lines, a.settings)
  const groups = groupByCategory(lines)
  const out: string[] = [`${a.projectName}: budget summary`]
  if (a.clientName) out.push(`Client: ${a.clientName}`)
  out.push(DISCLAIMER, '', 'By category')
  for (const g of groups) out.push(`${g.category}: ${inr(t.byCategory[g.category] ?? 0)}`)
  out.push('', 'Every item')
  for (const g of groups) {
    out.push('', g.category)
    for (const i of g.items) {
      const qty = `${num(i.quantity).toLocaleString('en-IN', { maximumFractionDigits: 3 })} ${i.unit}`
      out.push(`• ${[i.item, i.room, qty].filter(Boolean).join(' · ')}: ${inr(lineAmount(i))}`)
    }
  }
  out.push(
    '',
    `Subtotal: ${inr(t.subtotal)}`,
    `Contingency (${num(a.settings.contingency_pct)}%): ${inr(t.contingency)}`,
    `GST (${num(a.settings.estimate_gst_rate)}%): ${inr(t.gst)}`,
    `Total: ${inr(t.total)}`,
    '',
    a.studioName,
  )
  return out.join('\n')
}
