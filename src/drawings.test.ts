import { describe, expect, it } from 'vitest'
import {
  currentRevision,
  isValidCode,
  needsAttention,
  nextCodes,
  rankOf,
  siteStatus,
  todayLocal,
  type Drawing,
  type Issue,
  type Revision,
} from './drawings'

function rev(code: string, issues: Partial<Issue>[] = []): Revision {
  return {
    id: `rev-${code}`,
    code,
    rank: rankOf(code),
    revised_on: '2026-11-01',
    note: '',
    file_link: null,
    created_at: '2026-11-01T00:00:00Z',
    drawing_issues: issues.map((i, n) => ({
      id: `${code}-issue-${n}`,
      issued_to: 'Site',
      method: 'Print on site',
      issued_on: '2026-11-02',
      print_photo_path: null,
      created_at: '2026-11-02T00:00:00Z',
      ...i,
    })),
  }
}

function drawing(revisions: Revision[]): Drawing {
  return { id: 'd1', project_id: 'p1', number: 'SR-EL-03', title: 'Electrical', discipline: 'Electrical', archived: false, drawing_revisions: revisions }
}

describe('revision codes', () => {
  it('accepts P1, P12, R0, R3 and lower case, rejects the rest', () => {
    for (const ok of ['P1', 'P12', 'R0', 'R3', 'r1', ' p2 ']) expect(isValidCode(ok)).toBe(true)
    for (const bad of ['P0', 'A', 'R', 'X1', 'P1a', 'R-1', '', 'P1234']) expect(isValidCode(bad)).toBe(false)
  })

  it('orders every R after every P, as the database does', () => {
    expect(rankOf('P1')).toBe(1)
    expect(rankOf('P2')).toBe(2)
    expect(rankOf('R0')).toBe(1000)
    expect(rankOf('R1')).toBe(1001)
    expect(rankOf('P99')).toBeLessThan(rankOf('R0'))
  })

  it('suggests the next code, and R0 while still preliminary', () => {
    expect(nextCodes(null)).toEqual({ next: 'P1', construction: 'R0' })
    expect(nextCodes('P2')).toEqual({ next: 'P3', construction: 'R0' })
    expect(nextCodes('R0')).toEqual({ next: 'R1', construction: null })
    expect(nextCodes('R9')).toEqual({ next: 'R10', construction: null })
  })

  it('current revision is the highest, not the newest row', () => {
    expect(currentRevision(drawing([rev('R1'), rev('P2'), rev('R0')]))?.code).toBe('R1')
    expect(currentRevision(drawing([]))).toBeNull()
  })
})

describe('what the site holds', () => {
  it('nothing issued to site', () => {
    expect(siteStatus(drawing([rev('R0', [{ issued_to: 'Client' }])]))).toEqual({ kind: 'none' })
  })

  it('site has the current construction revision', () => {
    const s = siteStatus(drawing([rev('R0'), rev('R1', [{}])]))
    expect(s).toEqual({ kind: 'current', held: 'R1' })
    expect(needsAttention(s)).toBe(false)
  })

  it('site holds a superseded revision', () => {
    const s = siteStatus(drawing([rev('R0', [{}]), rev('R1', [{ issued_to: 'Client' }])]))
    expect(s).toEqual({ kind: 'outdated', held: 'R0', current: 'R1' })
    expect(needsAttention(s)).toBe(true)
  })

  it('site holds a preliminary revision', () => {
    const s = siteStatus(drawing([rev('P2', [{}])]))
    expect(s).toEqual({ kind: 'preliminary', held: 'P2' })
    expect(needsAttention(s)).toBe(true)
  })

  it('uses the latest issue to site, and matches "site" in any case', () => {
    const s = siteStatus(
      drawing([
        rev('R0', [{ issued_on: '2026-11-03' }]),
        rev('R1', [{ issued_to: ' SITE ', issued_on: '2026-11-10' }]),
      ]),
    )
    expect(s).toEqual({ kind: 'current', held: 'R1' })
  })
})

describe('dates', () => {
  it('gives the local calendar date', () => {
    expect(todayLocal(new Date(2026, 10, 22, 23, 30))).toBe('2026-11-22')
    expect(todayLocal(new Date(2026, 0, 5, 0, 5))).toBe('2026-01-05')
  })
})
