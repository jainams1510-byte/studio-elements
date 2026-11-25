import { useState } from 'react'
import { go } from '../hooks'
import { DRAFT_KIND_LABEL, type Draft, type DraftKind } from '../portfolio'
import { markDraft, useOpenDrafts, usePortfolio } from '../usePortfolio'

/** Messages the rules suggest. Nothing is sent from the app: you edit, then share or copy it yourself. */
export default function Drafts() {
  const { drafts, ready, offline } = usePortfolio()
  const open = useOpenDrafts(drafts)
  const [kind, setKind] = useState<DraftKind | 'all'>('all')
  const shown = open.filter((d) => kind === 'all' || d.kind === kind)
  const count = (k: DraftKind) => open.filter((d) => d.kind === k).length

  return (
    <main className="screen">
      <header className="topbar">
        <div>
          <button type="button" className="link back" onClick={() => go('/')}>
            Today
          </button>
          <h1>Drafts</h1>
        </div>
      </header>
      <p className="muted small">Messages suggested by the schedule, drawings, decisions, orders, agency bills and fee invoices. Nothing is sent from the app: check it, edit it, then share it yourself.</p>
      {offline && <p className="notice">No signal. Drafts are from the data last seen on this phone.</p>}

      <div className="chips" role="group" aria-label="Filter drafts">
        <button type="button" className={kind === 'all' ? 'chip on' : 'chip'} aria-pressed={kind === 'all'} onClick={() => setKind('all')}>
          All {open.length}
        </button>
        {(['client', 'site', 'team'] as const).map((k) => (
          <button key={k} type="button" className={kind === k ? 'chip on' : 'chip'} aria-pressed={kind === k} onClick={() => setKind(k)}>
            {DRAFT_KIND_LABEL[k]} {count(k)}
          </button>
        ))}
      </div>

      {!ready && <p className="muted">Loading</p>}
      {ready && shown.length === 0 && <p className="muted">Nothing waiting on you.</p>}
      <ul className="stack">
        {shown.map((d) => (
          <DraftCard key={d.key} draft={d} />
        ))}
      </ul>
    </main>
  )
}

function DraftCard({ draft }: { draft: Draft }) {
  const [body, setBody] = useState(draft.body)
  const [note, setNote] = useState<string | null>(null)
  const text = `${draft.subject}\n\n${body}`

  async function share() {
    setNote(null)
    if (navigator.share) {
      try {
        await navigator.share({ text })
        markDraft(draft.key, 'shared')
        return
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return // closed the share sheet
      }
    }
    await copy()
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      setNote('Copied. Paste it into WhatsApp.')
      setTimeout(() => markDraft(draft.key, 'copied'), 1200)
    } catch {
      setNote('Could not copy here. Select the text and copy it.')
    }
  }

  return (
    <li className="card stack draft">
      <div className="card-head">
        <strong>{draft.subject}</strong>
        <span className="tag muted">{DRAFT_KIND_LABEL[draft.kind]}</span>
      </div>
      <span className="muted small">
        {draft.projectName} · To {draft.to}
      </span>
      <p className="why small">{draft.why}</p>
      <label className="field">
        <span>Message</span>
        <textarea rows={5} value={body} onChange={(e) => setBody(e.target.value)} />
      </label>
      {note && <p className="small">{note}</p>}
      <div className="button-row">
        <button type="button" className="primary" onClick={share}>
          Share
        </button>
        <button type="button" className="secondary" onClick={copy}>
          Copy
        </button>
      </div>
      <button type="button" className="link left" onClick={() => markDraft(draft.key, 'dismissed')}>
        Dismiss
      </button>
    </li>
  )
}
