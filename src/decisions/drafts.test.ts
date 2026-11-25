import { describe, expect, it } from 'vitest'
import type { Decision, ProcurementItem } from '../domain'
import { confirmationDraft, decisionDrafts, fingerprint, procurementDrafts } from './drafts'

const TODAY = '2026-11-23'
const projects = [{ id: 'p', name: 'Sparsh Ekaya' }]

function decision(extra: Partial<Decision> = {}): Decision {
  return {
    id: 'd', project_id: 'p', kind: 'approval', approval_kind: 'client', question: 'Kitchen counter: granite or quartz?', answer: '',
    raised_by: null, revision_round: null, need_by: '2026-11-20', blocks: 'kitchen carcass production', decided_by: null, decided_on: null,
    status: 'open', cost_impact: null, drawing_id: null, boq_item_id: null, task_id: null, source_log_id: null,
    created_at: '2026-11-15T00:00:00Z', removed_at: null, ...extra,
  }
}

function item(extra: Partial<ProcurementItem> = {}): ProcurementItem {
  return {
    id: 'i', project_id: 'p', item: 'Granite slab', trade: null, room: 'Kitchen', task_id: null, need_by: '2026-12-03', lead_days: 5,
    vendor_id: 'v', spec_approved: true, status: 'approved', ordered_on: null, expected_on: null, delivered_on: null, note: '', removed_at: null, ...extra,
  }
}

describe('decision drafts', () => {
  it('reminds the client about open approvals past their need-by date only', () => {
    const drafts = decisionDrafts({
      today: TODAY, projects,
      decisions: [
        decision({ id: 'late' }),
        decision({ id: 'today', need_by: TODAY }),
        decision({ id: 'answered', status: 'answered' }),
        decision({ id: 'rfi', kind: 'rfi', approval_kind: null }),
        decision({ id: 'removed', removed_at: '2026-11-22T00:00:00Z' }),
        decision({ id: 'other', project_id: 'unknown' }),
      ],
    })
    expect(drafts.map((d) => [d.kind, d.key])).toEqual([['client', 'approval:late:2026-11-20']])
    expect(drafts[0].body).toContain('“Kitchen counter: granite or quartz?”')
    expect(drafts[0].body).toContain('needed by 20 Nov, and kitchen carcass production is waiting on it')
    expect(drafts[0].why).toContain('3 days ago')
  })

  it('drafts a group confirmation for confirmed decisions, with the links and cost', () => {
    const d = decision({ status: 'confirmed', answer: 'Quartz, Caesarstone 4001', decided_by: 'Mr Sunil Shah', decided_on: '2026-11-22', cost_impact: 45000 })
    const [draft] = decisionDrafts({ today: TODAY, projects, decisions: [d], links: { d: ['Sheet SE-JN-02 Kitchen joinery'] } })
    expect(draft.kind).toBe('site')
    expect(draft.to).toBe('Project WhatsApp group')
    expect(draft.body).toContain('Question: Kitchen counter: granite or quartz?')
    expect(draft.body).toContain('Decision: Quartz, Caesarstone 4001')
    expect(draft.body).toContain('Decided by Mr Sunil Shah on 22 Nov.')
    expect(draft.body).toContain('Refers to: Sheet SE-JN-02 Kitchen joinery.')
    expect(draft.body).toContain('Cost impact: ₹ 45,000')
    expect(draft.body).toContain('Client approval')
  })

  it('changes keys when the situation changes', () => {
    const a = decisionDrafts({ today: TODAY, projects, decisions: [decision()] })[0].key
    const moved = decisionDrafts({ today: TODAY, projects, decisions: [decision({ need_by: '2026-11-21' })] })[0].key
    expect(moved).not.toBe(a)
    // Still overdue a day later with the same need-by: the same draft (not a new one every day).
    expect(decisionDrafts({ today: '2026-11-24', projects, decisions: [decision()] })[0].key).toBe(a)
    const c1 = confirmationDraft(decision({ status: 'confirmed', answer: 'Quartz' }), 'Sparsh Ekaya').key
    const c2 = confirmationDraft(decision({ status: 'confirmed', answer: 'Granite' }), 'Sparsh Ekaya').key
    const c3 = confirmationDraft(decision({ status: 'confirmed', answer: 'Quartz', cost_impact: 1000 }), 'Sparsh Ekaya').key
    expect(new Set([c1, c2, c3]).size).toBe(3)
    expect(confirmationDraft(decision({ status: 'confirmed', answer: 'Quartz' }), 'Sparsh Ekaya').key).toBe(c1)
    expect(fingerprint('a')).not.toBe(fingerprint('b'))
  })
})

describe('procurement drafts', () => {
  const base = { today: TODAY, projects, vendors: [{ id: 'v', name: 'Shree Granite' }], tasks: [{ id: 't', name: 'Kitchen install' }], taskStarts: { t: '2026-12-05' } }

  it('reminds the team when the order-by date is within 7 days and the item is not ordered', () => {
    const drafts = procurementDrafts({
      ...base,
      items: [
        item({ id: 'soon' }), // 3 Dec − 5 = 28 Nov
        item({ id: 'task', task_id: 't', need_by: null, lead_days: 7, vendor_id: null }), // 5 Dec − 7 = 28 Nov
        item({ id: 'far', need_by: '2026-12-20' }), // 15 Dec: too far
        item({ id: 'ordered', status: 'ordered' }),
        item({ id: 'late', need_by: '2026-11-25' }), // 20 Nov: overdue
        item({ id: 'nodate', need_by: null }),
      ],
    })
    expect(drafts.map((d) => d.key.split(':')[1])).toEqual(['soon', 'task', 'late'])
    expect(drafts.every((d) => d.kind === 'team')).toBe(true)
    expect(drafts[0].subject).toBe('Order by 28 Nov: Granite slab')
    expect(drafts[0].body).toContain('must be ordered by 28 Nov from Shree Granite to be on site by 3 Dec')
    expect(drafts[1].body).toContain('(no vendor chosen yet) to be on site by 5 Dec for “Kitchen install”')
    expect(drafts[2].subject).toBe('Order overdue: Granite slab')
    expect(drafts[2].body).toContain('should have been ordered by 20 Nov')
  })

  it('changes keys when the date, vendor, status or urgency changes', () => {
    const key = (it: ProcurementItem, today = TODAY) => procurementDrafts({ ...base, today, items: [it] })[0]?.key
    const k = key(item())
    expect(key(item({ need_by: '2026-12-04' }))).not.toBe(k)
    expect(key(item({ vendor_id: 'w' }))).not.toBe(k)
    expect(key(item({ status: 'specified' }))).not.toBe(k)
    expect(key(item(), '2026-11-29')).not.toBe(k) // now overdue
    expect(key(item(), '2026-11-24')).toBe(k) // nothing changed
  })
})
