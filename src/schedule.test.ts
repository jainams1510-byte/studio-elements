import { describe, expect, it } from 'vitest'
import { baselinePlan, computeSchedule, makesLoop, statusLabel, WorkCalendar, type Task } from './schedule'
import { TEMPLATE, templateRows } from './templates'

const MON_SAT = [1, 2, 3, 4, 5, 6]

function task(id: string, duration: number, after: string[] = [], extra: Partial<Task> = {}): Task {
  return {
    id,
    project_id: 'p',
    stage: 6,
    name: id,
    trade: null,
    room: null,
    owner_name: null,
    duration,
    milestone: duration === 0,
    after_ids: after,
    status: 'planned',
    actual_start: null,
    actual_end: null,
    gate_drawing_id: null,
    baseline_start: null,
    baseline_end: null,
    sort_order: 0,
    removed_at: null,
    ...extra,
  }
}

describe('working calendar', () => {
  // 23 Nov 2026 is a Monday.
  const cal = new WorkCalendar('2026-11-23', MON_SAT)

  it('skips Sundays', () => {
    expect(cal.dateOf(0)).toBe('2026-11-23')
    expect(cal.dateOf(5)).toBe('2026-11-28') // Saturday
    expect(cal.dateOf(6)).toBe('2026-11-30') // Monday, Sunday skipped
  })

  it('rolls a Sunday forward for a start and back for a finish', () => {
    expect(cal.startIndex('2026-11-29')).toBe(6)
    expect(cal.endIndex('2026-11-29')).toBe(5)
  })

  it('counts back before the start', () => {
    expect(cal.dateOf(-1)).toBe('2026-11-21')
    expect(cal.dateOf(-2)).toBe('2026-11-20')
    expect(cal.startIndex('2026-11-20')).toBe(-2)
  })

  it('skips holidays', () => {
    const withHoliday = new WorkCalendar('2026-11-23', MON_SAT, ['2026-11-25'])
    expect(withHoliday.dateOf(2)).toBe('2026-11-26')
    expect(withHoliday.startIndex('2026-11-25')).toBe(2)
  })

  it('starts on the next working day when the start is a Sunday', () => {
    expect(new WorkCalendar('2026-11-22', MON_SAT).dateOf(0)).toBe('2026-11-23')
  })

  it('agrees with a day-by-day count over a long stretch', () => {
    const c = new WorkCalendar('2026-11-23', [1, 2, 3, 4, 5], ['2026-12-25', '2027-01-26'])
    let n = 0
    let d = new Date(Date.UTC(2026, 10, 23))
    for (let i = 0; i < 500; i++) {
      const iso = d.toISOString().slice(0, 10)
      const wd = d.getUTCDay()
      const working = wd !== 0 && wd !== 6 && iso !== '2026-12-25' && iso !== '2027-01-26'
      if (working) {
        expect(c.dateOf(n)).toBe(iso)
        expect(c.startIndex(iso)).toBe(n)
        n++
      }
      d = new Date(d.getTime() + 86_400_000)
    }
  })
})

describe('critical path', () => {
  const cal = new WorkCalendar('2026-11-23', MON_SAT)
  // A(3) -> B(2) -> D(1);  A -> C(5) -> D. Worked out by hand:
  // A Mon 23 - Wed 25, B Thu 26 - Fri 27, C Thu 26 - Tue 1 Dec, D Wed 2 Dec.
  const net = () => [task('A', 3), task('B', 2, ['A']), task('C', 5, ['A']), task('D', 1, ['B', 'C'])]

  it('dates every task and finds the longest chain', () => {
    const r = computeSchedule(net(), cal, '2026-11-01')
    expect(r.ok).toBe(true)
    expect([r.tasks.A.start, r.tasks.A.end]).toEqual(['2026-11-23', '2026-11-25'])
    expect([r.tasks.B.start, r.tasks.B.end]).toEqual(['2026-11-26', '2026-11-27'])
    expect([r.tasks.C.start, r.tasks.C.end]).toEqual(['2026-11-26', '2026-12-01'])
    expect([r.tasks.D.start, r.tasks.D.end]).toEqual(['2026-12-02', '2026-12-02'])
    expect(r.finish).toBe('2026-12-02')
    expect(r.criticalPath).toEqual(['A', 'C', 'D'])
    expect(r.tasks.B.float).toBe(3)
    expect(r.tasks.B.critical).toBe(false)
  })

  it('puts a milestone on its predecessor’s finish day', () => {
    const r = computeSchedule([...net(), task('G', 0, ['D']), task('E', 2, ['G'])], cal, '2026-11-01')
    expect(r.tasks.G.start).toBe('2026-12-02')
    expect(r.tasks.G.end).toBe('2026-12-02')
    expect([r.tasks.E.start, r.tasks.E.end]).toEqual(['2026-12-03', '2026-12-04'])
  })

  it('re-forecasts from progress and today', () => {
    // Today Tue 1 Dec. A done on time; B started Thu 26 for 2 days and is still going; C not started.
    const tasks = net()
    tasks[0] = { ...tasks[0], status: 'done', actual_start: '2026-11-23', actual_end: '2026-11-25' }
    tasks[1] = { ...tasks[1], status: 'in_progress', actual_start: '2026-11-26' }
    tasks[3] = { ...tasks[3], baseline_end: '2026-12-02' }
    const r = computeSchedule(tasks, cal, '2026-12-01')
    expect(r.tasks.B.end).toBe('2026-12-01') // finishes today at the earliest
    expect(r.tasks.B.overdue).toBe(true)
    expect([r.tasks.C.start, r.tasks.C.end]).toEqual(['2026-12-01', '2026-12-05'])
    expect(r.tasks.D.end).toBe('2026-12-07') // Sunday 6th skipped
    expect(r.tasks.D.slip).toBe(4)
    expect(r.slip).toBe(4)
    expect(r.criticalPath).toEqual(['C', 'D']) // A is done
    expect(statusLabel(tasks[3], r.tasks.D)).toBe('Slipped 4d')
    expect(statusLabel(tasks[1], r.tasks.B)).toBe('Overdue')
  })

  it('reports a loop instead of dating it', () => {
    const r = computeSchedule([task('X', 2, ['Y']), task('Y', 2, ['X']), task('Z', 1)], cal, '2026-11-01')
    expect(r.ok).toBe(false)
    expect(r.loop.sort()).toEqual(['X', 'Y'])
    expect(r.tasks.Z.end).toBe('2026-11-23')
  })

  it('ignores removed tasks and links to them', () => {
    const tasks = net()
    tasks[2] = { ...tasks[2], removed_at: '2026-11-20T00:00:00Z' }
    const r = computeSchedule(tasks, cal, '2026-11-01')
    expect(r.tasks.C).toBeUndefined()
    expect(r.tasks.D.end).toBe('2026-11-28')
  })

  it('spots a link that would make a loop', () => {
    expect(makesLoop(net(), 'A', ['D'])).toBe(true)
    expect(makesLoop(net(), 'D', ['A'])).toBe(false)
  })

  it('freezes every dated task into the baseline plan', () => {
    const plan = baselinePlan(computeSchedule(net(), cal, '2026-11-01'))
    expect(plan.C).toEqual({ start: '2026-11-26', end: '2026-12-01' })
    expect(Object.keys(plan).sort()).toEqual(['A', 'B', 'C', 'D'])
  })
})

describe('stage templates', () => {
  it('links only to tasks that exist and come earlier', () => {
    const keys = new Set<string>()
    for (const t of TEMPLATE) {
      for (const a of t.after) expect(keys.has(a), `${t.key} after ${a}`).toBe(true)
      keys.add(t.key)
    }
  })

  it('keeps links inside the chosen stages', () => {
    const rows = templateRows('p', 3)
    const ids = new Set(rows.map((r) => r.id))
    expect(rows[0].stage).toBe(3)
    for (const r of rows) for (const a of r.after_ids) expect(ids.has(a)).toBe(true)
    expect(rows.filter((r) => r.after_ids.length === 0).map((r) => r.template_key).sort()).toEqual(
      ['wd-el', 'wd-hvac', 'wd-jo', 'wd-pl', 'wd-rcp', 'wd-ti'].sort(),
    )
  })

  it('finishes on the longest chain worked out a second way', () => {
    // Independent longest path over the template, in working days.
    const finishDay = new Map<string, number>()
    for (const t of TEMPLATE) {
      const start = Math.max(0, ...t.after.map((a) => finishDay.get(a)!))
      finishDay.set(t.key, start + t.duration)
    }
    const longest = Math.max(...finishDay.values())

    const cal = new WorkCalendar('2026-11-23', MON_SAT)
    const rows = templateRows('p', 1)
    const tasks = rows.map((r) => task(r.id, r.duration, r.after_ids, { milestone: r.milestone }))
    const result = computeSchedule(tasks, cal, '2026-11-01')
    expect(result.ok).toBe(true)
    expect(result.finish).toBe(cal.dateOf(longest - 1))
    const signOff = rows.find((r) => r.template_key === 'g8')!.id
    expect(result.criticalPath[result.criticalPath.length - 1]).toBe(signOff)
  })
})

describe('risks shown on Today', async () => {
  const { projectRisk, gateFlag } = await import('./useSchedule')
  const settings = { project_id: 'p', start_date: '2026-11-23', work_days: MON_SAT, holidays: [], baseline_at: '2026-11-20T00:00:00Z', baseline_by: null }
  const drawing = (code: string) => ({
    id: 'd1', project_id: 'p', number: 'SE-EL-01', title: 'Electrical', discipline: 'Electrical', archived: false,
    drawing_revisions: [{ id: 'r', code, rank: code.startsWith('R') ? 1000 : Number(code.slice(1)), revised_on: '2026-11-20', note: '', file_link: null, created_at: '', drawing_issues: [] }],
  })

  it('flags a sheet gate a week out, and not once the sheet is at R0', () => {
    const t = task('A', 3, [], { gate_drawing_id: 'd1' })
    expect(gateFlag(t, '2026-11-26', [drawing('P2')], '2026-11-23')).toContain('P2')
    expect(gateFlag(t, '2026-12-10', [drawing('P2')], '2026-11-23')).toBeNull() // more than 7 days away
    expect(gateFlag(t, '2026-11-26', [drawing('R0')], '2026-11-23')).toBeNull()
  })

  it('flags a milestone more than 7 working days past baseline, not one at 4', () => {
    const late = [task('A', 12), task('M', 0, ['A'], { baseline_end: '2026-11-25' })]
    expect(projectRisk(settings, late, [], '2026-11-01')?.lateMilestone).toEqual({ name: 'M', slip: 9 })
    const close = [task('A', 7), task('M', 0, ['A'], { baseline_end: '2026-11-25' })]
    expect(projectRisk(settings, close, [], '2026-11-01')).toBeNull()
  })
})
