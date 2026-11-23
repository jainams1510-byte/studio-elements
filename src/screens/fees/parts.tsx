import type { ReactNode } from 'react'
import type { StudioSettings } from '../../domain'

/** Shown to anyone who is not an owner (the database returns nothing to them anyway). */
export function OwnerOnly({ what }: { what: string }) {
  return <p className="notice fees-owner-only">{what} visible to owners only.</p>
}

/** A number box that keeps an empty value empty (null), with a 16 px font so phones do not zoom. */
export function NumField({
  label, value, onChange, placeholder, step = 'any', suffix, disabled,
}: {
  label: string
  value: number | null | undefined
  onChange: (v: number | null) => void
  placeholder?: string
  step?: string
  suffix?: ReactNode
  disabled?: boolean
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type="number"
        inputMode="decimal"
        step={step}
        value={value ?? ''}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
      />
      {suffix}
    </label>
  )
}

export function Tile({ value, label, tone }: { value: string; label: string; tone?: 'danger' | 'ok' }) {
  return (
    <div className={`tile-k fees-tile${tone ? ` ${tone}` : ''}`}>
      <b>{value}</b>
      <span>{label}</span>
    </div>
  )
}

export const DEFAULT_SETTINGS: StudioSettings = {
  id: 1,
  name: 'Studio Elements',
  tagline: 'Architecture · Interior Design · Project Management',
  website: 'www.studioelements.in',
  email: 'info@studioelements.in',
  phone: '+91 8511357002',
  gstin: '',
  logo_path: null,
  clauses: {},
}

export function errorText(err: { message: string } | null | undefined, fallback = 'Could not save.'): string | null {
  if (!err) return null
  if (!navigator.onLine) return 'No signal. Changes need a connection.'
  return err.message || fallback
}
