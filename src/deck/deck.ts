/**
 * Presentation deck rules, ported from Jainam's Project Studio tool (deckDefault, boxes, pct, fit).
 * Geometry is copied from the Sparsh Eklavya deck: a 1456 × 819 reference grid, 16:9.
 * A slide's own images live in slide.slots ("a", "b"); the key plan is one image shared by the
 * KEY PLAN slide and every room slide, stored once as project_decks.key_plan_path.
 */
import type { DeckSlide } from '../domain'

export const GRID_W = 1456
export const GRID_H = 819

/** A slide as stored in project_decks.slides. `u` is a stable id so a rebuild can keep images. */
export type Slide = DeckSlide & { u?: string }

/** x, y, width, height on the 1456 × 819 grid. */
export type Box = [number, number, number, number]

/** One image place on a slide. key "kp" is the shared key plan. */
export type SlotDef = { key: string; box: Box; caption?: string }

export const KEY_PLAN = 'kp'

/** Title band, title text, logo and studio name boxes (same on every slide). */
export const BAND: Box = [0, 705, 1246, 114]
export const TITLE_BOX: Box = [0, 705, 1213, 114]
export const LOGO_BOX: Box = [1262, 725, 74, 75]
export const NAME_BOX: Box = [1340, 735, 110, 60]
/** Caption row under Option 1 / Option 2: y and height. */
export const CAPTION_Y = 585
export const CAPTION_H = 55

export const KIND_LABEL: Record<Slide['kind'], string> = { asbuilt: 'As built', keyplan: 'Key plan', room: 'Room', thanks: 'Closing' }

export function boxes(s: Pick<Slide, 'kind'>): SlotDef[] {
  if (s.kind === 'asbuilt') return [{ key: 'a', box: [100, 15, 560, 665] }, { key: 'b', box: [770, 15, 520, 665] }]
  if (s.kind === 'keyplan') return [{ key: KEY_PLAN, box: [428, 15, 600, 665] }]
  if (s.kind === 'room')
    return [
      { key: 'a', box: [100, 130, 430, 435], caption: 'Option 1' },
      { key: 'b', box: [560, 130, 450, 435], caption: 'Option 2' },
      { key: KEY_PLAN, box: [1105, 150, 300, 415] },
    ]
  return []
}

/** What a slot is called on buttons. */
export function slotLabel(_s: Pick<Slide, 'kind'>, slot: SlotDef): string {
  if (slot.key === KEY_PLAN) return 'key plan'
  if (slot.caption) return slot.caption
  return slot.key === 'a' ? 'plan 1' : 'plan 2'
}

/** A grid box as CSS percentages of the slide, so previews scale with their container. */
export function pct(b: Box): { left: string; top: string; width: string; height: string } {
  const p = (v: number, of: number) => `${+((v / of) * 100).toFixed(4)}%`
  return { left: p(b[0], GRID_W), top: p(b[1], GRID_H), width: p(b[2], GRID_W), height: p(b[3], GRID_H) }
}

/** Fit an image inside a box, keeping its aspect ratio, centred (the original fit()). */
export function fit(img: { w: number; h: number }, b: Box): Box {
  const k = Math.min(b[2] / img.w, b[3] / img.h)
  const w = img.w * k
  const h = img.h * k
  return [b[0] + (b[2] - w) / 2, b[1] + (b[3] - h) / 2, w, h]
}

/** Default slides: AS BUILT, KEY PLAN, one per room, THANK YOU. */
export function deckDefault(rooms: string[]): Slide[] {
  const d: Slide[] = [
    { kind: 'asbuilt', title: 'AS BUILT', slots: {}, u: 's0' },
    { kind: 'keyplan', title: 'KEY PLAN', slots: {}, u: 's1' },
  ]
  rooms.forEach((r, i) => {
    const name = r.trim()
    if (name) d.push({ kind: 'room', title: name, slots: {}, u: `r${i}` })
  })
  d.push({ kind: 'thanks', title: 'THANK YOU', slots: {}, u: 'z' })
  return d
}

const norm = (t: string) => t.trim().toLowerCase()

/**
 * Rebuild from the room list, keeping uploaded images by slot: a new slide takes the images of an
 * old slide of the same kind and title, else of the same kind and id (a renamed room keeps its images).
 * Images of slides that no longer exist leave the deck; their files stay in storage.
 */
export function rebuildDeck(old: Slide[], rooms: string[]): Slide[] {
  const used = new Set<number>()
  const take = (pred: (s: Slide) => boolean) => {
    const i = old.findIndex((s, k) => !used.has(k) && pred(s))
    if (i < 0) return null
    used.add(i)
    return old[i]
  }
  const fresh = deckDefault(rooms)
  // Match by title first for every slide, then by id, so a reordered room list keeps images with names.
  const byTitle = fresh.map((n) => take((s) => s.kind === n.kind && norm(s.title) === norm(n.title)))
  return fresh.map((n, i) => {
    const match = byTitle[i] ?? take((s) => s.kind === n.kind && s.u != null && s.u === n.u)
    return match ? { ...n, slots: { ...match.slots } } : n
  })
}

export function moveSlide(slides: Slide[], i: number, d: -1 | 1): Slide[] {
  const j = i + d
  if (j < 0 || j >= slides.length) return slides
  const next = [...slides]
  ;[next[i], next[j]] = [next[j], next[i]]
  return next
}

export function removeSlide(slides: Slide[], i: number): Slide[] {
  return slides.filter((_, k) => k !== i)
}

/** A new room slide goes before the last slide (THANK YOU), as in the original. */
export function addRoomSlide(slides: Slide[], title: string, u = `x${Date.now()}`): Slide[] {
  const next = [...slides]
  next.splice(Math.max(next.length - 1, 0), 0, { kind: 'room', title: title.trim(), slots: {}, u })
  return next
}

export function retitle(slides: Slide[], i: number, title: string): Slide[] {
  return slides.map((s, k) => (k === i ? { ...s, title } : s))
}

export function setSlot(slides: Slide[], i: number, key: string, path: string | null): Slide[] {
  return slides.map((s, k) => {
    if (k !== i) return s
    const slots = { ...s.slots }
    if (path) slots[key] = path
    else delete slots[key]
    return { ...s, slots }
  })
}

/** The stored file for a slot, or null when it is empty. */
export function slotPath(s: Slide, key: string, keyPlanPath: string | null): string | null {
  return key === KEY_PLAN ? keyPlanPath : (s.slots?.[key] ?? null)
}

/** Empty image places across the deck (the key plan counts on each slide that shows it, as in the original). */
export function emptySlots(slides: Slide[], keyPlanPath: string | null): number {
  let n = 0
  for (const s of slides) for (const b of boxes(s)) if (!slotPath(s, b.key, keyPlanPath)) n++
  return n
}

/** Every stored file the deck uses. */
export function deckPaths(slides: Slide[], keyPlanPath: string | null): string[] {
  const out = new Set<string>()
  if (keyPlanPath) out.add(keyPlanPath)
  for (const s of slides) for (const p of Object.values(s.slots ?? {})) if (p) out.add(p)
  return [...out]
}

/** Read slides from the database defensively (old or hand-edited rows). */
export function cleanSlides(raw: unknown): Slide[] {
  if (!Array.isArray(raw)) return []
  const kinds = ['asbuilt', 'keyplan', 'room', 'thanks']
  return raw
    .filter((s): s is Record<string, unknown> => Boolean(s) && typeof s === 'object' && kinds.includes(String((s as { kind?: unknown }).kind)))
    .map((s, i) => {
      const slots: Record<string, string> = {}
      if (s.slots && typeof s.slots === 'object') for (const [k, v] of Object.entries(s.slots)) if (typeof v === 'string' && v) slots[k] = v
      return { kind: s.kind as Slide['kind'], title: String(s.title ?? ''), slots, u: typeof s.u === 'string' ? s.u : `d${i}` }
    })
}

/** `<Project>-Presentation.pptx`, with the original's file-name cleaning. */
export function exportName(projectName: string | null | undefined, ext: 'pptx' | 'pdf'): string {
  return `${(projectName || 'Project').replace(/[^\w-]+/g, '-')}-Presentation.${ext}`
}
