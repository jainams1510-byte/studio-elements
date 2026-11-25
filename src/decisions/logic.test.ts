import { describe, expect, it } from 'vitest'
import type { Drawing } from '../drawings'
import type { Decision, FeeInvoice, ProcurementItem, RaBill, SiteVisit } from '../domain'
import type { ScheduleSettings, Task } from '../schedule'
import {
  buildCalendarEntries,
  buildIcs,
  decisionOverdue,
  filterEntries,
  foldLine,
  fridaysBetween,
  groupByDay,
  icsEscape,
  icsWindow,
  mergeReports,
  materialGate,
  monthGrid,
  nextRevisionRound,
  procurementState,
  sameVendorName,
  sortDecisions,
  sortProcurement,
  weekStartOf,
  ENTRY_TYPES,
  type CalendarEntry,
  type ProjectCalendarData,
} from './logic'

const TODAY = '2026-11-23' // a Monday

function decision(extra: Partial<Decision> = {}): Decision {
  return {
    id: 'd', project_id: 'p', kind: 'rfi', approval_kind: null, question: 'Q', answer: '', raised_by: null, revision_round: null,
    need_by: null, blocks: '', decided_by: null, decided_on: null, status: 'open', cost_impact: null, drawing_id: null,
    boq_item_id: null, task_id: null, source_log_id: null, created_at: '2026-11-20T00:00:00Z', removed_at: null, ...extra,
  }
}

function item(extra: Partial<ProcurementItem> = {}): ProcurementItem {
  return {
    id: 'i', project_id: 'p', item: 'Granite', trade: null, room: null, task_id: null, need_by: null, lead_days: 14, vendor_id: null,
    spec_approved: false, status: 'specified', ordered_on: null, expected_on: null, delivered_on: null, note: '', removed_at: null, ...extra,
  }
}

function task(id: string, duration: number, after: string[] = [], extra: Partial<Task> = {}): Task {
  return {
    id, project_id: 'p', stage: 6, name: id, trade: null, room: null, owner_name: null, duration, milestone: duration === 0,
    after_ids: after, status: 'planned', actual_start: null, actual_end: null, gate_drawing_id: null,
    baseline_start: null, baseline_end: null, sort_order: 0, removed_at: null, ...extra,
  }
}

describe('decisions', () => {
  it('is overdue only when open and past its need-by date', () => {
    expect(decisionOverdue({ status: 'open', need_by: '2026-11-22' }, TODAY)).toBe(true)
    expect(decisionOverdue({ status: 'open', need_by: TODAY }, TODAY)).toBe(false)
    expect(decisionOverdue({ status: 'answered', need_by: '2026-11-01' }, TODAY)).toBe(false)
    expect(decisionOverdue({ status: 'open', need_by: null }, TODAY)).toBe(false)
  })

  it('sorts open first, then by need-by date', () => {
    const list = [
      decision({ id: 'closed', status: 'closed', need_by: '2026-11-01' }),
      decision({ id: 'late', status: 'open', need_by: '2026-12-10' }),
      decision({ id: 'early', status: 'open', need_by: '2026-11-25' }),
      decision({ id: 'none', status: 'open' }),
      decision({ id: 'ans', status: 'answered', need_by: '2026-11-01' }),
    ]
    expect(sortDecisions(list).map((d) => d.id)).toEqual(['early', 'late', 'none', 'ans', 'closed'])
  })

  it('suggests the next revision round, ignoring removed ones and the one being edited', () => {
    expect(nextRevisionRound([])).toBe(1)
    const list = [
      decision({ id: 'a', kind: 'revision', revision_round: 1 }),
      decision({ id: 'b', kind: 'revision', revision_round: 2 }),
      decision({ id: 'c', kind: 'revision', revision_round: 5, removed_at: '2026-11-22T00:00:00Z' }),
      decision({ id: 'd', kind: 'rfi', revision_round: 9 }),
    ]
    expect(nextRevisionRound(list)).toBe(3)
    expect(nextRevisionRound(list, 'b')).toBe(2)
    expect(nextRevisionRound([decision({ kind: 'revision', revision_round: 50 })])).toBe(50)
  })
})

describe('procurement order-by and flags', () => {
  it('order-by is the need date minus lead days in calendar days, across month and year ends', () => {
    expect(procurementState(item({ need_by: '2026-12-02', lead_days: 3 }), TODAY).orderBy).toBe('2026-11-29')
    expect(procurementState(item({ need_by: '2027-01-05', lead_days: 10 }), TODAY).orderBy).toBe('2026-12-26')
    expect(procurementState(item({ need_by: '2027-03-01', lead_days: 1 }), TODAY).orderBy).toBe('2027-02-28')
    expect(procurementState(item({ need_by: '2028-03-01', lead_days: 1 }), TODAY).orderBy).toBe('2028-02-29')
    expect(procurementState(item({ need_by: '2026-12-31', lead_days: 0 }), TODAY).orderBy).toBe('2026-12-31')
    expect(procurementState(item({}), TODAY)).toMatchObject({ need: null, orderBy: null, flags: [] })
  })

  it('uses the linked task forecast start before the need-by date', () => {
    const st = procurementState(item({ task_id: 't', need_by: '2027-01-30', lead_days: 7 }), TODAY, { name: 'Kitchen install', start: '2026-12-05' })
    expect(st).toMatchObject({ need: '2026-12-05', needSource: 'task', orderBy: '2026-11-28' })
    // A linked task without a forecast (no schedule yet) falls back to the date.
    expect(procurementState(item({ task_id: 't', need_by: '2026-12-20', lead_days: 7 }), TODAY, { name: 'X', start: null }))
      .toMatchObject({ need: '2026-12-20', needSource: 'date', orderBy: '2026-12-13' })
  })

  it('flags "Order by" within 7 days, inclusive, and not after', () => {
    const at = (orderBy: string) => procurementState(item({ need_by: orderBy, lead_days: 0 }), TODAY).flags.map((f) => f.text)
    expect(at(TODAY)).toEqual(['Order by 23 Nov'])
    expect(at('2026-11-30')).toEqual(['Order by 30 Nov'])
    expect(at('2026-12-01')).toEqual([])
    expect(procurementState(item({ need_by: '2026-12-03', lead_days: 5 }), TODAY).flags[0]).toMatchObject({ kind: 'order_soon', level: 'risk', text: 'Order by 28 Nov' })
  })

  it('flags "Order overdue" once the order-by date passes, and nothing once ordered', () => {
    expect(procurementState(item({ need_by: '2026-11-25', lead_days: 5 }), TODAY).flags.map((f) => f.kind)).toEqual(['order_overdue'])
    expect(procurementState(item({ need_by: '2026-11-25', lead_days: 5, status: 'approved' }), TODAY).flags.map((f) => f.kind)).toEqual(['order_overdue'])
    expect(procurementState(item({ need_by: '2026-11-25', lead_days: 5, status: 'ordered' }), TODAY).flags).toEqual([])
  })

  it('flags late delivery and delivery after the need date, until on site', () => {
    const late = procurementState(item({ need_by: '2026-12-08', status: 'ordered', expected_on: '2026-11-22' }), TODAY)
    expect(late.flags.map((f) => f.kind)).toEqual(['delivery_late'])
    const notInTime = procurementState(item({ task_id: 't', status: 'ordered', expected_on: '2026-12-10' }), TODAY, { name: 'Kitchen install', start: '2026-12-08' })
    expect(notInTime.flags.map((f) => f.text)).toEqual(['Not in time for Kitchen install'])
    const sameDay = procurementState(item({ task_id: 't', status: 'ordered', expected_on: '2026-12-08' }), TODAY, { name: 'K', start: '2026-12-08' })
    expect(sameDay.flags).toEqual([])
    const byDate = procurementState(item({ need_by: '2026-12-08', status: 'ordered', expected_on: '2026-12-09' }), TODAY)
    expect(byDate.flags[0].text).toBe('Not in time for the need-by date (8 Dec)')
    const onSite = procurementState(item({ need_by: '2026-12-08', status: 'on_site', expected_on: '2026-11-01' }), TODAY)
    expect(onSite.flags).toEqual([])
  })

  it('sorts by order-by date, items on site last', () => {
    const rows = [
      item({ id: 'site', item: 'A', status: 'on_site', need_by: '2026-11-24', lead_days: 0 }),
      item({ id: 'late', item: 'B', need_by: '2026-12-20', lead_days: 0 }),
      item({ id: 'none', item: 'C' }),
      item({ id: 'soon', item: 'D', need_by: '2026-12-01', lead_days: 0 }),
    ].map((it) => ({ item: it, state: procurementState(it, TODAY) }))
    expect(sortProcurement(rows).map((r) => r.item.id)).toEqual(['soon', 'late', 'none', 'site'])
  })

  it('matches vendor names case-insensitively and ignoring spaces at the ends', () => {
    expect(sameVendorName(' Shree Granite ', 'shree granite')).toBe(true)
    expect(sameVendorName('Shree Granite', 'Shree Granites')).toBe(false)
  })
})

describe('material gate', () => {
  it('lists tasks starting within 7 days or started, with items not on site', () => {
    const tasks = [
      task('running', 5, [], { status: 'in_progress', actual_start: '2026-11-20' }),
      task('soon', 3),
      task('later', 3),
      task('done', 3, [], { status: 'done' }),
      task('delivered', 3),
      task('free', 3),
    ]
    const planned = {
      running: { start: '2026-11-20' }, soon: { start: '2026-11-30' }, later: { start: '2026-12-01' },
      done: { start: '2026-11-24' }, delivered: { start: TODAY }, free: { start: TODAY },
    }
    const items = [
      item({ id: '1', task_id: 'running' }), item({ id: '2', task_id: 'soon', status: 'ordered' }), item({ id: '3', task_id: 'later' }),
      item({ id: '4', task_id: 'done' }), item({ id: '5', task_id: 'delivered', status: 'on_site' }),
      item({ id: '6', task_id: 'soon', removed_at: '2026-11-22T00:00:00Z' }),
    ]
    const gate = materialGate(items, tasks, planned, TODAY)
    expect(gate.map((g) => g.task.id)).toEqual(['running', 'soon'])
    expect(gate[0].started).toBe(true)
    expect(gate[1].items.map((i) => i.id)).toEqual(['2'])
  })
})

// ---------------------------------------------------------------------------------------------

const settings: ScheduleSettings = { project_id: 'p', start_date: TODAY, work_days: [1, 2, 3, 4, 5, 6], holidays: [], baseline_at: null, baseline_by: null }
const drawingP2: Drawing = {
  id: 'dr', project_id: 'p', number: 'SE-EL-01', title: 'Electrical', discipline: 'Electrical', archived: false,
  drawing_revisions: [{ id: 'r', code: 'P2', rank: 2, revised_on: '2026-11-20', note: '', file_link: null, created_at: '', drawing_issues: [] }],
}
const drawingR0: Drawing = { ...drawingP2, id: 'dr0', number: 'SE-FL-01', drawing_revisions: [{ ...drawingP2.drawing_revisions[0], code: 'R0', rank: 1000 }] }

function bill(extra: Partial<RaBill>): RaBill {
  return {
    id: 'b', project_id: 'p', vendor_id: 'v', work_order_id: null, bill_no: 'RA-1', bill_date: '2026-11-10', claimed_amount: 1000,
    certified_amount: 900, gst_rate: 18, status: 'client_approved', certified_on: '2026-11-20', client_approved_on: '2026-11-24',
    paid_on: null, paid_amount: null, note: '', file_link: null, removed_at: null, ...extra,
  }
}
function invoice(extra: Partial<FeeInvoice>): FeeInvoice {
  return {
    id: 'f', project_id: 'p', milestone: 'Concept approval', task_id: null, amount: 50000, gst_rate: 18, due_date: '2026-12-01',
    status: 'scheduled', invoice_no: null, raised_on: null, paid_on: null, paid_amount: null, note: '', sort_order: 0, removed_at: null, ...extra,
  }
}
const visit = (extra: Partial<SiteVisit>): SiteVisit => ({ id: 'v1', project_id: 'p', visit_on: '2026-11-26', visit_time: '10:30', purpose: 'Electrical check', removed_at: null, ...extra })

function data(extra: Partial<ProjectCalendarData> = {}): ProjectCalendarData {
  return {
    project: { id: 'p', name: 'Sparsh Ekaya' },
    settings,
    // A: 5 working days from Mon 23 Nov = 23–27 Nov. M (milestone) after A sits on Fri 27 Nov.
    // G (gated on SE-EL-01 at P2) after A starts Sat 28 Nov. H gated on an R0 sheet: no entry.
    tasks: [task('A', 5), task('M', 0, ['A']), task('G', 4, ['A'], { gate_drawing_id: 'dr', name: 'Wiring' }), task('H', 2, ['A'], { gate_drawing_id: 'dr0' }),
      task('X', 0, [], { removed_at: '2026-11-20T00:00:00Z' })],
    drawings: [drawingP2, drawingR0],
    procurement: [item({ id: 'pi', item: 'Conduits', task_id: 'G', lead_days: 3 }), item({ id: 'po', status: 'ordered', need_by: '2026-11-30', lead_days: 2 })],
    visits: [visit({}), visit({ id: 'v2', removed_at: '2026-11-22T00:00:00Z' })],
    invoices: [invoice({}), invoice({ id: 'paid', status: 'paid' })],
    bills: [bill({}), bill({ id: 'paidbill', status: 'paid' }), bill({ id: 'cert', status: 'certified', client_approved_on: null })],
    decisions: [decision({ id: 'open', need_by: '2026-11-30', question: 'Kitchen granite, or quartz?' }), decision({ id: 'closed', status: 'closed', need_by: '2026-11-30' })],
    ...extra,
  }
}

describe('calendar entries', () => {
  const entries = buildCalendarEntries([data()], { v: 'Shree Electricals' }, TODAY, '2026-12-06', TODAY)
  const on = (type: string) => entries.filter((e) => e.type === type).map((e) => [e.date, e.title])

  it('puts each type on its day', () => {
    expect(on('milestone')).toEqual([['2026-11-27', 'M']])
    expect(on('sheet')).toEqual([['2026-11-28', 'Sheet SE-EL-01 needed by 28 Nov']])
    expect(on('order')).toEqual([['2026-11-25', 'Order Conduits']]) // G starts 28 Nov − 3 days
    expect(on('visit')).toEqual([['2026-11-26', 'Site visit: Electrical check']])
    expect(on('fee')).toEqual([['2026-12-01', 'Fee invoice due: Concept approval']])
    expect(on('bill')).toEqual([['2026-12-01', 'Payment expected: Shree Electricals bill RA-1']]) // approved 24 Nov + 7
    expect(on('decision')).toEqual([['2026-11-30', 'Kitchen granite, or quartz?']])
    expect(on('report')).toEqual([['2026-11-27', 'Weekly report'], ['2026-12-04', 'Weekly report']])
  })

  it('links each entry to its source', () => {
    const href = Object.fromEntries(entries.map((e) => [e.type, e.href]))
    expect(href).toEqual({
      milestone: '/project/p/schedule', sheet: '/drawing/dr', order: '/project/p/procurement', visit: null,
      fee: '/project/p/fees', bill: '/project/p/money', decision: '/project/p/decisions', report: '/project/p/reports',
    })
    expect(entries.find((e) => e.type === 'visit')?.visitId).toBe('v1')
  })

  it('is sorted by date and has unique keys', () => {
    expect(entries.map((e) => e.date)).toEqual([...entries.map((e) => e.date)].sort())
    expect(new Set(entries.map((e) => e.key)).size).toBe(entries.length)
  })

  it('leaves out what is outside the range, and needs a schedule for task dates', () => {
    const later = buildCalendarEntries([data()], {}, '2026-11-28', '2026-11-29', TODAY)
    expect(later.map((e) => e.type)).toEqual(['sheet'])
    const noSchedule = buildCalendarEntries([data({ settings: null })], {}, TODAY, '2026-12-06', TODAY)
    expect(noSchedule.some((e) => e.type === 'milestone' || e.type === 'sheet' || e.type === 'order')).toBe(false)
  })

  it('filters by type and project', () => {
    const two = buildCalendarEntries([data(), data({ project: { id: 'q', name: 'Aggrawal Atelier' } })], {}, TODAY, '2026-12-06', TODAY)
    const all = new Set(ENTRY_TYPES)
    expect(filterEntries(two, { types: all, projectId: 'all' }).length).toBe(two.length)
    expect(filterEntries(two, { types: all, projectId: 'q' }).every((e) => e.projectId === 'q')).toBe(true)
    expect(filterEntries(two, { types: new Set(['milestone'] as const), projectId: 'all' }).map((e) => e.projectName)).toEqual(['Aggrawal Atelier', 'Sparsh Ekaya'])
    expect(filterEntries(two, { types: new Set(), projectId: 'all' })).toEqual([])
  })

  it('merges weekly reports of several projects into one entry per Friday', () => {
    const two = buildCalendarEntries([data(), data({ project: { id: 'q', name: 'Aggrawal Atelier' } })], {}, TODAY, '2026-12-06', TODAY)
    const merged = mergeReports(two)
    const reports = merged.filter((e) => e.type === 'report')
    expect(reports.map((e) => e.date)).toEqual(['2026-11-27', '2026-12-04'])
    expect(reports[0].parts).toEqual([
      { projectId: 'q', projectName: 'Aggrawal Atelier', href: '/project/q/reports' },
      { projectId: 'p', projectName: 'Sparsh Ekaya', href: '/project/p/reports' },
    ])
    expect(merged.length).toBe(two.length - 2)
    expect(merged.filter((e) => e.type !== 'report')).toEqual(two.filter((e) => e.type !== 'report'))
    // A single project keeps its own entry and link.
    expect(mergeReports(entries).filter((e) => e.type === 'report').every((e) => !e.parts && e.href === '/project/p/reports')).toBe(true)
  })

  it('groups by day', () => {
    const groups = groupByDay(entries)
    expect(groups[0].date).toBe('2026-11-25')
    expect(groups.find((g) => g.date === '2026-11-27')?.entries.map((e) => e.type)).toEqual(['milestone', 'report'])
  })
})

describe('weeks start on Monday', () => {
  it('finds the Monday of any date', () => {
    expect(weekStartOf('2026-11-23')).toBe('2026-11-23')
    expect(weekStartOf('2026-11-29')).toBe('2026-11-23') // Sunday belongs to the week before
    expect(weekStartOf('2026-12-02')).toBe('2026-11-30')
    expect(weekStartOf('2027-01-01')).toBe('2026-12-28')
  })

  it('builds month grids Monday first, covering the whole month', () => {
    const nov = monthGrid(2026, 11) // 1 Nov is a Sunday, 30 Nov a Monday
    expect(nov[0][0]).toBe('2026-10-26')
    expect(nov[0][6]).toBe('2026-11-01')
    expect(nov.length).toBe(6)
    expect(nov[5]).toEqual(['2026-11-30', '2026-12-01', '2026-12-02', '2026-12-03', '2026-12-04', '2026-12-05', '2026-12-06'])
    const feb = monthGrid(2027, 2) // 1 Feb Monday, 28 Feb Sunday: exactly four weeks
    expect(feb.length).toBe(4)
    expect(feb[0][0]).toBe('2027-02-01')
    expect(feb[3][6]).toBe('2027-02-28')
    expect(monthGrid(2026, 12)[0][0]).toBe('2026-11-30')
  })

  it('lists Fridays, including the ends', () => {
    expect(fridaysBetween('2026-11-27', '2026-12-11')).toEqual(['2026-11-27', '2026-12-04', '2026-12-11'])
    expect(fridaysBetween('2026-11-28', '2026-12-03')).toEqual([])
    expect(fridaysBetween('2026-12-26', '2027-01-08')).toEqual(['2027-01-01', '2027-01-08'])
  })
})

describe('phone calendar file', () => {
  const entry = (extra: Partial<CalendarEntry>): CalendarEntry => ({
    key: 'decision:abc:2026-11-30', date: '2026-11-30', type: 'decision', title: 'Granite, or quartz; confirm', detail: 'Line one\nLine two',
    projectId: 'p', projectName: 'Sparsh Ekaya', href: null, ...extra,
  })

  it('escapes backslashes, semicolons, commas and newlines', () => {
    expect(icsEscape('a\\b;c,d\ne\r\nf')).toBe('a\\\\b\\;c\\,d\\ne\\nf')
  })

  it('writes all-day events with CRLF endings, DTSTAMP and unique UIDs', () => {
    const ics = buildIcs([entry({}), entry({}), entry({ key: 'report:p:2026-12-31', date: '2026-12-31', type: 'report', title: 'Weekly report', detail: '' })],
      new Date('2026-11-23T04:05:06.789Z'))
    expect(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n')).toBe(true)
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true)
    expect(ics.replace(/\r\n/g, '').includes('\n')).toBe(false) // no bare LF
    expect(ics.match(/BEGIN:VEVENT/g)?.length).toBe(3)
    expect(ics).toContain('DTSTART;VALUE=DATE:20261130\r\nDTEND;VALUE=DATE:20261201\r\n')
    expect(ics).toContain('DTSTART;VALUE=DATE:20261231\r\nDTEND;VALUE=DATE:20270101\r\n') // year end
    expect(ics).toContain('DTSTAMP:20261123T040506Z')
    expect(ics).toContain('SUMMARY:Decision: Granite\\, or quartz\\; confirm')
    expect(ics).toContain('DESCRIPTION:Sparsh Ekaya · Line one\\nLine two')
    const uids = [...ics.matchAll(/^UID:(.+)$/gm)].map((m) => m[1].trim())
    expect(uids.length).toBe(3)
    expect(new Set(uids).size).toBe(3)
  })

  it('folds long lines at 75 octets without splitting characters', () => {
    const line = 'SUMMARY:' + '₹ 1,00,000 · '.repeat(12)
    const folded = foldLine(line)
    const parts = folded.split('\r\n')
    expect(parts.length).toBeGreaterThan(1)
    for (const p of parts) expect(new TextEncoder().encode(p).length).toBeLessThanOrEqual(75)
    expect(parts.slice(1).every((p) => p.startsWith(' '))).toBe(true)
    expect(parts.map((p, i) => (i ? p.slice(1) : p)).join('')).toBe(line)
    expect(foldLine('SHORT:x')).toBe('SHORT:x')
  })

  it('keeps the next 90 days from today', () => {
    const list = [entry({ date: '2026-11-22' }), entry({ date: TODAY }), entry({ date: '2027-02-20' }), entry({ date: '2027-02-21' })]
    // 23 Nov + 90 days = 21 Feb 2027 (Nov 7 + Dec 31 + Jan 31 + Feb 21), which is the first day left out.
    expect(icsWindow(list, TODAY).map((e) => e.date)).toEqual([TODAY, '2027-02-20'])
  })
})
