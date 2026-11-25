import { saveFile } from '../../backup'
import { todayLocal } from '../../drawings'
import type { BoqItem } from '../../domain'
import type { EstimateSettings } from '../../estimate'
import { estimateCsvRows, fileSlug } from '../../money/boq'
import { clientPdfModel, renderClientPdf, type PdfTicks } from '../../money/clientPdf'
import { toCsv } from '../../money/csv'
import type { MoneyData } from '../../money/useMoney'
import { estimateWorkbook, XLSX_MIME } from '../../money/xlsx'

const head = (d: MoneyData) => ({ projectName: d.project?.name ?? 'Project', clientName: d.brief?.client_name ?? null, studioName: d.studioName })

export async function exportXlsx(d: MoneyData, items: BoqItem[], s: EstimateSettings) {
  const buf = await estimateWorkbook(items, s, head(d))
  await saveFile(new Blob([buf], { type: XLSX_MIME }), `${fileSlug(head(d).projectName)}-estimate.xlsx`)
}

export async function exportCsv(d: MoneyData, items: BoqItem[], s: EstimateSettings) {
  await saveFile(new Blob([toCsv(estimateCsvRows(items, s))], { type: 'text/csv;charset=utf-8' }), `${fileSlug(head(d).projectName)}-estimate.csv`)
}

export async function exportClientPdf(d: MoneyData, items: BoqItem[], s: EstimateSettings, ticks: PdfTicks) {
  const model = clientPdfModel(items, s, ticks)
  const blob = await renderClientPdf(model, { ...head(d), date: todayLocal() })
  await saveFile(blob, `${fileSlug(head(d).projectName)}-estimate-client.pdf`)
}
