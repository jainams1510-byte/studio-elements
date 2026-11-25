/**
 * Estimate workbook with live formulas, laid out like Project Studio's export:
 *   "Estimate": one row per live line; Amount = D × F × (1 + G / 100).
 *   "Summary": category subtotals by SUMIFS over non-optional lines, then subtotal, contingency, taxable, GST, total,
 *   cost per sq. ft. and the budget comparison. Each formula also carries its computed value for viewers that do not recalculate.
 * exceljs is loaded only when an export is asked for.
 */
import type { BoqItem } from '../domain'
import { estimateTotals, lineAmount, type EstimateSettings } from '../estimate'
import { areaSqft, num, round2 } from '../format'
import { groupByCategory, sortedLines } from './boq'
import { DISCLAIMER } from './clientPdf'

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

type Head = { projectName: string; clientName: string | null; studioName: string }

export async function estimateWorkbook(items: BoqItem[], s: EstimateSettings, head: Head): Promise<ArrayBuffer> {
  const mod = (await import('exceljs')) as unknown as { default?: typeof import('exceljs') } & typeof import('exceljs')
  const ExcelJS = mod.default ?? mod
  const wb = new ExcelJS.Workbook()
  wb.creator = head.studioName
  const summary = wb.addWorksheet('Summary')
  const est = wb.addWorksheet('Estimate')
  const money = '#,##0.00'

  // ---- Estimate sheet
  est.columns = [
    { header: 'Category', key: 'category', width: 30 },
    { header: 'Item', key: 'item', width: 36 },
    { header: 'Room', key: 'room', width: 16 },
    { header: 'Qty', key: 'qty', width: 10 },
    { header: 'Unit', key: 'unit', width: 11 },
    { header: 'Rate', key: 'rate', width: 13 },
    { header: 'Wastage %', key: 'waste', width: 11 },
    { header: 'Amount', key: 'amount', width: 15 },
    { header: 'Optional', key: 'optional', width: 10 },
    { header: 'Trade', key: 'trade', width: 14 },
    { header: 'Rate source', key: 'src', width: 22 },
    { header: 'Status', key: 'status', width: 12 },
  ]
  est.getRow(1).font = { bold: true }
  est.views = [{ state: 'frozen', ySplit: 1 }]
  const lines = sortedLines(items)
  lines.forEach((i, n) => {
    const r = n + 2
    est.addRow({
      category: i.category, item: i.item, room: i.room ?? '', qty: num(i.quantity), unit: i.unit, rate: num(i.rate),
      waste: num(i.wastage_pct), optional: i.optional ? 'Yes' : 'No', trade: i.trade ?? '', src: i.rate_source ?? '',
      status: i.verified ? 'Verified' : 'Unverified',
    })
    est.getCell(`H${r}`).value = { formula: `D${r}*F${r}*(1+G${r}/100)`, result: round2(lineAmount(i)) }
    est.getCell(`F${r}`).numFmt = money
    est.getCell(`H${r}`).numFmt = money
  })

  // ---- Summary sheet
  const t = estimateTotals(lines, s)
  summary.columns = [{ width: 40 }, { width: 18 }, { width: 10 }]
  summary.getCell('A1').value = `Estimate: ${head.projectName}`
  summary.getCell('A1').font = { bold: true, size: 14 }
  summary.getCell('A2').value = head.clientName ? `Client: ${head.clientName}` : head.studioName
  summary.getCell('A3').value = DISCLAIMER
  summary.getRow(5).values = ['Category', 'Amount', 'Rate %']
  summary.getRow(5).font = { bold: true }
  let r = 6
  const first = r
  for (const g of groupByCategory(lines)) {
    summary.getCell(`A${r}`).value = g.category
    summary.getCell(`B${r}`).value = {
      formula: `SUMIFS(Estimate!$H:$H,Estimate!$A:$A,A${r},Estimate!$I:$I,"No")`,
      result: t.byCategory[g.category] ?? 0,
    }
    r++
  }
  const last = r - 1
  const put = (label: string, formula: string, result: number | string, rate?: number) => {
    summary.getCell(`A${r}`).value = label
    summary.getCell(`B${r}`).value = { formula, result } as never
    summary.getCell(`B${r}`).numFmt = money
    if (rate !== undefined) summary.getCell(`C${r}`).value = rate
    return r++
  }
  const sub = put('Subtotal', last >= first ? `SUM(B${first}:B${last})` : '0', t.subtotal)
  summary.getCell(`A${sub}`).font = { bold: true }
  const cont = put('Contingency', `B${sub}*C${r}/100`, t.contingency, num(s.contingency_pct))
  const tax = put('Taxable amount', `B${sub}+B${cont}`, t.taxable)
  const gst = put('GST', `B${tax}*C${r}/100`, t.gst, num(s.estimate_gst_rate))
  const total = put('Total', `B${tax}+B${gst}`, t.total)
  summary.getCell(`A${total}`).font = { bold: true }
  summary.getCell(`B${total}`).font = { bold: true }
  r++
  const sqft = round2(areaSqft(s.area, s.area_unit))
  summary.getCell(`A${r}`).value = 'Area (sq. ft.)'
  summary.getCell(`B${r}`).value = sqft || null
  const area = r++
  put('Cost per sq. ft. (before GST)', `IF(N(B${area})>0,B${tax}/B${area},"")`, t.perSqft || '')
  summary.getCell(`A${r}`).value = 'Client budget'
  summary.getCell(`B${r}`).value = t.budget
  summary.getCell(`B${r}`).numFmt = money
  const budget = r++
  summary.getCell(`A${r}`).value = 'Budget includes GST'
  summary.getCell(`B${r}`).value = s.budget_includes_gst ? 'Yes' : 'No'
  const incl = r++
  put(
    'Budget minus estimate (negative = over budget)',
    `IF(N(B${budget})=0,"",B${budget}-IF(B${incl}="Yes",B${total},B${tax}))`,
    t.variance ?? '',
  )
  return (await wb.xlsx.writeBuffer()) as ArrayBuffer
}
