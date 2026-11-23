import { describe, expect, it } from 'vitest'
import { buildDrafts, projectState, teamLoad } from './portfolio'
import type { Drawing } from './drawings'
import type { ScheduleSettings, Task } from './schedule'
import type { Project } from './types'

const project: Project = { id: 'p', name: 'Sparsh Ekaya', code: 'SE', stage: 3, rooms: [], trades: [], archived: false }
const settings: ScheduleSettings = { project_id: 'p', start_date: '2026-11-23', work_days: [1, 2, 3, 4, 5, 6], holidays: [], baseline_at: null, baseline_by: null }

function task(id: string, duration: number, after: string[] = [], extra: Partial<Task> = {}): Task {
  return {
    id, project_id: 'p', stage: 6, name: id, trade: null, room: null, owner_name: null, duration, milestone: duration === 0,
    after_ids: after, status: 'planned', actual_start: null, actual_end: null, gate_drawing_id: null,
    baseline_start: null, baseline_end: null, sort_order: 0, removed_at: null, ...extra,
  }
}

function drawing(heldCode: string, currentCode: string): Drawing {
  const rank = (c: string) => (c.startsWith('R') ? 1000 + Number(c.slice(1)) : Number(c.slice(1)))
  const rev = (c: string, issued: boolean) => ({
    id: c, code: c, rank: rank(c), revised_on: '2026-11-20', note: '', file_link: null, created_at: `2026-11-2${rank(c) % 10}T00:00:00Z`,
    drawing_issues: issued ? [{ id: `i${c}`, issued_to: 'Site', method: 'Print on site', issued_on: '2026-11-20', print_photo_path: null, created_at: '2026-11-20T00:00:00Z' }] : [],
  })
  return { id: 'd1', project_id: 'p', number: 'SE-FL-01', title: 'Furniture layout', discipline: 'Furniture layout', archived: false,
    drawing_revisions: heldCode === currentCode ? [rev(currentCode, true)] : [rev(heldCode, true), rev(currentCode, false)] }
}

describe('project status', () => {
  it('is on track with nothing wrong, and counts progress by working days done', () => {
    // A (4 days) done, B (6 days) planned: 4 of 10 working days = 40%.
    const tasks = [task('A', 4, [], { status: 'done', actual_start: '2026-11-23', actual_end: '2026-11-26' }), task('B', 6, ['A'])]
    const s = projectState(project, settings, tasks, [], '2026-11-27')
    expect(s.health).toBe('ok')
    expect(s.progress).toBe(40)
    expect(s.plan).toBeNull() // no baseline
    expect(s.finish).toBe('2026-12-03') // B: Fri 27 Nov to Thu 3 Dec, 6 working days, Sunday skipped
    expect(s.daysLeft).toBe(6)
  })

  it('measures plan from the baseline', () => {
    const tasks = [
      task('A', 4, [], { status: 'done', actual_start: '2026-11-23', actual_end: '2026-11-26', baseline_end: '2026-11-26' }),
      task('B', 6, ['A'], { baseline_end: '2026-12-03' }),
    ]
    const s = projectState(project, settings, tasks, [], '2026-12-04')
    expect(s.plan).toBe(100) // both baseline ends are before 4 Dec
    expect(s.progress).toBe(40)
  })

  it('is at risk with an overdue task and delayed with a milestone more than 7 working days late', () => {
    const overdue = [task('A', 2, [], { status: 'in_progress', actual_start: '2026-11-23' })]
    const r = projectState(project, settings, overdue, [], '2026-11-28')
    expect(r.health).toBe('risk')
    expect(r.reasons).toContain('1 task overdue')

    const late = [task('A', 12), task('M', 0, ['A'], { baseline_end: '2026-11-25' })]
    const d = projectState(project, settings, late, [], '2026-11-01')
    expect(d.health).toBe('late')
    expect(d.reasons[0]).toBe('M forecast 9 working days late')
  })

  it('counts an outdated print on site as a risk', () => {
    const s = projectState(project, settings, [task('A', 3)], [drawing('P1', 'P2')], '2026-11-01')
    expect(s.health).toBe('risk')
    expect(s.sitePrints).toHaveLength(1)
  })

  it('has no status without a schedule', () => {
    expect(projectState(project, undefined, [], [], '2026-11-23').health).toBe('none')
  })
})

describe('drafts', () => {
  it('drafts a client note for a late milestone and a site note for an old print, never auto-sent', () => {
    const late = [task('A', 12), task('M', 0, ['A'], { name: 'Design freeze signed', baseline_end: '2026-11-25' })]
    const s = projectState(project, settings, late, [drawing('P1', 'R0')], '2026-11-01')
    const drafts = buildDrafts([s], '2026-11-01')
    const client = drafts.find((d) => d.kind === 'client')!
    expect(client.body).toContain('Design freeze signed')
    expect(client.body).toContain('9 working days later')
    const site = drafts.find((d) => d.kind === 'site')!
    expect(site.body).toContain('use only R0')
    expect(new Set(drafts.map((d) => d.key)).size).toBe(drafts.length)
  })

  it('gives a new key when the situation changes, so a dismissed draft can come back', () => {
    const a = buildDrafts([projectState(project, settings, [task('A', 3)], [drawing('P1', 'P2')], '2026-11-01')], '2026-11-01')
    const b = buildDrafts([projectState(project, settings, [task('A', 3)], [drawing('P1', 'P3')], '2026-11-01')], '2026-11-01')
    expect(a[0].key).not.toBe(b[0].key)
  })
})

describe('team workload', () => {
  it('groups open tasks by owner, overdue first, and leaves out work more than four weeks away', () => {
    const tasks = [
      task('A', 2, [], { owner_name: 'Bhavin', status: 'in_progress', actual_start: '2026-11-23' }),
      task('B', 3, [], { owner_name: 'Bhavin' }),
      task('C', 40, [], { owner_name: 'Malav' }),
      task('D', 2, ['C'], { owner_name: 'Malav' }), // starts in January
      task('E', 1),
    ]
    const load = teamLoad([projectState(project, settings, tasks, [], '2026-11-28')], '2026-11-28')
    expect(load.map((l) => l.owner)).toEqual(['Bhavin', 'Malav', 'Unassigned'])
    expect(load[0].overdue).toBe(1)
    expect(load[0].open[0].task.id).toBe('A')
    expect(load[1].open.map((o) => o.task.id)).toEqual(['C'])
  })
})
