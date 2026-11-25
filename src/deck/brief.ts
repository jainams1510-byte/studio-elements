/** Project brief rules: the date-order checks from Project Studio's review, shown inline on the brief. */

export type BriefDates = {
  issue_date: string | null
  agreement_date: string | null
  start_date: string | null
  end_date: string | null
}

export type DateWarning = { level: 'bad' | 'warn'; text: string }

const has = (v: string | null | undefined): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)

/** Dates are ISO strings (YYYY-MM-DD), so plain comparison orders them. Each pair is checked when both are filled. */
export function briefDateWarnings(d: BriefDates): DateWarning[] {
  const out: DateWarning[] = []
  if (has(d.start_date) && has(d.agreement_date) && d.start_date < d.agreement_date)
    out.push({ level: 'warn', text: 'Start date is before the agreement date. Confirm this is intended.' })
  if (has(d.agreement_date) && has(d.issue_date) && d.agreement_date < d.issue_date)
    out.push({ level: 'warn', text: 'Agreement date is before the proposal issue date. Confirm this is intended.' })
  if (has(d.start_date) && has(d.end_date) && d.end_date <= d.start_date)
    out.push({ level: 'bad', text: 'Completion date is not after the start date.' })
  return out
}

/** A number typed into the brief: empty means "not given" (null); anything else must be a finite number. */
export function parseNum(text: string): number | null | 'bad' {
  const t = text.trim().replace(/,/g, '')
  if (t === '') return null
  const x = Number(t)
  return Number.isFinite(x) ? x : 'bad'
}

/** Check the brief's numbers against the database limits; returns the first problem, in words. */
export function briefNumberProblem(v: {
  area: number | null | 'bad'
  duration_months: number | null | 'bad'
  client_budget: number | null | 'bad'
  estimate_gst_rate: number | null | 'bad'
  contingency_pct: number | null | 'bad'
}): string | null {
  if (v.area === 'bad' || (v.area != null && v.area < 0)) return 'Project area must be a number, 0 or more.'
  if (v.duration_months === 'bad' || (v.duration_months != null && v.duration_months < 0)) return 'Duration must be a number of months, 0 or more.'
  if (v.client_budget === 'bad' || (v.client_budget != null && v.client_budget < 0)) return 'Client budget must be an amount in rupees, 0 or more.'
  if (v.estimate_gst_rate === 'bad' || v.estimate_gst_rate == null || v.estimate_gst_rate < 0 || v.estimate_gst_rate > 28)
    return 'Estimate GST must be between 0 and 28 %.'
  if (v.contingency_pct === 'bad' || v.contingency_pct == null || v.contingency_pct < 0 || v.contingency_pct > 50)
    return 'Contingency must be between 0 and 50 %.'
  return null
}
