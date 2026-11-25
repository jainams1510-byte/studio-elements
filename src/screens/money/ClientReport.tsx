import { useState } from 'react'
import { estimateTotals, lineAmount } from '../../estimate'
import { inr, num } from '../../format'
import { groupByCategory, settingsFromBrief } from '../../money/boq'
import { DISCLAIMER, pdfTicks } from '../../money/clientPdf'
import { clientReportText } from '../../money/report'
import { exportClientPdf } from './exports'
import { Err, Figure, type SectionProps } from './shared'

/** The read-only budget view the studio shares with the client: category totals, then every non-optional line. */
export default function ClientReport({ m }: SectionProps) {
  const d = m.data
  const settings = settingsFromBrief(d.brief)
  const lines = d.items.filter((i) => !i.removed_at && !i.optional)
  const t = estimateTotals(lines, settings)
  const groups = groupByCategory(lines)
  const text = clientReportText({ projectName: d.project?.name ?? 'Project', clientName: d.brief?.client_name ?? null, studioName: d.studioName, items: d.items, settings })
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function share() {
    setNote(null)
    if (navigator.share) {
      try {
        await navigator.share({ text })
        return
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return
      }
    }
    await copy()
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      setNote('Copied. Paste it into WhatsApp or an email.')
    } catch {
      setNote('Could not copy here. Select the text below and copy it.')
    }
  }

  async function pdf() {
    setBusy(true)
    setError(null)
    try {
      await exportClientPdf(d, d.items, settings, pdfTicks(d.brief?.estimate_pdf))
    } catch (err) {
      setError(`Could not make the PDF: ${err instanceof Error ? err.message : String(err)}`)
    }
    setBusy(false)
  }

  if (!lines.length) return <p className="muted">Nothing to share yet: the estimate has no lines.</p>

  return (
    <div className="stack">
      <p className="muted small">Read-only. This is what the client sees: category totals and every item. Nothing is sent from the app; share it yourself.</p>
      <div className="card stack m-report">
        <div className="stack-tight">
          <strong>{d.project?.name}: budget summary</strong>
          {d.brief?.client_name && <span className="small">Client: {d.brief.client_name}</span>}
          <span className="muted small">{DISCLAIMER}</span>
        </div>
        <div className="m-figs">
          {groups.map((g) => (
            <Figure key={g.category} label={g.category} value={inr(t.byCategory[g.category] ?? 0)} />
          ))}
        </div>
        {groups.map((g) => (
          <div key={g.category} className="stack-tight">
            <h2>{g.category}</h2>
            <ul className="rows">
              {g.items.map((i) => (
                <li key={i.id} className="row-line padded m-rline">
                  <span className="stack-tight">
                    <span>{i.item}</span>
                    <span className="muted small">
                      {[i.room, `${num(i.quantity).toLocaleString('en-IN', { maximumFractionDigits: 3 })} ${i.unit}`].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                  <span className="nowrap">{inr(lineAmount(i))}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
        <div className="m-figs">
          <Figure label="Subtotal" value={inr(t.subtotal)} />
          <Figure label={`Contingency (${num(settings.contingency_pct)}%)`} value={inr(t.contingency)} />
          <Figure label={`GST (${num(settings.estimate_gst_rate)}%)`} value={inr(t.gst)} />
          <Figure label="Total" value={inr(t.total)} strong />
        </div>
      </div>
      <div className="button-row m-three">
        <button type="button" className="primary" onClick={share}>
          Share
        </button>
        <button type="button" className="secondary" onClick={copy}>
          Copy
        </button>
        <button type="button" className="secondary" disabled={busy} onClick={pdf}>
          {busy ? 'Making' : 'PDF'}
        </button>
      </div>
      {note && (
        <p className="notice" role="status">
          {note}
        </p>
      )}
      <Err text={error} />
      <details className="m-details">
        <summary>Text that is shared</summary>
        <textarea readOnly rows={12} value={text} aria-label="Report text" />
      </details>
    </div>
  )
}
