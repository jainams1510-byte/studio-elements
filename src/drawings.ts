/** Drawing register: types and the rules for revisions and site prints. */

export const DISCIPLINES = [
  'Furniture layout',
  'Electrical',
  'Ceiling (RCP)',
  'HVAC',
  'Plumbing',
  'Joinery',
  'Tiling and flooring',
  'Elevations',
  'Civil',
  'Other',
] as const

export const ISSUE_METHODS = ['WhatsApp', 'Print on site', 'Drive link', 'Email', 'By hand'] as const

export type Issue = {
  id: string
  issued_to: string
  method: string
  issued_on: string
  print_photo_path: string | null
  created_at: string
}

export type Revision = {
  id: string
  code: string
  rank: number
  revised_on: string
  note: string
  file_link: string | null
  created_at: string
  drawing_issues: Issue[]
}

export type Drawing = {
  id: string
  project_id: string
  number: string
  title: string
  discipline: string
  archived: boolean
  drawing_revisions: Revision[]
}

export const DRAWING_SELECT =
  'id, project_id, number, title, discipline, archived, ' +
  'drawing_revisions(id, code, rank, revised_on, note, file_link, created_at, ' +
  'drawing_issues(id, issued_to, method, issued_on, print_photo_path, created_at))'

/** P1, P2 ... before approval; R0, R1 ... for construction. Same rule as the database. */
export const CODE_PATTERN = /^(P[1-9]\d{0,2}|R\d{1,3})$/

export function normaliseCode(code: string): string {
  return code.trim().toUpperCase()
}

export function isValidCode(code: string): boolean {
  return CODE_PATTERN.test(normaliseCode(code))
}

/** Order of revisions: every R comes after every P. Matches the database's rank column. */
export function rankOf(code: string): number {
  const c = normaliseCode(code)
  if (!isValidCode(c)) return -1
  const n = Number(c.slice(1))
  return c.startsWith('P') ? n : 1000 + n
}

export function isConstruction(code: string): boolean {
  return normaliseCode(code).startsWith('R')
}

/** Newest first. */
export function sortRevisions(revisions: Revision[]): Revision[] {
  return [...revisions].sort((a, b) => b.rank - a.rank)
}

export function currentRevision(drawing: Drawing): Revision | null {
  return sortRevisions(drawing.drawing_revisions)[0] ?? null
}

/** The codes to offer for the next revision: the next in sequence, and R0 while still preliminary. */
export function nextCodes(current: string | null): { next: string; construction: string | null } {
  if (!current) return { next: 'P1', construction: 'R0' }
  const c = normaliseCode(current)
  const n = Number(c.slice(1))
  if (c.startsWith('P')) return { next: `P${n + 1}`, construction: 'R0' }
  return { next: `R${n + 1}`, construction: null }
}

export function isSite(issuedTo: string): boolean {
  return issuedTo.trim().toLowerCase() === 'site'
}

export type SiteStatus =
  | { kind: 'none' }
  | { kind: 'current'; held: string }
  | { kind: 'outdated'; held: string; current: string }
  | { kind: 'preliminary'; held: string }

/** Which revision the site holds, judged by the latest issue to "Site". */
export function siteStatus(drawing: Drawing): SiteStatus {
  const current = currentRevision(drawing)
  let latest: { rev: Revision; issue: Issue } | null = null
  for (const rev of drawing.drawing_revisions) {
    for (const issue of rev.drawing_issues) {
      if (!isSite(issue.issued_to)) continue
      const key = `${issue.issued_on}|${issue.created_at}`
      if (!latest || key > `${latest.issue.issued_on}|${latest.issue.created_at}`) latest = { rev, issue }
    }
  }
  if (!latest || !current) return { kind: 'none' }
  if (latest.rev.rank < current.rank) return { kind: 'outdated', held: latest.rev.code, current: current.code }
  if (!isConstruction(latest.rev.code)) return { kind: 'preliminary', held: latest.rev.code }
  return { kind: 'current', held: latest.rev.code }
}

export function siteStatusText(status: SiteStatus): string {
  switch (status.kind) {
    case 'none':
      return 'Not issued to site'
    case 'current':
      return `Site has ${status.held}`
    case 'outdated':
      return `Site holds ${status.held}, current is ${status.current}. Replace the print.`
    case 'preliminary':
      return `Site holds ${status.held}, which is not for construction`
  }
}

export function needsAttention(status: SiteStatus): boolean {
  return status.kind === 'outdated' || status.kind === 'preliminary'
}

/** Today's date as YYYY-MM-DD on the phone's own calendar. */
export function todayLocal(now = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}
