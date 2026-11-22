/** Two-person verification of AI output. The same rule runs in the server function. */

export type Decision = 'confirm' | 'reject'
export type ReviewLite = { reviewer_id: string; decision: Decision; role: string }
export type AiStatus = 'pending' | 'done' | 'failed'
export type AiState = 'pending' | 'failed' | 'unverified' | 'verified' | 'rejected'

/** Roles that can give the senior confirmation. The owner stands in for the coordinator. */
export const SENIOR_ROLES = ['coordinator', 'owner']

export function reviewState(status: AiStatus, reviews: ReviewLite[]): AiState {
  if (status === 'pending') return 'pending'
  if (status === 'failed') return 'failed'
  if (reviews.some((r) => r.decision === 'reject')) return 'rejected'
  const confirms = reviews.filter((r) => r.decision === 'confirm')
  const people = new Set(confirms.map((r) => r.reviewer_id))
  const senior = confirms.some((r) => SENIOR_ROLES.includes(r.role))
  return people.size >= 2 && senior ? 'verified' : 'unverified'
}

/** What is still missing before a log counts as verified. */
export function stillNeeded(reviews: ReviewLite[]): string {
  const confirms = reviews.filter((r) => r.decision === 'confirm')
  const people = new Set(confirms.map((r) => r.reviewer_id)).size
  const senior = confirms.some((r) => SENIOR_ROLES.includes(r.role))
  if (people === 0) return 'Needs the coordinator and one team member'
  if (!senior) return 'Needs the coordinator'
  if (people < 2) return 'Needs one team member'
  return ''
}

/** Monday of the week containing the given date, as YYYY-MM-DD, on the phone's calendar. */
export function weekStart(date = new Date()): string {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const shift = (d.getDay() + 6) % 7
  d.setDate(d.getDate() - shift)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  const date = new Date(y, m - 1, d + days)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** True from Friday 5 pm until the end of Sunday, when this week's report is due. */
export function reportDue(now = new Date()): boolean {
  const day = now.getDay()
  return day === 6 || day === 0 || (day === 5 && now.getHours() >= 17)
}
