import { describe, expect, it } from 'vitest'
import type { BoqItem, Quote, RaBill, RaBillLine, Variation, Vendor } from '../domain'
import { estimateCsvRows, settingsFromBrief, sortedLines } from './boq'
import { payable, stepPatch, suggestedCertified, unpaidDays } from './bills'
import { clientPdfModel, pdfSafe, pdfTicks } from './clientPdf'
import { csvCell, toCsv } from './csv'
import { raBillDrafts } from './drafts'
import { buildLedger, overrunText } from './ledger'
import { compareQuotes } from './quotes'
import { clientReportText } from './report'
import { estimateWorkbook } from './xlsx'

const P = 'p1'
function item(id: string, o: Partial<BoqItem>): BoqItem {
  return {
    id, project_id: P, category: 'Other', trade: null, room: null, item: id, unit: 'no.', quantity: 0, rate: 0, wastage_pct: 0,
    rate_source: '', verified: false, optional: false, work_order_id: null, committed_rate: null, sort_order: 0, removed_at: null, ...o,
  }
}
function bill(id: string, o: Partial<RaBill>): RaBill {
  return {
    id, project_id: P, vendor_id: 'v1', work_order_id: null, bill_no: id, bill_date: '2026-11-01', claimed_amount: 0,
    certified_amount: null, gst_rate: 18, status: 'submitted', certified_on: null, client_approved_on: null, paid_on: null,
    paid_amount: null, note: '', file_link: null, removed_at: null, ...o,
  }
}
const bl = (id: string, bill_id: string, boq_item_id: string, certified_qty: number, rate: number | null = null): RaBillLine => ({
  id, bill_id, boq_item_id, claimed_qty: certified_qty, certified_qty, rate,
})
const variation = (id: string, boq: string | null, removed = false): Variation => ({
  id, project_id: P, decision_id: null, boq_item_id: boq, description: 'v', amount: 1000, status: 'proposed', client_approved_on: null,
  removed_at: removed ? '2026-11-20T00:00:00Z' : null,
})

// Hand-worked set used across the tests:
//   A tiles     1,000 sq ft × ₹120 + 5% = 1,26,000 budget; no work order.
//   B wardrobe  2 × ₹45,000 = 90,000 budget; on work order w1 at ₹42,000 → committed 84,000.
//   C bar unit  optional, 1 × ₹60,000; on w2 at ₹58,000 → committed 58,000; left out of budget totals.
//   D removed   ignored everywhere.
const items: BoqItem[] = [
  item('A', { category: 'Flooring and skirting', item: 'Vitrified tiles', trade: 'Civil', room: 'Living', unit: 'sq. ft.', quantity: 1000, rate: 120, wastage_pct: 5, verified: true, rate_source: 'Agency quote' }),
  item('B', { category: 'Wardrobes and storage', item: 'Wardrobe shutters', trade: 'Carpentry', room: 'Bedroom', quantity: 2, rate: 45000, work_order_id: 'w1', committed_rate: 42000 }),
  item('C', { category: 'Loose furniture', item: 'Bar unit', trade: 'Carpentry', quantity: 1, rate: 60000, optional: true, work_order_id: 'w2', committed_rate: 58000 }),
  item('D', { category: 'Kitchen', item: 'Old line', trade: 'Carpentry', quantity: 1, rate: 99999, removed_at: '2026-11-20T00:00:00Z' }),
]
const settings = { contingency_pct: 5, estimate_gst_rate: 18, client_budget: 250000, budget_includes_gst: false, area: 1200, area_unit: 'sq. ft.' }

describe('ledger', () => {
  // Bills: b1 paid (B: 2 at its committed ₹42,000 = 84,000); b2 certified (A: 1,150 × ₹120 = 1,38,000);
  // b3 only submitted and b4 removed: both ignored; a line on the removed item D is ignored.
  const bills = [
    bill('b1', { status: 'paid', certified_amount: 84000 }),
    bill('b2', { status: 'certified', certified_amount: 138000 }),
    bill('b3', { status: 'submitted' }),
    bill('b4', { status: 'paid', removed_at: '2026-11-21T00:00:00Z' }),
  ]
  const lines = [bl('l1', 'b1', 'B', 2), bl('l2', 'b2', 'A', 1150, 120), bl('l3', 'b3', 'A', 500, 120), bl('l4', 'b4', 'B', 1, 42000), bl('l5', 'b1', 'D', 1, 10)]

  it('works out budget, committed, certified and paid per line', () => {
    const L = buildLedger(items, bills, lines, [])
    expect(L.lines.A).toMatchObject({ budget: 126000, committed: 0, certified: 138000, paid: 0 })
    expect(L.lines.B).toMatchObject({ budget: 90000, committed: 84000, certified: 84000, paid: 84000 })
    expect(L.lines.C).toMatchObject({ budget: 60000, committed: 58000, certified: 0, paid: 0 })
    expect(L.lines.D).toBeUndefined()
  })

  it('totals per category and overall (optional lines out of the budget only)', () => {
    const L = buildLedger(items, bills, lines, [])
    expect(L.categories['Loose furniture']).toEqual({ budget: 0, committed: 58000, certified: 0, paid: 0 })
    expect(L.categories['Flooring and skirting']).toEqual({ budget: 126000, committed: 0, certified: 138000, paid: 0 })
    expect(L.total).toEqual({ budget: 216000, committed: 142000, certified: 222000, paid: 84000 })
  })

  it('flags a line certified more than 5% over budget unless a live variation is linked', () => {
    const L = buildLedger(items, bills, lines, [])
    expect(L.lines.A.overrun).toBe(true) // 1,38,000 > 1,32,300
    expect(L.lines.A.overPct).toBe(9.52) // 12,000 / 1,26,000
    expect(overrunText(L.lines.A)).toBe('Over budget by 9.5% — needs a variation')
    expect(L.lines.B.overrun).toBe(false)
    expect(buildLedger(items, bills, lines, [variation('x', 'A')]).lines.A.overrun).toBe(false)
    expect(buildLedger(items, bills, lines, [variation('x', 'A', true)]).lines.A.overrun).toBe(true) // removed variation does not count
    expect(buildLedger(items, bills, lines, [variation('x', 'B')]).lines.A.overrun).toBe(true) // variation on another line
  })

  it('does not flag exactly 5% over', () => {
    const at5 = [bl('l2', 'b2', 'A', 1102.5, 120)] // 1,32,300 = budget × 1.05
    expect(buildLedger(items, bills, at5, []).lines.A.overrun).toBe(false)
    const above = [bl('l2', 'b2', 'A', 1103, 120)] // 1,32,360
    expect(buildLedger(items, bills, above, []).lines.A.overrun).toBe(true)
  })
})

describe('quote comparison', () => {
  const q = (id: string, trade: string | null, amount: number, status: Quote['status'] = 'received', removed = false): Quote => ({
    id, project_id: P, vendor_id: 'v' + id, trade, amount, received_on: '2026-11-10', status, note: '', file_link: null,
    removed_at: removed ? '2026-11-20T00:00:00Z' : null,
  })
  const quotes = [q('1', 'Carpentry', 85000), q('2', 'carpentry', 92000), q('3', 'Carpentry', 80000, 'rejected'), q('4', 'Electrical', 30000), q('5', 'Carpentry', 1000, 'received', true), q('6', null, 5000)]

  it('groups by trade, marks the lowest live quote and compares with the trade estimate', () => {
    const c = compareQuotes(quotes, items)
    expect(c.map((g) => g.trade)).toEqual(['Carpentry', 'Electrical', 'No trade'])
    const carp = c[0]
    expect(carp.budget).toBe(90000) // B only: C is optional, D removed
    expect(carp.quotes.map((x) => x.quote.id)).toEqual(['3', '1', '2'])
    expect(carp.lowestId).toBe('1') // 3 is cheaper but rejected
    expect(carp.quotes.map((x) => x.diff)).toEqual([-10000, -5000, 2000])
    expect(c[1]).toMatchObject({ budget: 0, lines: 0, lowestId: '4' })
    expect(c[1].quotes[0].diff).toBeNull()
  })
})

describe('RA bills', () => {
  const itemsById = new Map(items.map((i) => [i.id, i]))
  it('suggests the certified amount from the lines', () => {
    expect(suggestedCertified([bl('a', 'b', 'B', 2), bl('b', 'b', 'A', 100, 120)], itemsById)).toBe(96000) // 84,000 + 12,000
  })

  it('stamps and clears dates like the database', () => {
    const b = bill('b', { status: 'measured' })
    expect(stepPatch(b, 'certified', '2026-11-23', { certifiedAmount: 84000 })).toEqual({
      status: 'certified', certified_amount: 84000, certified_on: '2026-11-23', client_approved_on: null, paid_on: null, paid_amount: null,
    })
    const approved = bill('b', { status: 'client_approved', certified_amount: 84000, certified_on: '2026-11-10', client_approved_on: '2026-11-12' })
    expect(stepPatch(approved, 'paid', '2026-11-23')).toMatchObject({ certified_on: '2026-11-10', client_approved_on: '2026-11-12', paid_on: '2026-11-23', paid_amount: 99120 })
    expect(stepPatch({ ...approved, status: 'paid', paid_on: '2026-11-20', paid_amount: 99120 }, 'measured', '2026-11-23')).toEqual({
      status: 'measured', certified_on: null, client_approved_on: null, paid_on: null, paid_amount: null,
    })
    expect(payable({ certified_amount: 84000, claimed_amount: 90000, gst_rate: 18 })).toEqual({ base: 84000, gst: 15120, total: 99120 })
  })

  it('flags unpaid bills only after more than 7 days', () => {
    const b = bill('b', { status: 'client_approved', client_approved_on: '2026-11-16' })
    expect(unpaidDays(b, '2026-11-23')).toBeNull() // exactly 7
    expect(unpaidDays(b, '2026-11-24')).toBe(8)
    expect(unpaidDays({ ...b, status: 'paid' }, '2026-12-30')).toBeNull()
  })
})

describe('raBillDrafts', () => {
  const vendors: Vendor[] = [{ id: 'v1', name: 'Shree Interiors', kind: 'agency', trade: null, contact_name: null, phone: null, email: null, gstin: null, notes: '', archived: false }]
  const projects = [{ id: P, name: 'Sparsh Ekaya' }]
  const late = bill('b1', { bill_no: '3', bill_date: '2026-11-02', status: 'client_approved', certified_amount: 84000, client_approved_on: '2026-11-13' })
  const base = { projects, vendors, today: '2026-11-23' }

  it('drafts a polite client reminder with amounts and dates', () => {
    const [d, ...rest] = raBillDrafts({ ...base, bills: [late] })
    expect(rest).toHaveLength(0)
    expect(d).toMatchObject({ kind: 'client', to: 'Client', projectId: P, projectName: 'Sparsh Ekaya', subject: 'Payment due: Shree Interiors RA bill 3' })
    expect(d.why).toContain('10 days ago')
    for (const s of ['₹ 84,000.00', '18% (₹ 15,120.00)', '₹ 99,120.00', '13 Nov 2026', '2 Nov 2026']) expect(d.body).toContain(s)
  })

  it('leaves out bills that are recent, paid, removed or from unknown projects', () => {
    const bills = [
      { ...late, id: 'x1', client_approved_on: '2026-11-16' },
      { ...late, id: 'x2', status: 'paid' as const },
      { ...late, id: 'x3', removed_at: '2026-11-22T00:00:00Z' },
      { ...late, id: 'x4', project_id: 'other' },
    ]
    expect(raBillDrafts({ ...base, bills })).toEqual([])
  })

  it('changes its key when the amount changes', () => {
    const k1 = raBillDrafts({ ...base, bills: [late] })[0].key
    const k2 = raBillDrafts({ ...base, bills: [{ ...late, certified_amount: 90000 }] })[0].key
    expect(k1).not.toBe(k2)
    expect(raBillDrafts({ ...base, bills: [late] })[0].key).toBe(k1)
  })
})

describe('CSV', () => {
  it('escapes cells', () => {
    expect(csvCell('plain')).toBe('plain')
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('He said "hi"')).toBe('"He said ""hi"""')
    expect(csvCell('two\nlines')).toBe('"two\nlines"')
    expect(csvCell(' padded')).toBe('" padded"')
    expect(csvCell('=SUM(A1:A9)')).toBe("'=SUM(A1:A9)")
    expect(csvCell('+91 98')).toBe("'+91 98")
    expect(csvCell('-5')).toBe('-5')
    expect(csvCell(1.5)).toBe('1.5')
    expect(csvCell(null)).toBe('')
    expect(csvCell(true)).toBe('Yes')
    expect(toCsv([['a', 'b'], [1, 'x,y']])).toBe('﻿a,b\r\n1,"x,y"\r\n')
  })

  it('lists live lines with amounts and the totals', () => {
    const rows = estimateCsvRows(items, settings)
    expect(rows.slice(1, 4).map((r) => [r[1], r[8]])).toEqual([['Vitrified tiles', 126000], ['Wardrobe shutters', 90000], ['Bar unit', 60000]])
    expect(rows.find((r) => r[0] === 'Total')?.[8]).toBe(267624)
    expect(rows.some((r) => r[1] === 'Old line')).toBe(false)
  })
})

describe('client PDF', () => {
  it('shows client details by default and hides internal ones', () => {
    const t = pdfTicks(null)
    expect(t).toMatchObject({ room: true, qty: true, optional: true, cat: true, cont: true, gst: true, rate: false, waste: false, src: false, status: false, psf: false, budget: false })
    const m = clientPdfModel(items, settings, t, String)
    expect(m.columns.map((c) => c.key)).toEqual(['item', 'room', 'qty', 'amount'])
    expect(m.groups.map((g) => g.category)).toEqual(['Flooring and skirting', 'Wardrobes and storage', 'Loose furniture'])
    expect(m.groups[2].rows[0][0]).toBe('Bar unit (optional, not in total)')
    expect(m.groups[0].rows[0]).toEqual(['Vitrified tiles', 'Living', '1,000 sq. ft.', '126000'])
    expect(m.summary.map((s) => [s.label, s.value])).toEqual([
      ['Subtotal', '216000'], ['Contingency (5%)', '10800'], ['Taxable amount', '226800'], ['GST (18%)', '40824'], ['Total', '267624'],
    ])
  })

  it('follows the ticks', () => {
    const t = pdfTicks({ room: false, optional: false, cat: false, cont: false, gst: false, rate: true, status: true, psf: true, budget: true })
    const m = clientPdfModel(items, settings, t, String)
    expect(m.columns.map((c) => c.key)).toEqual(['item', 'qty', 'rate', 'amount', 'status'])
    expect(m.groups).toHaveLength(1)
    expect(m.groups[0].rows.map((r) => r[0])).toEqual(['Vitrified tiles', 'Wardrobe shutters'])
    expect(m.groups[0].rows[0]).toEqual(['Vitrified tiles', '1,000 sq. ft.', '120', '126000', 'Verified'])
    expect(m.summary.map((s) => [s.label, s.value])).toEqual([
      ['Subtotal', '216000'], ['Total (excluding GST)', '226800'], ['Cost per sq. ft. (before GST)', '189'],
      ['Client budget', '250000'], ['Within budget. Remaining', '23200'],
    ])
    expect(m.notes).toEqual(['The totals include a contingency allowance.', 'GST is extra as applicable.'])
  })

  it('writes text the built-in PDF fonts can draw', () => {
    expect(pdfSafe('₹ 5,000 — “Teak” ‘x’')).toBe('Rs. 5,000 - "Teak" \'x\'')
    expect(pdfSafe('ગુજ')).toBe('???')
  })
})

describe('client report text', () => {
  it('has category totals, every non-optional line and the totals', () => {
    const text = clientReportText({ projectName: 'Sparsh Ekaya', clientName: 'Mr Shah', studioName: 'Studio Elements', items, settings })
    expect(text).toContain('Flooring and skirting: ₹ 1,26,000')
    expect(text).toContain('• Vitrified tiles · Living · 1,000 sq. ft.: ₹ 1,26,000')
    expect(text).toContain('• Wardrobe shutters · Bedroom · 2 no.: ₹ 90,000')
    expect(text).not.toContain('Bar unit')
    expect(text).not.toContain('Old line')
    for (const s of ['Subtotal: ₹ 2,16,000', 'Contingency (5%): ₹ 10,800', 'GST (18%): ₹ 40,824', 'Total: ₹ 2,67,624']) expect(text).toContain(s)
  })
})

describe('estimate workbook', () => {
  it('writes live formulas with their values', async () => {
    const buf = await estimateWorkbook(items, settings, { projectName: 'Sparsh Ekaya', clientName: 'Mr Shah', studioName: 'Studio Elements' })
    const ExcelJS = (await import('exceljs')).default
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buf)
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Summary', 'Estimate'])
    const est = wb.getWorksheet('Estimate')!
    const order = sortedLines(items)
    expect(est.getCell('B2').value).toBe(order[0].item)
    expect(est.getCell('H2').value).toEqual({ formula: 'D2*F2*(1+G2/100)', result: 126000 })
    expect(est.getCell('I4').value).toBe('Yes') // the optional bar unit
    const sum = wb.getWorksheet('Summary')!
    const byLabel = (label: string) => {
      let found: unknown = null
      sum.eachRow((row) => { if (row.getCell(1).value === label) found = row.getCell(2).value })
      return found as { formula: string; result: number }
    }
    expect(byLabel('Flooring and skirting').formula).toBe('SUMIFS(Estimate!$H:$H,Estimate!$A:$A,A6,Estimate!$I:$I,"No")')
    expect(byLabel('Subtotal')).toEqual({ formula: 'SUM(B6:B8)', result: 216000 })
    expect(byLabel('Contingency')).toEqual({ formula: 'B9*C10/100', result: 10800 })
    expect(byLabel('Taxable amount')).toEqual({ formula: 'B9+B10', result: 226800 })
    expect(byLabel('GST')).toEqual({ formula: 'B11*C12/100', result: 40824 })
    expect(byLabel('Total')).toEqual({ formula: 'B11+B12', result: 267624 })
    expect(sum.getCell('C10').value).toBe(5)
    expect(sum.getCell('C12').value).toBe(18)
  })
})

describe('settings from the brief', () => {
  it('falls back to the defaults without a brief', () => {
    expect(settingsFromBrief(null)).toEqual({ contingency_pct: 5, estimate_gst_rate: 18, client_budget: null, budget_includes_gst: false, area: null, area_unit: 'sq. ft.' })
    expect(settingsFromBrief({ contingency_pct: 10, estimate_gst_rate: 12, client_budget: 500000, area: 100, area_unit: 'sq. m.' } as never)).toMatchObject({ contingency_pct: 10, estimate_gst_rate: 12, client_budget: 500000, area: 100, area_unit: 'sq. m.' })
  })
})
