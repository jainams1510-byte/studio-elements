/** CSV text that Excel and Google Sheets open correctly (UTF-8 with a byte-order mark, CRLF lines). */
export type Cell = string | number | boolean | null | undefined

const NUMBER_LIKE = /^-?\d+(\.\d+)?$/

/** One cell: quoted when needed, quotes doubled, and text that a spreadsheet would run as a formula made plain with a leading '. */
export function csvCell(v: Cell): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : ''
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  let s = v
  if (/^[=+\-@\t\r]/.test(s) && !NUMBER_LIKE.test(s)) s = `'${s}`
  return /[",\r\n]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s
}

export function toCsv(rows: Cell[][]): string {
  return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'
}
