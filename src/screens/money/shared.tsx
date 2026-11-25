import type { ReactNode } from 'react'
import { inr, longDate } from '../../format'
import type { MoneyState } from '../../money/useMoney'

export type SectionProps = {
  projectId: string
  m: MoneyState
  owner: boolean
  /** Writes need a connection: false when the phone's copy is shown. */
  writable: boolean
}

export function errText(err: { message: string; code?: string } | null | undefined, what: string): string {
  if (!navigator.onLine) return `No signal. ${what} needs a connection.`
  return err?.message ?? `Could not save. ${what} failed.`
}

/** Parses a typed number; empty text gives null. */
export function parseNum(s: string): number | null {
  const t = s.replace(/,/g, '').trim()
  if (!t) return null
  const x = Number(t)
  return Number.isFinite(x) ? x : null
}

export function Err({ text }: { text: string | null }) {
  return text ? (
    <p className="error" role="alert">
      {text}
    </p>
  ) : null
}

/** A label-and-figure line in a totals card. */
export function Figure({ label, value, strong, children }: { label: ReactNode; value: ReactNode; strong?: boolean; children?: ReactNode }) {
  return (
    <div className={strong ? 'm-fig strong' : 'm-fig'}>
      <span className="m-fig-label">
        {label}
        {children}
      </span>
      <span className="m-fig-value">{value}</span>
    </div>
  )
}

/** Steps shown as a row of dots with labels and stamped dates; the current one is highlighted. */
export function Stepper({ steps, current, labels, dates }: { steps: readonly string[]; current: string; labels: Record<string, string>; dates?: Record<string, string | null> }) {
  const at = steps.indexOf(current)
  return (
    <ol className="m-steps" aria-label="Status">
      {steps.map((s, i) => (
        <li key={s} className={i < at ? 'done' : i === at ? 'now' : ''} aria-current={i === at ? 'step' : undefined}>
          <i aria-hidden="true" />
          <span>{labels[s]}</span>
          {dates?.[s] ? <small>{longDate(dates[s])}</small> : null}
        </li>
      ))}
    </ol>
  )
}

/** Rupees that never break between the sign and the figure, for amounts inside running text. */
export const inrN = (v: number) => inr(v).replace(/ /g, '\u00a0')
