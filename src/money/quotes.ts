/** Quote comparison: quotes grouped by trade, the lowest live quote marked, each compared with the estimate for that trade. */
import type { BoqItem, Quote } from '../domain'
import { lineAmount } from '../estimate'
import { num, round2 } from '../format'

export const NO_TRADE = 'No trade'

export type ComparedQuote = { quote: Quote; /** amount − trade budget; null when no estimate lines carry this trade */ diff: number | null; lowest: boolean }
export type TradeComparison = { trade: string; budget: number; lines: number; quotes: ComparedQuote[]; lowestId: string | null }

const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase()

/** Estimate budget of a trade: the sum of live, non-optional lines whose trade matches (before contingency and GST). */
export function tradeBudget(items: BoqItem[], trade: string | null): { budget: number; lines: number } {
  const hits = items.filter((i) => !i.removed_at && !i.optional && norm(i.trade) === norm(trade) && norm(trade) !== '')
  return { budget: round2(hits.reduce((s, i) => s + lineAmount(i), 0)), lines: hits.length }
}

export function compareQuotes(quotes: Quote[], items: BoqItem[]): TradeComparison[] {
  const groups = new Map<string, Quote[]>()
  for (const q of quotes) {
    if (q.removed_at) continue
    const key = q.trade?.trim() || NO_TRADE
    const k = [...groups.keys()].find((g) => norm(g) === norm(key)) ?? key
    groups.set(k, [...(groups.get(k) ?? []), q])
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === NO_TRADE ? 1 : b === NO_TRADE ? -1 : a.localeCompare(b)))
    .map(([trade, qs]) => {
      const { budget, lines } = trade === NO_TRADE ? { budget: 0, lines: 0 } : tradeBudget(items, trade)
      const sorted = [...qs].sort((a, b) => num(a.amount) - num(b.amount) || a.received_on.localeCompare(b.received_on))
      const lowest = sorted.find((q) => q.status !== 'rejected') ?? null
      return {
        trade,
        budget,
        lines,
        lowestId: lowest?.id ?? null,
        quotes: sorted.map((q) => ({ quote: q, diff: lines ? round2(num(q.amount) - budget) : null, lowest: q.id === lowest?.id })),
      }
    })
}
