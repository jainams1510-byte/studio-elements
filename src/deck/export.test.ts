import { unzipSync, strFromU8 } from 'fflate'
import { describe, expect, it } from 'vitest'
import { deckDefault, setSlot } from './deck'
import { buildPdf, buildPptx, E, type DeckRender, type Img } from './export'
import logoData from '../../public/logo-default.png?inline'

const logo: Img = { data: logoData, w: 229, h: 206, fmt: 'PNG' }

function render(): DeckRender {
  let slides = deckDefault(['Living room', 'Kitchen'])
  slides = setSlot(slides, 2, 'a', 'decks/p/living-1.png')
  return { slides, keyPlanPath: null, images: { 'decks/p/living-1.png': logo }, logo }
}

describe('exports', () => {
  it('converts grid units to inches on the wide layout', () => {
    expect(E(1456)).toBeCloseTo(13.333, 6)
    expect(E(0)).toBe(0)
  })

  it('builds a PPTX with one slide per deck slide and the titles and captions', async () => {
    const { default: Pptx } = await import('pptxgenjs')
    const out = (await buildPptx(Pptx, render()).write({ outputType: 'uint8array' })) as Uint8Array
    const files = unzipSync(out)
    const slides = Object.keys(files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f)).sort()
    expect(slides.length).toBe(5)
    const all = slides.map((f) => strFromU8(files[f])).join('\n')
    for (const t of ['AS BUILT', 'KEY PLAN', 'Living room', 'Kitchen', 'THANK YOU', 'Option 1', 'Option 2', 'Add key plan', 'Century Gothic']) expect(all).toContain(t)
    // Images: the logo on each slide plus the one room image (pptxgenjs may store duplicates once).
    expect(Object.keys(files).some((f) => f.startsWith('ppt/media/'))).toBe(true)
    const pres = strFromU8(files['ppt/presentation.xml'])
    expect(pres).toContain('cx="12192000"') // 13.333 in wide
  })

  it('builds a 960 × 540 pt PDF with one page per slide', async () => {
    const { jsPDF } = await import('jspdf')
    const d = buildPdf(jsPDF, render())
    expect(d.getNumberOfPages()).toBe(5)
    expect(d.internal.pageSize.getWidth()).toBeCloseTo(960, 3)
    expect(d.internal.pageSize.getHeight()).toBeCloseTo(540, 3)
    const text = d.output()
    expect(text.startsWith('%PDF')).toBe(true)
    expect(text).toContain('(Living room)')
  })
})
