import { describe, expect, it } from 'vitest'
import { BACKUP_TABLES, backupFileName, referencedFiles } from './backup'

describe('backup', () => {
  it('lists every stored file a record points to, once', () => {
    const files = referencedFiles({
      site_logs: [{ audio_path: 'p/l1/voice.webm' }, { audio_path: null }],
      site_log_photos: [{ path: 'p/l1/a.jpg' }, { path: 'p/l1/a.jpg' }, { path: 'p/l2/b.jpg' }],
      drawing_issues: [{ print_photo_path: 'drawings/d/x.jpg' }, { print_photo_path: null }],
      studio_settings: [{ logo_path: 'branding/logo.png' }],
      project_decks: [{ key_plan_path: 'decks/p/kp.jpg', slides: [{ slots: { a: 'decks/p/1.jpg', b: 'decks/p/kp.jpg' } }] }],
    })
    expect(files).toEqual(['branding/logo.png', 'decks/p/1.jpg', 'decks/p/kp.jpg', 'drawings/d/x.jpg', 'p/l1/a.jpg', 'p/l1/voice.webm', 'p/l2/b.jpg'])
  })

  it('covers every table in the database, parents first', () => {
    const names = BACKUP_TABLES.map((t) => t.name)
    for (const t of ['profiles', 'projects', 'site_logs', 'site_log_photos', 'site_log_ai', 'site_log_reviews', 'drawings', 'drawing_revisions', 'drawing_issues', 'weekly_reports', 'project_schedules', 'tasks', 'schedule_changes', 'backup_log', 'vendors', 'project_briefs', 'quotes', 'work_orders', 'boq_items', 'ra_bills', 'ra_bill_lines', 'decisions', 'variations', 'procurement_items', 'site_visits', 'project_decks', 'studio_settings', 'project_fees', 'fee_proposals', 'fee_invoices', 'studio_costs', 'studio_private']) {
      expect(names).toContain(t)
    }
    expect(names.indexOf('projects')).toBeLessThan(names.indexOf('site_logs'))
    expect(names.indexOf('drawings')).toBeLessThan(names.indexOf('tasks'))
    expect(names.indexOf('work_orders')).toBeLessThan(names.indexOf('boq_items'))
    expect(names.indexOf('boq_items')).toBeLessThan(names.indexOf('ra_bill_lines'))
    expect(names.indexOf('decisions')).toBeLessThan(names.indexOf('variations'))
    expect(new Set(names).size).toBe(names.length)
  })

  it('names the file by date and time', () => {
    expect(backupFileName(new Date(2026, 10, 23, 9, 5))).toBe('studio-elements-backup-2026-11-23-0905.zip')
  })
})
