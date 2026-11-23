/**
 * The client estimate PDF. The model (what is shown) is pure and tested; the drawing uses jsPDF, loaded only when needed.
 * Which internal details appear follows project_briefs.estimate_pdf (Project Studio's "Client PDF" ticks).
 */
import { type BoqItem } from '../domain'
import { estimateTotals, lineAmount, type EstimateSettings } from '../estimate'
import { inr, longDate, num } from '../format'
import { groupByCategory } from './boq'

export const PDF_TICKS = [
  { key: 'room', label: 'Room', internal: false },
  { key: 'qty', label: 'Quantity and unit', internal: false },
  { key: 'optional', label: 'Optional lines', internal: false },
  { key: 'cat', label: 'Category subtotals', internal: false },
  { key: 'cont', label: 'Contingency', internal: false },
  { key: 'gst', label: 'GST', internal: false },
  { key: 'psf', label: 'Cost per sq. ft.', internal: true },
  { key: 'budget', label: 'Client budget', internal: true },
  { key: 'rate', label: 'Rates', internal: true },
  { key: 'waste', label: 'Wastage %', internal: true },
  { key: 'src', label: 'Rate source', internal: true },
  { key: 'status', label: 'Verified / unverified', internal: true },
] as const
export type PdfKey = (typeof PDF_TICKS)[number]['key']
export type PdfTicks = Record<PdfKey, boolean>

/** Stored ticks merged over the defaults: client-facing details on, internal ones off unless ticked. */
export function pdfTicks(raw: Record<string, boolean> | null | undefined): PdfTicks {
  const out = {} as PdfTicks
  for (const t of PDF_TICKS) out[t.key] = typeof raw?.[t.key] === 'boolean' ? Boolean(raw[t.key]) : !t.internal
  return out
}

export const DISCLAIMER = 'Draft estimate. Figures are subject to verification and final specification.'

/** Rupees for the PDF: jsPDF's built-in fonts have no ₹ sign. */
export const rs = (v: number) => inr(v).replace('₹', 'Rs.')

/** Text the built-in PDF fonts can draw: ₹ → Rs., common punctuation to plain forms, anything else outside Latin-1 to "?". */
export function pdfSafe(s: string): string {
  return s
    .replace(/₹\s?/g, 'Rs. ')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/…/g, '...')
    .replace(/ /g, ' ')
    .replace(/[^\x20-\x7E¡-ÿ\n]/g, '?')
}

export type PdfColumn = { key: string; label: string; align: 'left' | 'right'; weight: number }
export type PdfGroup = { category: string | null; rows: string[][]; subtotal: string | null }
export type PdfModel = { columns: PdfColumn[]; groups: PdfGroup[]; summary: { label: string; value: string; strong?: boolean }[]; notes: string[] }

const qtyText = (i: BoqItem) => `${num(i.quantity).toLocaleString('en-IN', { maximumFractionDigits: 3 })} ${i.unit}`

export function clientPdfModel(items: BoqItem[], s: EstimateSettings, ticks: PdfTicks, money: (v: number) => string = rs): PdfModel {
  const columns: PdfColumn[] = [{ key: 'item', label: 'Item', align: 'left', weight: 3 }]
  if (ticks.room) columns.push({ key: 'room', label: 'Room', align: 'left', weight: 1.6 })
  if (ticks.qty) columns.push({ key: 'qty', label: 'Qty', align: 'right', weight: 1.4 })
  if (ticks.rate) columns.push({ key: 'rate', label: 'Rate', align: 'right', weight: 1.3 })
  if (ticks.waste) columns.push({ key: 'waste', label: 'Waste', align: 'right', weight: 0.8 })
  columns.push({ key: 'amount', label: 'Amount', align: 'right', weight: 1.6 })
  if (ticks.src) columns.push({ key: 'src', label: 'Rate source', align: 'left', weight: 1.6 })
  if (ticks.status) columns.push({ key: 'status', label: 'Status', align: 'left', weight: 1.1 })

  const shown = items.filter((i) => !i.removed_at && (ticks.optional || !i.optional))
  const t = estimateTotals(items, s)
  const cell = (i: BoqItem, key: string): string => {
    switch (key) {
      case 'item': return i.item + (i.optional ? ' (optional, not in total)' : '')
      case 'room': return i.room ?? ''
      case 'qty': return qtyText(i)
      case 'rate': return money(num(i.rate))
      case 'waste': return num(i.wastage_pct) ? `${num(i.wastage_pct)}%` : ''
      case 'amount': return money(lineAmount(i))
      case 'src': return i.rate_source ?? ''
      case 'status': return i.verified ? 'Verified' : 'Unverified'
      default: return ''
    }
  }
  const toRow = (i: BoqItem) => columns.map((c) => cell(i, c.key))
  const groups: PdfGroup[] = ticks.cat
    ? groupByCategory(shown).map((g) => ({ category: g.category, rows: g.items.map(toRow), subtotal: money(t.byCategory[g.category] ?? 0) }))
    : [{ category: null, rows: groupByCategory(shown).flatMap((g) => g.items).map(toRow), subtotal: null }]

  const summary: PdfModel['summary'] = [{ label: 'Subtotal', value: money(t.subtotal) }]
  const notes: string[] = []
  if (ticks.cont) summary.push({ label: `Contingency (${num(s.contingency_pct)}%)`, value: money(t.contingency) })
  else if (t.contingency) notes.push('The totals include a contingency allowance.')
  if (ticks.gst) {
    if (ticks.cont) summary.push({ label: 'Taxable amount', value: money(t.taxable) })
    summary.push({ label: `GST (${num(s.estimate_gst_rate)}%)`, value: money(t.gst) })
    summary.push({ label: 'Total', value: money(t.total), strong: true })
  } else {
    summary.push({ label: 'Total (excluding GST)', value: money(t.taxable), strong: true })
    notes.push('GST is extra as applicable.')
  }
  if (ticks.psf && t.perSqft) summary.push({ label: 'Cost per sq. ft. (before GST)', value: money(t.perSqft) })
  if (ticks.budget && t.budget !== null && t.variance !== null) {
    summary.push({ label: 'Client budget', value: money(t.budget) })
    summary.push(
      t.variance < 0
        ? { label: 'Estimate exceeds budget by', value: money(-t.variance) }
        : { label: 'Within budget. Remaining', value: money(t.variance) },
    )
  }
  if (ticks.optional && shown.some((i) => i.optional)) notes.push('Optional lines are shown for reference and are not in the total.')
  return { columns, groups, summary, notes }
}

export type PdfHeader = { studioName: string; projectName: string; clientName: string | null; date: string }

/** Draws the model on A4 and returns the PDF file. */
export async function renderClientPdf(model: PdfModel, head: PdfHeader): Promise<Blob> {
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  const W = 210
  const M = 14
  const inner = W - 2 * M
  const bottom = 297 - 18
  const ink: [number, number, number] = [43, 43, 41]
  const muted: [number, number, number] = [95, 92, 86]
  const accent: [number, number, number] = [47, 93, 70]
  const line: [number, number, number] = [217, 214, 207]
  let y = M + 4

  doc.setTextColor(...accent)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(15)
  doc.text(pdfSafe(head.studioName), M, y)
  y += 9
  doc.setTextColor(...ink)
  doc.setFontSize(12)
  doc.text(pdfSafe(`Estimate: ${head.projectName}`), M, y)
  y += 6
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9.5)
  doc.setTextColor(...muted)
  if (head.clientName) {
    doc.text(pdfSafe(`Client: ${head.clientName}`), M, y)
    y += 5
  }
  doc.text(pdfSafe(`Date: ${longDate(head.date)}`), M, y)
  y += 5
  doc.text(pdfSafe(DISCLAIMER), M, y)
  y += 4
  doc.setDrawColor(...line)
  doc.line(M, y, W - M, y)
  y += 6

  const totalWeight = model.columns.reduce((s, c) => s + c.weight, 0)
  const widths = model.columns.map((c) => (c.weight / totalWeight) * inner)
  const xs = widths.map((_, i) => M + widths.slice(0, i).reduce((s, w) => s + w, 0))
  const pad = 1.5
  const lineH = 4.2

  const newPage = () => {
    doc.addPage()
    y = M + 4
    header()
  }
  const header = () => {
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(8.5)
    doc.setTextColor(...muted)
    model.columns.forEach((c, i) => {
      const x = c.align === 'right' ? xs[i] + widths[i] - pad : xs[i] + pad
      doc.text(c.label, x, y, { align: c.align })
    })
    y += 2
    doc.setDrawColor(...line)
    doc.line(M, y, W - M, y)
    y += 4.5
  }
  const row = (cells: string[], bold = false) => {
    doc.setFont('helvetica', bold ? 'bold' : 'normal')
    doc.setFontSize(9)
    doc.setTextColor(...ink)
    const wrapped = cells.map((c, i) => doc.splitTextToSize(pdfSafe(c), widths[i] - 2 * pad) as string[])
    const h = Math.max(1, ...wrapped.map((w) => w.length)) * lineH
    if (y + h > bottom) newPage()
    wrapped.forEach((w, i) => {
      const c = model.columns[i]
      const x = c.align === 'right' ? xs[i] + widths[i] - pad : xs[i] + pad
      doc.text(w, x, y, { align: c.align })
    })
    y += h + 1.2
  }

  header()
  for (const g of model.groups) {
    if (g.category) {
      if (y + 12 > bottom) newPage()
      y += 1.5
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(9.5)
      doc.setTextColor(...accent)
      doc.text(pdfSafe(g.category), M + pad, y)
      if (g.subtotal) doc.text(pdfSafe(g.subtotal), W - M - pad, y, { align: 'right' })
      y += 5
    }
    for (const r of g.rows) row(r)
  }

  y += 3
  if (y + 8 * (model.summary.length + model.notes.length) > bottom) newPage()
  doc.setDrawColor(...line)
  doc.line(W / 2, y, W - M, y)
  y += 6
  for (const s of model.summary) {
    doc.setFont('helvetica', s.strong ? 'bold' : 'normal')
    doc.setFontSize(s.strong ? 11 : 9.5)
    doc.setTextColor(...ink)
    doc.text(pdfSafe(s.label), W / 2, y)
    doc.text(pdfSafe(s.value), W - M - pad, y, { align: 'right' })
    y += s.strong ? 7 : 5.5
  }
  if (model.notes.length) {
    y += 2
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8.5)
    doc.setTextColor(...muted)
    for (const n of model.notes) {
      doc.text(pdfSafe(n), M, y)
      y += 4.5
    }
  }
  const pages = doc.getNumberOfPages()
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8)
    doc.setTextColor(...muted)
    doc.text(pdfSafe(`${head.studioName} · ${head.projectName}`), M, 297 - 9)
    doc.text(`Page ${p} of ${pages}`, W - M, 297 - 9, { align: 'right' })
  }
  return doc.output('blob')
}
