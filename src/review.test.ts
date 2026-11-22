import { describe, expect, it } from 'vitest'
import { addDays, reportDue, reviewState, stillNeeded, weekStart, type ReviewLite } from './review'

const c = (id: string, role = 'team'): ReviewLite => ({ reviewer_id: id, decision: 'confirm', role })

describe('two-person verification', () => {
  it('pending and failed pass straight through', () => {
    expect(reviewState('pending', [c('a', 'owner'), c('b')])).toBe('pending')
    expect(reviewState('failed', [])).toBe('failed')
  })

  it('needs two different people, one of them the coordinator or owner', () => {
    expect(reviewState('done', [])).toBe('unverified')
    expect(reviewState('done', [c('a', 'coordinator')])).toBe('unverified')
    expect(reviewState('done', [c('a'), c('b')])).toBe('unverified')
    expect(reviewState('done', [c('a', 'coordinator'), c('b')])).toBe('verified')
    expect(reviewState('done', [c('a', 'owner'), c('b')])).toBe('verified')
  })

  it('the same person twice does not count as two', () => {
    expect(reviewState('done', [c('a', 'coordinator'), c('a', 'coordinator')])).toBe('unverified')
  })

  it('any rejection rejects it', () => {
    expect(reviewState('done', [c('a', 'coordinator'), c('b'), { reviewer_id: 'c', decision: 'reject', role: 'team' }])).toBe('rejected')
  })

  it('says what is still needed', () => {
    expect(stillNeeded([])).toBe('Needs the coordinator and one team member')
    expect(stillNeeded([c('a')])).toBe('Needs the coordinator')
    expect(stillNeeded([c('a', 'coordinator')])).toBe('Needs one team member')
    expect(stillNeeded([c('a', 'coordinator'), c('b')])).toBe('')
  })
})

describe('report weeks', () => {
  it('weeks start on Monday', () => {
    expect(weekStart(new Date(2026, 10, 22))).toBe('2026-11-16') // Sunday
    expect(weekStart(new Date(2026, 10, 16))).toBe('2026-11-16') // Monday
    expect(weekStart(new Date(2026, 10, 20, 18))).toBe('2026-11-16') // Friday evening
    expect(weekStart(new Date(2027, 0, 1))).toBe('2026-12-28') // across the year
  })

  it('adds days across month ends', () => {
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01')
    expect(addDays('2026-11-16', -7)).toBe('2026-11-09')
  })

  it('the report is due from Friday 5 pm to Sunday', () => {
    expect(reportDue(new Date(2026, 10, 20, 16, 59))).toBe(false)
    expect(reportDue(new Date(2026, 10, 20, 17, 0))).toBe(true)
    expect(reportDue(new Date(2026, 10, 22, 12))).toBe(true)
    expect(reportDue(new Date(2026, 10, 23, 9))).toBe(false)
  })
})
