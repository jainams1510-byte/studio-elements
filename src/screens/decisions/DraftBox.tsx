import { useState } from 'react'
import { DRAFT_KIND_LABEL, type Draft } from '../../portfolio'

/** A drafted message to edit, then share or copy. Nothing is sent from the app. */
export default function DraftBox({ draft, onClose }: { draft: Draft; onClose: () => void }) {
  const [body, setBody] = useState(draft.body)
  const [note, setNote] = useState<string | null>(null)
  const text = `${draft.subject}\n\n${body}`

  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      setNote('Copied. Paste it into WhatsApp.')
    } catch {
      setNote('Could not copy here. Select the text and copy it.')
    }
  }

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

  return (
    <div className="dc-draft stack" role="group" aria-label="Drafted message">
      <div className="card-head">
        <strong className="small-title">{draft.subject}</strong>
        <span className="tag muted">{DRAFT_KIND_LABEL[draft.kind]}</span>
      </div>
      <span className="muted small">To {draft.to} · you send it yourself</span>
      <label className="field">
        <span>Message</span>
        <textarea rows={8} value={body} onChange={(e) => setBody(e.target.value)} />
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
      <button type="button" className="link left" onClick={onClose}>
        Close draft
      </button>
    </div>
  )
}
