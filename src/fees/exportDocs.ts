/**
 * DOCX and PDF exports: the Design Fee Proposal (laid out as in Jainam's Project Studio tool) and a draft
 * fee invoice. The docx and jspdf libraries are loaded only when an export is asked for.
 * jsPDF's built-in fonts have no "₹", so PDFs write "Rs.".
 */
import { MEDIA_BUCKET, supabase } from '../supabase'
import { amountInWords, num, round2 } from '../format'
import {
  DRAFT_NOTE, P, SIGNATURE, TBC, coverRows, fd, fileStem, footerText, headerText, isPlaceholder, proposalBlocks,
  type Block, type ProposalInput,
} from './proposal'
import { invoiceTotals } from './invoices'
import type { FeeInvoice, ProjectBrief } from '../domain'

export type Logo = { bytes: Uint8Array; dataUrl: string; w: number; h: number; type: 'png' | 'jpg' }

const DEFAULT_LOGO = { w: 229, h: 206 }

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error)
    r.readAsDataURL(blob)
  })
}

function imageSize(dataUrl: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve({ w: img.naturalWidth || DEFAULT_LOGO.w, h: img.naturalHeight || DEFAULT_LOGO.h })
    img.onerror = () => resolve(DEFAULT_LOGO)
    img.src = dataUrl
  })
}

/** The studio logo: the custom one from studio settings if set and readable, else the default. Null if neither loads. */
export async function loadLogo(logoPath: string | null | undefined): Promise<Logo | null> {
  let blob: Blob | null = null
  if (logoPath) {
    const { data } = await supabase.storage.from(MEDIA_BUCKET).download(logoPath)
    if (data && data.size > 0) blob = data
  }
  if (!blob) {
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}logo-default.png`)
      if (res.ok) blob = await res.blob()
    } catch {
      blob = null
    }
  }
  if (!blob) return null
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50
  const isJpg = bytes[0] === 0xff && bytes[1] === 0xd8
  if (!isPng && !isJpg) return null
  const dataUrl = await blobToDataUrl(new Blob([bytes], { type: isPng ? 'image/png' : 'image/jpeg' }))
  const size = logoPath ? await imageSize(dataUrl) : DEFAULT_LOGO
  return { bytes, dataUrl, w: size.w, h: size.h, type: isPng ? 'png' : 'jpg' }
}

// ---- DOCX ------------------------------------------------------------------------------------

export async function proposalDocx(input: ProposalInput, logo: Logo | null): Promise<Blob> {
  const D = await import('docx')
  const T = input.studio
  const F = 'Century Gothic'
  const blocks = proposalBlocks(input)
  type RunOpts = { bold?: boolean; italics?: boolean; size?: number; color?: string }
  type ParaOpts = Record<string, unknown>
  const run = (text: string, o: RunOpts = {}) =>
    new D.TextRun({ text, font: F, size: 20, color: isPlaceholder(text) ? 'A23B2A' : '3A3631', ...o, ...(isPlaceholder(text) ? { color: 'A23B2A' } : {}) })
  const para = (text: string, o: RunOpts = {}, po: ParaOpts = {}) => new D.Paragraph({ children: [run(text, o)], spacing: { after: 100 }, ...po })
  const band = (fill: string, children: (InstanceType<typeof D.TextRun> | InstanceType<typeof D.ImageRun>)[], spacing = { before: 80, after: 80 }) =>
    new D.Paragraph({ alignment: D.AlignmentType.CENTER, shading: { type: D.ShadingType.CLEAR, color: 'auto', fill }, spacing, children })
  const table = (rows: string[][], widths: number[], header: 0 | 1 | 2) =>
    new D.Table({
      width: { size: 100, type: D.WidthType.PERCENTAGE },
      rows: rows.map(
        (r, ri) =>
          new D.TableRow({
            children: r.map((c, ci) => {
              const hd = header === 1 && ri === 0
              const bold = hd || String(r[0]).startsWith('TOTAL') || (header === 2 && ci === 0)
              return new D.TableCell({
                width: { size: widths[ci], type: D.WidthType.PERCENTAGE },
                margins: { top: 70, bottom: 70, left: 110, right: 110 },
                shading: hd
                  ? { type: D.ShadingType.CLEAR, color: 'auto', fill: 'E9E1D3' }
                  : ri % 2 === 0 && header === 2
                    ? { type: D.ShadingType.CLEAR, color: 'auto', fill: 'F7F4EF' }
                    : undefined,
                children: [para(c, { bold }, { spacing: { after: 0 } })],
              })
            }),
          }),
      ),
    })

  const ch: (InstanceType<typeof D.Paragraph> | InstanceType<typeof D.Table>)[] = []
  if (logo) {
    ch.push(band('1E1E1E', [new D.ImageRun({ type: logo.type, data: logo.bytes, transformation: { width: 90, height: Math.round((90 * logo.h) / logo.w) } })], { before: 600, after: 0 }))
  }
  ch.push(band('1E1E1E', [run(T.name.toUpperCase(), { bold: true, size: 44, color: 'FFFFFF' })], { before: logo ? 0 : 600, after: 0 }))
  ch.push(band('1E1E1E', [run(T.tagline, { italics: true, size: 20, color: 'C9A266' })], { before: 0, after: 360 }))
  ch.push(band('A8854F', [run('DESIGN FEE PROPOSAL', { bold: true, size: 32, color: 'FFFFFF' })], { before: 120, after: 0 }))
  ch.push(band('A8854F', [run('INTERIOR DESIGN SERVICES', { italics: true, size: 20, color: 'FFFFFF' })], { before: 0, after: 120 }))
  ch.push(para('Transforming spaces into curated living and working environments', { italics: true, color: '6F6759' }, { alignment: D.AlignmentType.CENTER, spacing: { before: 300, after: 200 } }))
  ch.push(table(coverRows(input), [30, 70], 2))
  ch.push(para(`${T.website}   |   ${T.email}   |   ${T.phone}`, { size: 18, color: 'A8854F' }, { alignment: D.AlignmentType.CENTER, spacing: { before: 300 } }))
  ch.push(new D.Paragraph({ children: [new D.PageBreak()] }))
  ch.push(para(DRAFT_NOTE, { bold: true, color: 'A23B2A', size: 18 }))

  for (const b of blocks) {
    if (b.k === 'h') ch.push(para(b.text, { bold: true, size: 24, color: '1E1C19' }, { spacing: { before: 260, after: 100 }, keepNext: true }))
    else if (b.k === 'p') ch.push(para(b.text))
    else if (b.k === 's') ch.push(para(b.text, { bold: true, color: 'A8854F' }, { spacing: { before: 140, after: 60 }, keepNext: true }))
    else if (b.k === 'b') ch.push(para(b.text, {}, { indent: { left: 300, hanging: 300 }, spacing: { after: 50 } }))
    else if (b.k === 't') {
      ch.push(table(b.rows, b.widths, b.header))
      ch.push(para(''))
    } else if (b.k === 'sig') {
      ch.push(
        new D.Table({
          width: { size: 100, type: D.WidthType.PERCENTAGE },
          rows: [
            new D.TableRow({
              children: SIGNATURE.map(
                (col) =>
                  new D.TableCell({
                    width: { size: 50, type: D.WidthType.PERCENTAGE },
                    margins: { top: 100, bottom: 100, left: 120, right: 120 },
                    children: col.map((x, i) => para(x, { bold: i === 0 }, { spacing: { after: 140 } })),
                  }),
              ),
            }),
          ],
        }),
      )
    }
  }

  const header = new D.Header({ children: [para(headerText(input), { size: 16, color: '6F6759' })] })
  const footer = new D.Footer({
    children: [
      new D.Paragraph({
        children: [run(`${footerText(T.name)}   Page `, { size: 16, color: '6F6759' }), new D.TextRun({ children: [D.PageNumber.CURRENT], font: F, size: 16, color: '6F6759' })],
      }),
    ],
  })
  const doc = new D.Document({
    creator: T.name,
    title: `${input.projectName} — Design Fee Proposal`,
    sections: [
      {
        properties: { titlePage: true },
        headers: { default: header, first: new D.Header({ children: [] }) },
        footers: { default: footer, first: new D.Footer({ children: [] }) },
        children: ch,
      },
    ],
  })
  return D.Packer.toBlob(doc)
}

// ---- PDF -------------------------------------------------------------------------------------

type JsPdf = InstanceType<(typeof import('jspdf'))['jsPDF']>

const rs = (s: unknown) => String(s).replace(/₹ ?/g, 'Rs. ')

/** A small text writer over jsPDF (the original tool's Wr): wraps text, adds pages, draws simple tables. */
function writer(d: JsPdf) {
  const W = d.internal.pageSize.getWidth()
  const H = d.internal.pageSize.getHeight()
  const m = 48
  let y = 56
  const room = (need: number) => {
    if (y + need > H - 56) {
      d.addPage()
      y = 56
    }
  }
  return {
    W, H, m,
    get y() { return y },
    set y(v: number) { y = v },
    newPage() { d.addPage(); y = 56 },
    text(s: string, size = 10, bold = false, red = false) {
      d.setFont('helvetica', bold ? 'bold' : 'normal')
      d.setFontSize(size)
      if (red || isPlaceholder(s)) d.setTextColor(162, 59, 42)
      for (const line of d.splitTextToSize(rs(s), W - 2 * m) as string[]) {
        if (y > H - 56) { d.addPage(); y = 56 }
        d.text(line, m, y)
        y += size * 1.4
      }
      d.setTextColor(0, 0, 0)
      y += 2
    },
    pair(a: string, b: string, bold = false) {
      room(15)
      d.setFont('helvetica', bold ? 'bold' : 'normal')
      d.setFontSize(10)
      d.text(rs(a).slice(0, 78), m, y)
      d.text(rs(b), W - m, y, { align: 'right' })
      y += 15
    },
    table(rows: string[][], widths: number[], header: 0 | 1 | 2) {
      const tw = W - 2 * m
      rows.forEach((r, ri) => {
        const lines = r.map((c, ci) => d.splitTextToSize(rs(c), (tw * widths[ci]) / 100 - 10) as string[])
        const n = Math.max(...lines.map((l) => l.length || 1))
        room(n * 12 + 8)
        if (header === 1 && ri === 0) {
          d.setFillColor(233, 225, 211)
          d.rect(m, y - 11, tw, n * 12 + 8, 'F')
        }
        let x = m
        lines.forEach((l, ci) => {
          const bold = (header === 1 && ri === 0) || String(r[0]).startsWith('TOTAL') || (header === 2 && ci === 0)
          d.setFont('helvetica', bold ? 'bold' : 'normal')
          d.setFontSize(9)
          if (l.some(isPlaceholder)) d.setTextColor(162, 59, 42)
          d.text(l, x + 5, y)
          d.setTextColor(0, 0, 0)
          x += (tw * widths[ci]) / 100
        })
        y += n * 12 + 8
        d.setDrawColor(207, 197, 178)
        d.line(m, y - 10, W - m, y - 10)
      })
      y += 6
    },
  }
}

export async function proposalPdf(input: ProposalInput, logo: Logo | null): Promise<Blob> {
  const { jsPDF } = await import('jspdf')
  const d = new jsPDF({ orientation: 'p', unit: 'pt', format: 'a4' })
  const w = writer(d)
  const T = input.studio
  const W = w.W
  // Cover: dark band with the logo, studio name and tagline; gold band with the title.
  d.setFillColor(30, 30, 30)
  d.rect(48, 180, W - 96, 170, 'F')
  if (logo) d.addImage(logo.dataUrl, logo.type === 'png' ? 'PNG' : 'JPEG', W / 2 - 36, 192, 72, (72 * logo.h) / logo.w)
  d.setTextColor(255, 255, 255)
  d.setFont('helvetica', 'bold')
  d.setFontSize(24)
  d.text(rs(T.name.toUpperCase()), W / 2, 300, { align: 'center' })
  d.setFont('helvetica', 'italic')
  d.setFontSize(10)
  d.setTextColor(201, 162, 102)
  d.text(rs(T.tagline), W / 2, 322, { align: 'center' })
  d.setFillColor(168, 133, 79)
  d.rect(48, 350, W - 96, 46, 'F')
  d.setTextColor(255, 255, 255)
  d.setFont('helvetica', 'bold')
  d.setFontSize(16)
  d.text('DESIGN FEE PROPOSAL', W / 2, 372, { align: 'center' })
  d.setFont('helvetica', 'italic')
  d.setFontSize(9)
  d.text('INTERIOR DESIGN SERVICES', W / 2, 387, { align: 'center' })
  d.setTextColor(0, 0, 0)
  w.y = 430
  w.table(coverRows(input), [32, 68], 2)
  d.setFont('helvetica', 'normal')
  d.setFontSize(9)
  d.setTextColor(168, 133, 79)
  d.text(rs(`${T.website}   |   ${T.email}   |   ${T.phone}`), W / 2, 640, { align: 'center' })
  d.setTextColor(0, 0, 0)
  w.newPage()
  w.text(DRAFT_NOTE, 9, true, true)

  for (const b of proposalBlocks(input) as Block[]) {
    if (b.k === 'h') {
      w.text(' ', 4)
      w.text(b.text, 12, true)
    } else if (b.k === 't') w.table(b.rows, b.widths, b.header)
    else if (b.k === 'sig') w.table(SIGNATURE[0].map((x, i) => [x, SIGNATURE[1][i]]), [50, 50], 0)
    else w.text(b.text, 10, b.k === 's')
  }
  // Header line and footer with page numbers on every page after the cover.
  const n = d.getNumberOfPages()
  for (let i = 2; i <= n; i++) {
    d.setPage(i)
    d.setFont('helvetica', 'normal')
    d.setFontSize(8)
    d.setTextColor(111, 103, 89)
    d.text(rs(headerText(input)).slice(0, 120), 48, 30)
    d.text(rs(footerText(T.name)), 48, 816)
    d.text(`Page ${i}`, W - 48, 816, { align: 'right' })
  }
  d.setTextColor(0, 0, 0)
  return d.output('blob')
}

// ---- Invoice PDF ------------------------------------------------------------------------------

export type InvoiceDocInput = {
  projectName: string
  brief: Partial<ProjectBrief> | null
  invoice: FeeInvoice
  due: string | null
  studio: { name: string; tagline: string; website: string; email: string; phone: string; gstin: string }
}

/** "Rupees One Lakh Eighteen Thousand Only", with paise when there are any. */
export function rupeesInWords(v: number): string {
  const r = round2(Math.abs(v))
  const whole = Math.floor(r)
  const paise = Math.round((r - whole) * 100)
  return `Rupees ${amountInWords(whole)}${paise ? ` and ${amountInWords(paise)} Paise` : ''} Only`
}

export const INVOICE_DRAFT_NOTE = 'Draft — check with your CA before issuing.'

/** The lines of the invoice, for the PDF and for tests. */
export function invoiceLines(input: InvoiceDocInput): { label: string; value: string }[] {
  const { invoice: inv, brief } = input
  return [
    { label: 'Invoice no.', value: P(inv.invoice_no) },
    { label: 'Invoice date', value: P(fd(inv.raised_on)) },
    { label: 'Due date', value: P(fd(input.due)) },
    { label: 'Project', value: P(input.projectName) },
    { label: 'Client', value: P(brief?.client_name) },
    { label: 'Site', value: P([brief?.site_address, brief?.city].filter(Boolean).join(', ')) },
  ]
}

export function invoiceFileName(projectName: string, inv: Pick<FeeInvoice, 'invoice_no' | 'milestone'>): string {
  return `${fileStem(projectName)}-Invoice-${fileStem(inv.invoice_no || inv.milestone)}.pdf`
}

export async function invoicePdf(input: InvoiceDocInput, logo: Logo | null): Promise<Blob> {
  const { jsPDF } = await import('jspdf')
  const d = new jsPDF({ orientation: 'p', unit: 'pt', format: 'a4' })
  const w = writer(d)
  const S = input.studio
  const { amount, gst, total } = invoiceTotals(input.invoice)
  const money = (v: number) => 'Rs. ' + round2(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

  if (logo) d.addImage(logo.dataUrl, logo.type === 'png' ? 'PNG' : 'JPEG', w.W - 48 - 56, 40, 56, (56 * logo.h) / logo.w)
  w.y = 64
  w.text(S.name.toUpperCase(), 18, true)
  w.text(S.tagline, 9)
  w.text([S.website, S.email, S.phone].filter(Boolean).join('   |   '), 9)
  if (S.gstin.trim()) w.text(`GSTIN: ${S.gstin.trim()}`, 9, true)
  w.y += 10
  w.text('INVOICE', 16, true)
  w.text(INVOICE_DRAFT_NOTE, 9, true, true)
  w.y += 4
  w.table(invoiceLines(input).map((l) => [l.label, l.value]), [30, 70], 2)
  w.table(
    [
      ['Description', 'Amount (Rs.)'],
      [`Design fee: ${input.invoice.milestone}`, money(amount)],
      [`GST @ ${num(input.invoice.gst_rate)}%`, money(gst)],
      ['TOTAL', money(total)],
    ],
    [70, 30],
    1,
  )
  w.text(`Amount in words: ${rupeesInWords(total)}`, 10)
  if ((input.invoice.note ?? '').trim()) w.text((input.invoice.note ?? '').trim(), 9)
  w.y += 6
  w.text('Prepared in the Studio Elements project tool. Tax details (such as the SAC code and how GST is split) are not added by the app; confirm them with your CA.', 8)
  if (input.invoice.status === 'scheduled') w.text(`Not yet raised: invoice number and date are ${TBC}.`, 8, false, true)
  return d.output('blob')
}
