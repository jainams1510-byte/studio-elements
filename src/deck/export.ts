/**
 * PPTX and PDF builders for the presentation, ported from Project Studio (expPptx, expDeckPdf).
 * They take the library and already-loaded images, so they run the same in the browser and in tests.
 * The screen loads pptxgenjs and jspdf with a dynamic import only when an export is asked for.
 */
import type PptxGenJS from 'pptxgenjs'
import type { jsPDF as JsPdf } from 'jspdf'
import { BAND, boxes, CAPTION_H, CAPTION_Y, fit, GRID_W, LOGO_BOX, NAME_BOX, slotPath, TITLE_BOX, type Slide } from './deck'

/** A loaded image: data URL with its true mime, pixel size, and jsPDF format. */
export type Img = { data: string; w: number; h: number; fmt: 'PNG' | 'JPEG' }

export type DeckRender = {
  slides: Slide[]
  keyPlanPath: string | null
  /** Loaded images by storage path; a missing entry exports as an empty box. */
  images: Record<string, Img | undefined>
  logo: Img
}

export const FONT = 'Century Gothic'

/** Inches on the 13.333 in wide layout from grid units (the original E()). */
export const E = (v: number) => (v * 13.333) / GRID_W

function imageAt(r: DeckRender, s: Slide, key: string): { img: Img; path: string } | null {
  const path = slotPath(s, key, r.keyPlanPath)
  const img = path ? r.images[path] : undefined
  return path && img ? { img, path } : null
}

export function buildPptx(Pptx: typeof PptxGenJS, r: DeckRender): PptxGenJS {
  const p = new Pptx()
  p.layout = 'LAYOUT_WIDE'
  const pd = (i: Img) => i.data.replace(/^data:/, '')
  for (const s of r.slides) {
    const sl = p.addSlide()
    sl.background = { color: 'E0D8C9' }
    sl.addShape('rect', { x: 0, y: E(BAND[1]), w: E(BAND[2]), h: E(BAND[3]), fill: { color: '7F6F54' }, line: { color: '7F6F54' } })
    sl.addText(s.title, { x: 0, y: E(TITLE_BOX[1]), w: E(TITLE_BOX[2]), h: E(TITLE_BOX[3]), align: 'right', valign: 'middle', fontSize: 24, color: 'FFFFFF', fontFace: FONT, margin: 0 })
    const lb = fit(r.logo, LOGO_BOX)
    sl.addImage({ data: pd(r.logo), x: E(lb[0]), y: E(lb[1]), w: E(lb[2]), h: E(lb[3]) })
    sl.addText('STUDIO\nELEMENTS', { x: E(NAME_BOX[0]), y: E(NAME_BOX[1]), w: E(NAME_BOX[2]), h: E(NAME_BOX[3]), align: 'left', valign: 'middle', fontSize: 14, color: '80786A', fontFace: FONT, margin: 0 })
    for (const slot of boxes(s)) {
      const b = slot.box
      const hit = imageAt(r, s, slot.key)
      if (hit) {
        const f = fit(hit.img, b)
        sl.addImage({ data: pd(hit.img), x: E(f[0]), y: E(f[1]), w: E(f[2]), h: E(f[3]) })
      } else {
        sl.addShape('rect', { x: E(b[0]), y: E(b[1]), w: E(b[2]), h: E(b[3]), fill: { color: 'E0D8C9' }, line: { color: 'B8AC96', dashType: 'dash', width: 1 } })
        sl.addText(slot.key === 'kp' ? 'Add key plan' : 'Add image', { x: E(b[0]), y: E(b[1]), w: E(b[2]), h: E(b[3]), align: 'center', valign: 'middle', fontSize: 11, color: '8A8070', fontFace: FONT })
      }
      if (slot.caption)
        sl.addText(slot.caption, { x: E(b[0]), y: E(CAPTION_Y), w: E(b[2]), h: E(CAPTION_H), align: 'center', valign: 'middle', fontSize: 18, color: '000000', fontFace: FONT })
    }
  }
  return p
}

export function buildPdf(Pdf: typeof JsPdf, r: DeckRender): JsPdf {
  const d = new Pdf({ orientation: 'l', unit: 'pt', format: [960, 540] })
  const k = 960 / GRID_W
  r.slides.forEach((s, n) => {
    if (n) d.addPage([960, 540], 'l')
    d.setFillColor(224, 216, 201)
    d.rect(0, 0, 960, 540, 'F')
    d.setFillColor(127, 111, 84)
    d.rect(0, BAND[1] * k, BAND[2] * k, BAND[3] * k, 'F')
    d.setTextColor(255, 255, 255)
    d.setFont('helvetica', 'normal')
    d.setFontSize(24)
    d.text(s.title, TITLE_BOX[2] * k, 762 * k, { align: 'right', baseline: 'middle' })
    const lb = fit(r.logo, LOGO_BOX)
    d.addImage(r.logo.data, r.logo.fmt, lb[0] * k, lb[1] * k, lb[2] * k, lb[3] * k, 'studio-logo')
    d.setTextColor(128, 120, 106)
    d.setFontSize(14)
    d.text('STUDIO', 1346 * k, 758 * k)
    d.text('ELEMENTS', 1346 * k, 778 * k)
    for (const slot of boxes(s)) {
      const b = slot.box
      const hit = imageAt(r, s, slot.key)
      if (hit) {
        const f = fit(hit.img, b)
        d.addImage(hit.img.data, hit.img.fmt, f[0] * k, f[1] * k, f[2] * k, f[3] * k, hit.path)
      } else {
        d.setDrawColor(184, 172, 150)
        d.setLineDashPattern([4, 3], 0)
        d.rect(b[0] * k, b[1] * k, b[2] * k, b[3] * k, 'S')
        d.setLineDashPattern([], 0)
      }
      if (slot.caption) {
        d.setTextColor(0, 0, 0)
        d.setFontSize(18)
        d.text(slot.caption, (b[0] + b[2] / 2) * k, 612 * k, { align: 'center', baseline: 'middle' })
      }
    }
  })
  return d
}
