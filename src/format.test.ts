import { describe, expect, it } from 'vitest'
import { amountInWords, areaSqft, inr, inrExact, inrShort, longDate, num, round2 } from './format'

describe('money formatting', () => {
  it('groups the Indian way', () => {
    expect(inr(1234567)).toBe('₹ 12,34,567')
    expect(inrExact(1234567.5)).toBe('₹ 12,34,567.50')
    expect(inrShort(450000)).toBe('₹ 4.5 L')
    expect(inrShort(12500000)).toBe('₹ 1.3 Cr')
    expect(inrShort(-85000)).toBe('−₹ 85 K')
  })

  it('rounds to paise without drift', () => {
    expect(round2(1.005)).toBe(1.01)
    expect(round2(0.1 + 0.2)).toBe(0.3)
  })

  it('writes amounts in words, Indian system', () => {
    expect(amountInWords(0)).toBe('Zero')
    expect(amountInWords(250000)).toBe('Two Lakh Fifty Thousand')
    expect(amountInWords(175500)).toBe('One Lakh Seventy Five Thousand Five Hundred')
    expect(amountInWords(12345678)).toBe('One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight')
    expect(amountInWords(101)).toBe('One Hundred One')
  })

  it('reads numbers, dates and areas safely', () => {
    expect(num('12.5')).toBe(12.5)
    expect(num('')).toBe(0)
    expect(num(undefined)).toBe(0)
    expect(longDate('2026-11-12')).toBe('12 Nov 2026')
    expect(Math.round(areaSqft(100, 'sq. m.'))).toBe(1076)
    expect(areaSqft(1500, 'sq. ft.')).toBe(1500)
  })
})

describe('negative amounts', () => {
  it('put the minus before the rupee sign', () => {
    expect(inr(-173700)).toBe('−₹ 1,73,700')
    expect(inrExact(-99.5)).toBe('−₹ 99.50')
    expect(inr(-0.4)).toBe('₹ 0')
  })
})
