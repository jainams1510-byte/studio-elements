import { describe, expect, it } from 'vitest'
import {
  addRoomSlide,
  boxes,
  cleanSlides,
  deckDefault,
  deckPaths,
  emptySlots,
  exportName,
  fit,
  GRID_H,
  GRID_W,
  KEY_PLAN,
  moveSlide,
  pct,
  rebuildDeck,
  removeSlide,
  setSlot,
  slotLabel,
  slotPath,
} from './deck'

describe('default deck from rooms', () => {
  it('makes AS BUILT, KEY PLAN, one slide per room, THANK YOU', () => {
    const d = deckDefault(['Living', 'Kitchen', ' ', 'Bedroom 1'])
    expect(d.map((s) => [s.kind, s.title])).toEqual([
      ['asbuilt', 'AS BUILT'],
      ['keyplan', 'KEY PLAN'],
      ['room', 'Living'],
      ['room', 'Kitchen'],
      ['room', 'Bedroom 1'],
      ['thanks', 'THANK YOU'],
    ])
    expect(d.every((s) => Object.keys(s.slots).length === 0)).toBe(true)
  })
  it('still has the fixed slides with no rooms', () => {
    expect(deckDefault([]).map((s) => s.kind)).toEqual(['asbuilt', 'keyplan', 'thanks'])
  })
})

describe('slot geometry (1456 × 819 grid)', () => {
  it('has the original boxes and captions', () => {
    expect(boxes({ kind: 'asbuilt' }).map((b) => [b.key, b.box])).toEqual([['a', [100, 15, 560, 665]], ['b', [770, 15, 520, 665]]])
    expect(boxes({ kind: 'keyplan' })).toEqual([{ key: KEY_PLAN, box: [428, 15, 600, 665] }])
    const room = boxes({ kind: 'room' })
    expect(room.map((b) => b.caption)).toEqual(['Option 1', 'Option 2', undefined])
    expect(room[2]).toEqual({ key: KEY_PLAN, box: [1105, 150, 300, 415] })
    expect(boxes({ kind: 'thanks' })).toEqual([])
    expect(slotLabel({ kind: 'room' }, room[0])).toBe('Option 1')
    expect(slotLabel({ kind: 'room' }, room[2])).toBe('key plan')
    expect(slotLabel({ kind: 'asbuilt' }, boxes({ kind: 'asbuilt' })[1])).toBe('plan 2')
  })
  it('turns boxes into percentages of the slide', () => {
    // Worked by hand: 1456 / 14.56 = 100%; 105 / 8.19 = 12.8205%.
    expect(pct([0, 0, GRID_W, GRID_H])).toEqual({ left: '0%', top: '0%', width: '100%', height: '100%' })
    expect(pct([728, 105, 364, 819])).toEqual({ left: '50%', top: '12.8205%', width: '25%', height: '100%' })
    // Every box stays inside the slide.
    for (const kind of ['asbuilt', 'keyplan', 'room', 'thanks'] as const)
      for (const { box } of boxes({ kind })) {
        expect(box[0] + box[2]).toBeLessThanOrEqual(GRID_W)
        expect(box[1] + box[3]).toBeLessThanOrEqual(GRID_H)
      }
  })
})

describe('fit() keeps the aspect ratio, centred', () => {
  it('fits a wide image to the box width', () => {
    // 2000 × 1000 into 400 × 400 at (100, 50): scale 0.2 → 400 × 200, centred vertically (+100).
    expect(fit({ w: 2000, h: 1000 }, [100, 50, 400, 400])).toEqual([100, 150, 400, 200])
  })
  it('fits a tall image to the box height', () => {
    // 229 × 206 logo into 74 × 75: scale min(74/229, 75/206) = 0.3231… → 74 × 66.57, centred.
    const [x, y, w, h] = fit({ w: 229, h: 206 }, [1262, 725, 74, 75])
    expect(w).toBeCloseTo(74, 6)
    expect(h).toBeCloseTo((206 * 74) / 229, 6)
    expect(x).toBeCloseTo(1262, 6)
    expect(y).toBeCloseTo(725 + (75 - h) / 2, 6)
    expect(w / h).toBeCloseTo(229 / 206, 6)
  })
  it('enlarges a small image to touch the box', () => {
    expect(fit({ w: 10, h: 20 }, [0, 0, 100, 100])).toEqual([25, 0, 50, 100])
  })
})

describe('editing the deck', () => {
  const base = deckDefault(['Living', 'Kitchen'])
  it('moves slides up and down within bounds', () => {
    const m = moveSlide(base, 2, 1)
    expect(m.map((s) => s.title)).toEqual(['AS BUILT', 'KEY PLAN', 'Kitchen', 'Living', 'THANK YOU'])
    expect(moveSlide(base, 0, -1)).toBe(base)
    expect(moveSlide(base, base.length - 1, 1)).toBe(base)
  })
  it('adds a room slide before THANK YOU and removes slides', () => {
    const a = addRoomSlide(base, ' Study ', 'x1')
    expect(a.map((s) => s.title)).toEqual(['AS BUILT', 'KEY PLAN', 'Living', 'Kitchen', 'Study', 'THANK YOU'])
    expect(removeSlide(a, 4).map((s) => s.title)).toEqual(base.map((s) => s.title))
  })
  it('sets and clears a slot; the key plan is shared', () => {
    let d = setSlot(base, 2, 'a', 'decks/p/1.jpg')
    expect(slotPath(d[2], 'a', null)).toBe('decks/p/1.jpg')
    expect(slotPath(d[2], KEY_PLAN, 'decks/p/kp.jpg')).toBe('decks/p/kp.jpg')
    d = setSlot(d, 2, 'a', null)
    expect(d[2].slots).toEqual({})
  })
  it('counts empty slots, with the key plan counted on each slide that shows it', () => {
    // asbuilt 2 + keyplan 1 + 2 rooms × 3 = 9 empty.
    expect(emptySlots(base, null)).toBe(9)
    // A key plan fills 3 places (key plan slide + both rooms); one room image fills 1 more.
    const d = setSlot(base, 2, 'b', 'decks/p/2.jpg')
    expect(emptySlots(d, 'decks/p/kp.jpg')).toBe(5)
    expect(deckPaths(d, 'decks/p/kp.jpg').sort()).toEqual(['decks/p/2.jpg', 'decks/p/kp.jpg'])
  })
})

describe('rebuild from rooms keeps images', () => {
  it('keeps images by room name even when rooms are reordered', () => {
    let d = deckDefault(['Living', 'Kitchen'])
    d = setSlot(d, 0, 'a', 'asbuilt.jpg')
    d = setSlot(d, 2, 'a', 'living1.jpg')
    d = setSlot(d, 3, 'b', 'kitchen2.jpg')
    const r = rebuildDeck(d, ['Kitchen', 'Living', 'Foyer'])
    expect(r.map((s) => s.title)).toEqual(['AS BUILT', 'KEY PLAN', 'Kitchen', 'Living', 'Foyer', 'THANK YOU'])
    expect(r[0].slots).toEqual({ a: 'asbuilt.jpg' })
    expect(r[2].slots).toEqual({ b: 'kitchen2.jpg' })
    expect(r[3].slots).toEqual({ a: 'living1.jpg' })
    expect(r[4].slots).toEqual({})
  })
  it('keeps a renamed room’s images by its place in the list', () => {
    let d = deckDefault(['Bed 1', 'Kitchen'])
    d = setSlot(d, 2, 'a', 'bed.jpg')
    const r = rebuildDeck(d, ['Master bedroom', 'Kitchen'])
    expect(r[2]).toMatchObject({ title: 'Master bedroom', slots: { a: 'bed.jpg' } })
  })
  it('drops slides added by hand and does not reuse one slide twice', () => {
    let d = addRoomSlide(deckDefault(['Living']), 'Terrace', 'x9')
    d = setSlot(d, 3, 'a', 'terrace.jpg')
    const r = rebuildDeck(d, ['Living', 'Living'])
    expect(r.filter((s) => s.kind === 'room').map((s) => s.slots)).toEqual([{}, {}])
    expect(deckPaths(r, null)).toEqual([])
  })
})

describe('reading stored slides and file names', () => {
  it('cleans odd rows', () => {
    const s = cleanSlides([{ kind: 'room', title: 'Living', slots: { a: 'x.jpg', b: 7 } }, { kind: 'bogus' }, null])
    expect(s).toEqual([{ kind: 'room', title: 'Living', slots: { a: 'x.jpg' }, u: 'd0' }])
    expect(cleanSlides('nope')).toEqual([])
  })
  it('names files like the original', () => {
    expect(exportName('Sparsh Ekaya / Shah', 'pptx')).toBe('Sparsh-Ekaya-Shah-Presentation.pptx')
    expect(exportName('', 'pdf')).toBe('Project-Presentation.pdf')
  })
})
