import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { saveFile } from '../../backup'
import { cacheGet, cacheSet } from '../../db'
import {
  addRoomSlide,
  boxes,
  cleanSlides,
  deckDefault,
  deckPaths,
  emptySlots,
  exportName,
  KEY_PLAN,
  KIND_LABEL,
  moveSlide,
  rebuildDeck,
  removeSlide,
  retitle,
  setSlot,
  slotLabel,
  slotPath,
  type Slide,
} from '../../deck/deck'
import { buildPdf, buildPptx, type DeckRender, type Img } from '../../deck/export'
import { loadImage } from '../../deck/images'
import { compressImage } from '../../media'
import { MEDIA_BUCKET, supabase } from '../../supabase'
import SlidePreview from './SlidePreview'

const DEFAULT_LOGO = `${import.meta.env.BASE_URL}logo-default.png`

type Cached = { name: string; rooms: string[]; slides: Slide[] | null; key_plan_path: string | null; logo_path: string | null }

/** Project → Deck: the client presentation builder (Project Studio's Presentation tab). */
export default function DeckTab({ projectId }: { projectId: string }) {
  const [name, setName] = useState('')
  const [rooms, setRooms] = useState<string[]>([])
  const [slides, setSlides] = useState<Slide[] | null>(null)
  const [keyPlan, setKeyPlan] = useState<string | null>(null)
  const [logoPath, setLogoPath] = useState<string | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'offline'>('loading')
  const [urls, setUrls] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [undo, setUndo] = useState<{ slide: Slide; index: number } | null>(null)
  const [adding, setAdding] = useState<string | null>(null)
  const [confirmRebuild, setConfirmRebuild] = useState(false)
  const [saving, setSaving] = useState(0)
  const [savedOnce, setSavedOnce] = useState(false)
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const cacheKey = `deck:${projectId}`

  useEffect(() => {
    let live = true
    const fill = (c: Cached) => {
      setName(c.name)
      setRooms(c.rooms)
      setSlides(c.slides ?? deckDefault(c.rooms))
      setKeyPlan(c.key_plan_path)
      setLogoPath(c.logo_path)
    }
    cacheGet<Cached>(cacheKey).then((c) => {
      if (live && c) {
        fill(c)
        setState((x) => (x === 'loading' ? 'ready' : x))
      }
    })
    ;(async () => {
      const [p, d, st] = await Promise.all([
        supabase.from('projects').select('name, rooms').eq('id', projectId).maybeSingle(),
        supabase.from('project_decks').select('project_id, slides, key_plan_path').eq('project_id', projectId).maybeSingle(),
        supabase.from('studio_settings').select('logo_path').eq('id', 1).maybeSingle(),
      ])
      if (!live) return
      if (p.error || d.error || !p.data) {
        setState('offline')
        return
      }
      const proj = p.data as { name: string; rooms: string[] | null }
      const deck = d.data as { slides: unknown; key_plan_path: string | null } | null
      const saved = deck ? cleanSlides(deck.slides) : []
      const c: Cached = {
        name: proj.name,
        rooms: proj.rooms ?? [],
        slides: deck && saved.length ? saved : null,
        key_plan_path: deck?.key_plan_path ?? null,
        logo_path: (st.data as { logo_path: string | null } | null)?.logo_path ?? null,
      }
      fill(c)
      setState('ready')
      void cacheSet(cacheKey, c)
    })()
    return () => {
      live = false
    }
  }, [projectId, cacheKey])

  // Signed URLs for every stored image the deck shows (and the logo).
  const paths = slides ? [...deckPaths(slides, keyPlan), ...(logoPath ? [logoPath] : [])] : []
  const missing = paths.filter((p) => !urls[p])
  const missingKey = missing.join('|')
  useEffect(() => {
    if (!missingKey) return
    let live = true
    supabase.storage
      .from(MEDIA_BUCKET)
      .createSignedUrls(missingKey.split('|'), 3600)
      .then(({ data }) => {
        if (!live || !data) return
        const add: Record<string, string> = {}
        for (const s of data) if (s.path && s.signedUrl) add[s.path] = s.signedUrl
        setUrls((u) => ({ ...u, ...add }))
      })
    return () => {
      live = false
    }
  }, [missingKey])

  /** Save the whole deck (one row per project). Saves run one after another so the last change wins. */
  const persist = useCallback(
    (next: Slide[], kp: string | null) => {
      setSlides(next)
      setKeyPlan(kp)
      setSaving((n) => n + 1)
      const run = queue.current.then(async () => {
        const { error: err } = await supabase
          .from('project_decks')
          .upsert({ project_id: projectId, slides: next, key_plan_path: kp }, { onConflict: 'project_id' })
        if (err) {
          setError(navigator.onLine ? `The deck did not save: ${err.message}` : 'No signal. Deck changes need a connection; they will be lost if you leave.')
          return
        }
        setError(null)
        setSavedOnce(true)
        const c = await cacheGet<Cached>(cacheKey)
        if (c) await cacheSet(cacheKey, { ...c, slides: next, key_plan_path: kp })
      }).finally(() => setSaving((n) => n - 1))
      queue.current = run
      return run
    },
    [projectId, cacheKey],
  )

  if (state === 'loading' && !slides) return <p className="muted">Loading</p>
  if (!slides) return <p className="notice">No signal. The deck has not been opened on this phone yet.</p>

  const deck = slides
  const logoUrl = (logoPath && urls[logoPath]) || DEFAULT_LOGO
  const urlFor = (s: Slide) => (key: string) => {
    const p = slotPath(s, key, keyPlan)
    return p ? (urls[p] ?? null) : null
  }

  async function pick(i: number, key: string, e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setBusy(`${i}:${key}`)
    setError(null)
    setNotice(null)
    const { blob, mime, ext } = await compressImage(file)
    const path = `decks/${projectId}/${crypto.randomUUID()}.${ext}`
    const { error: upErr } = await supabase.storage.from(MEDIA_BUCKET).upload(path, blob, { contentType: mime })
    if (upErr) {
      setBusy(null)
      setError(navigator.onLine ? `The image did not upload: ${upErr.message}` : 'No signal. Uploading an image needs a connection.')
      return
    }
    setUrls((u) => ({ ...u, [path]: URL.createObjectURL(blob) }))
    if (key === KEY_PLAN) await persist(deck, path)
    else await persist(setSlot(deck, i, key, path), keyPlan)
    setBusy(null)
  }

  function clear(i: number, key: string) {
    setNotice(null)
    if (key === KEY_PLAN) void persist(deck, null)
    else void persist(setSlot(deck, i, key, null), keyPlan)
  }

  function remove(i: number) {
    setUndo({ slide: deck[i], index: i })
    void persist(removeSlide(deck, i), keyPlan)
  }

  function restore() {
    if (!undo) return
    const next = [...deck]
    next.splice(Math.min(undo.index, next.length), 0, undo.slide)
    setUndo(null)
    void persist(next, keyPlan)
  }

  function addRoom(e: FormEvent) {
    e.preventDefault()
    const t = (adding ?? '').trim()
    if (!t) return
    setAdding(null)
    void persist(addRoomSlide(deck, t), keyPlan)
  }

  function rebuild() {
    setConfirmRebuild(false)
    setUndo(null)
    void persist(rebuildDeck(deck, rooms), keyPlan)
  }

  async function exportDeck(kind: 'pptx' | 'pdf') {
    setBusy(`export-${kind}`)
    setError(null)
    setNotice(null)
    try {
      const used = deckPaths(deck, keyPlan)
      const need = used.filter((p) => !urls[p])
      const fresh: Record<string, string> = {}
      if (need.length) {
        const { data } = await supabase.storage.from(MEDIA_BUCKET).createSignedUrls(need, 3600)
        for (const s of data ?? []) if (s.path && s.signedUrl) fresh[s.path] = s.signedUrl
      }
      const all = { ...urls, ...fresh }
      const images: Record<string, Img | undefined> = {}
      let failed = 0
      for (const p of used) {
        const img = all[p] ? await loadImage(all[p]) : null
        if (img) images[p] = img
        else failed++
      }
      const logo = (await loadImage(logoUrl)) ?? (await loadImage(DEFAULT_LOGO))
      if (!logo) throw new Error('The logo could not be loaded.')
      const r: DeckRender = { slides: deck, keyPlanPath: keyPlan, images, logo }
      let blob: Blob
      if (kind === 'pptx') {
        const { default: Pptx } = await import('pptxgenjs')
        blob = (await buildPptx(Pptx, r).write({ outputType: 'blob' })) as Blob
      } else {
        const { jsPDF } = await import('jspdf')
        blob = buildPdf(jsPDF, r).output('blob')
      }
      await saveFile(blob, exportName(name, kind))
      const empty = emptySlots(deck, keyPlan)
      const notes = [
        failed ? `${failed} image${failed === 1 ? '' : 's'} could not be loaded and export as empty boxes.` : '',
        empty ? `${empty} empty slot${empty === 1 ? '' : 's'} export as blank boxes.` : '',
      ].filter(Boolean)
      setNotice(`${kind.toUpperCase()} ready.${notes.length ? ' ' + notes.join(' ') : ''}`)
    } catch (err) {
      setError(`Export failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="stack dk-deck">
      <div className="dk-head">
        <div className="dk-titlerow">
          <h2 className="dk-title">Client presentation</h2>
          <span className="muted small dk-savestate" data-saving={saving > 0 ? 'true' : 'false'} aria-live="polite">
            {saving > 0 ? 'Saving' : savedOnce && !error ? 'Saved' : ''}
          </span>
        </div>
        <p className="muted small">
          16:9, beige ground, brown title band, logo lower right, Option 1 and Option 2 beside the key plan. Upload your own images;
          nothing is invented.
        </p>
      </div>
      {state === 'offline' && <p className="notice">No signal. Showing the deck as last seen on this phone. Changes need a connection.</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {undo && (
        <p className="notice dk-undo">
          <span>Slide “{undo.slide.title}” removed. Its images stay in storage.</span>
          <button type="button" className="link" onClick={restore}>Undo</button>
        </p>
      )}

      <ol className="dk-slides">
        {deck.map((s, i) => (
          <li key={`${s.u ?? ''}-${i}`} className="card dk-slide" data-slide={i + 1}>
            <div className="dk-slide-head">
              <span className="muted small">
                {i + 1} · {KIND_LABEL[s.kind]}
              </span>
              <div className="dk-tools">
                <button type="button" className="dk-icon" aria-label={`Move slide ${i + 1} up`} disabled={i === 0} onClick={() => void persist(moveSlide(deck, i, -1), keyPlan)}>
                  ↑
                </button>
                <button type="button" className="dk-icon" aria-label={`Move slide ${i + 1} down`} disabled={i === deck.length - 1} onClick={() => void persist(moveSlide(deck, i, 1), keyPlan)}>
                  ↓
                </button>
                <button type="button" className="dk-icon" aria-label={`Remove slide ${i + 1}`} onClick={() => remove(i)}>
                  ×
                </button>
              </div>
            </div>
            <input
              type="text"
              className="dk-title-input"
              aria-label={`Title of slide ${i + 1}`}
              value={s.title}
              onChange={(e) => setSlides(retitle(deck, i, e.target.value))}
              onBlur={(e) => void persist(retitle(deck, i, e.target.value.trim() || s.title), keyPlan)}
            />
            <SlidePreview slide={s} urlFor={urlFor(s)} logoUrl={logoUrl} label={`Slide ${i + 1} preview: ${s.title}`} />
            {boxes(s).length > 0 && (
              <div className="dk-slots">
                {boxes(s).map((b) => {
                  const lab = slotLabel(s, b)
                  const has = Boolean(slotPath(s, b.key, keyPlan))
                  const working = busy === `${i}:${b.key}`
                  return (
                    <div key={b.key} className="dk-slotctl">
                      <label className={working ? 'pill dk-file busy' : 'pill dk-file'}>
                        {working ? 'Uploading' : `${has ? 'Replace' : 'Upload'} ${lab}`}
                        <input
                          type="file"
                          accept="image/*"
                          className="sr"
                          aria-label={`${has ? 'Replace' : 'Upload'} ${lab}, slide ${i + 1}`}
                          disabled={busy !== null}
                          onChange={(e) => void pick(i, b.key, e)}
                        />
                      </label>
                      {has && (
                        <button type="button" className="dk-icon" aria-label={`Clear ${lab}, slide ${i + 1}`} disabled={busy !== null} onClick={() => clear(i, b.key)}>
                          ×
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
            {s.kind === 'room' && <p className="muted small">The key plan is shared by every room slide and the key plan slide.</p>}
          </li>
        ))}
      </ol>

      {adding !== null ? (
        <form onSubmit={addRoom} className="card stack">
          <label className="field">
            <span>Room name</span>
            <input type="text" value={adding} onChange={(e) => setAdding(e.target.value)} autoFocus />
          </label>
          <div className="button-row">
            <button type="submit" className="primary" disabled={!adding.trim()}>Add slide</button>
            <button type="button" className="secondary" onClick={() => setAdding(null)}>Cancel</button>
          </div>
        </form>
      ) : confirmRebuild ? (
        <div className="card stack">
          <p>Rebuild the slides from the room list ({rooms.length ? rooms.join(', ') : 'no rooms'})? Uploaded images are kept on slides that are still there; titles go back to the room names.</p>
          <div className="button-row">
            <button type="button" className="primary" onClick={rebuild}>Rebuild</button>
            <button type="button" className="secondary" onClick={() => setConfirmRebuild(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        <div className="button-row">
          <button type="button" className="secondary" onClick={() => setAdding('')}>Add room slide</button>
          <button type="button" className="secondary" onClick={() => setConfirmRebuild(true)}>Rebuild from rooms</button>
        </div>
      )}

      <div className="card stack dk-export">
        <h2 className="dk-title">Export</h2>
        {notice && <p className="notice" role="status">{notice}</p>}
        <div className="button-row">
          <button type="button" className="primary" disabled={busy !== null || !deck.length} onClick={() => void exportDeck('pptx')}>
            {busy === 'export-pptx' ? 'Making PPTX' : 'PPTX (editable)'}
          </button>
          <button type="button" className="primary" disabled={busy !== null || !deck.length} onClick={() => void exportDeck('pdf')}>
            {busy === 'export-pdf' ? 'Making PDF' : 'PDF'}
          </button>
        </div>
        <p className="muted small">Saved to this phone as {exportName(name, 'pptx')} or .pdf. Check it before sending; nothing is sent from the app.</p>
      </div>
    </section>
  )
}
