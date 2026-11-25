/** Money and number formatting shared by every module (Indian grouping, rupees). */

export function num(v: unknown): number {
  const x = typeof v === 'number' ? v : parseFloat(String(v ?? ''))
  return Number.isFinite(x) ? x : 0
}

/** Round to paise, avoiding binary drift (e.g. 1.005 → 1.01). */
export function round2(v: number): number {
  return Math.round((v + Number.EPSILON) * 100) / 100
}

/** ₹ 1,23,456 (no paise). */
export function inr(v: number): string {
  const r = Math.round(v)
  return (r < 0 ? '−₹ ' : '₹ ') + Math.abs(r).toLocaleString('en-IN')
}

/** ₹ 1,23,456.50 (with paise), for invoices and bills. */
export function inrExact(v: number): string {
  const r = round2(v)
  return (r < 0 ? '−₹ ' : '₹ ') + Math.abs(r).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** Short form for tiles and charts: ₹ 4.5 L, ₹ 1.2 Cr, ₹ 85 K. */
export function inrShort(v: number): string {
  const a = Math.abs(v)
  const sign = v < 0 ? '−' : ''
  if (a >= 1e7) return `${sign}₹ ${trim(a / 1e7)} Cr`
  if (a >= 1e5) return `${sign}₹ ${trim(a / 1e5)} L`
  if (a >= 1e3) return `${sign}₹ ${trim(a / 1e3)} K`
  return `${sign}₹ ${Math.round(a)}`
}

function trim(x: number): string {
  return (Math.round(x * 10) / 10).toString()
}

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen']
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']

function two(x: number): string {
  return x < 20 ? ONES[x] : TENS[Math.floor(x / 10)] + (x % 10 ? ' ' + ONES[x % 10] : '')
}
function three(x: number): string {
  return (x > 99 ? ONES[Math.floor(x / 100)] + ' Hundred' + (x % 100 ? ' ' : '') : '') + (x % 100 ? two(x % 100) : '')
}

/** Whole rupees in words, Indian system: "Two Lakh Fifty Thousand". Crores above 99 repeat ("One Hundred Crore"). */
export function amountInWords(v: number): string {
  let n = Math.round(Math.abs(v))
  if (!n) return 'Zero'
  const parts: string[] = []
  const crore = Math.floor(n / 1e7)
  n %= 1e7
  const lakh = Math.floor(n / 1e5)
  n %= 1e5
  const thousand = Math.floor(n / 1e3)
  n %= 1e3
  if (crore) parts.push((crore > 999 ? amountInWords(crore) : three(crore)) + ' Crore')
  if (lakh) parts.push(two(lakh) + ' Lakh')
  if (thousand) parts.push(two(thousand) + ' Thousand')
  if (n) parts.push(three(n))
  return parts.join(' ')
}

/** "12 Nov 2026" from YYYY-MM-DD. */
export function longDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
}

/** Square feet from an area and its unit. */
export function areaSqft(area: number | null | undefined, unit: string | null | undefined): number {
  const a = num(area)
  return unit === 'sq. m.' ? a * 10.7639 : a
}
