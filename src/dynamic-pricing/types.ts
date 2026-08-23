import type { ModelCost } from "../types.ts"

/**
 * 24h time window in minutes-of-day [start, end). end <= start means the
 * window crosses midnight (end belongs to the next day).
 * `days`: applicable weekdays (ISO, 1=Monday … 7=Sunday). Omitted or empty = every day.
 */
export type TimeWindow = {
  start: number
  end: number
  days?: number[]
}

/**
 * One schedule level (e.g. peak / offpeak) with its time windows.
 *
 * Contract: a level with empty `windows` is the catch-all fallback — always
 * last-resort, never part of first-match (even when written first); it applies
 * whenever no windowed level matches. At most one per schedule (normalizeSchedule
 * moves it last and dedupes).
 */
export type ScheduleLevel = {
  level: string
  windows: TimeWindow[]
}

export type DynamicPricingSchedule = ScheduleLevel[]

/**
 * Per-model pricing rule.
 * - `levels`: absolute prices (level name → USD/1M four rates), wins over multipliers.
 * - `multipliers`: factors relative to the `state.provider` static price (e.g. offpeak 0.5).
 * - `contextThreshold`: overrides the global context-tier threshold (tokens).
 */
export type ModelPricingRule = {
  /**
   * Absolute prices (level name → USD/1M four rates), wins over multipliers.
   * `currency` is the original currency of `levels` (default USD); non-USD is
   * converted to internal USD at config load via `cost.rate` (CNY ÷ rate).
   */
  levels?: Record<string, ModelCost>
  multipliers?: Record<string, number>
  contextThreshold?: number
  /** Currency of `levels` absolute prices: USD (default) | CNY | EUR | GBP | JPY. */
  currency?: string
  /** Exchange rate USD → levels currency (for non-USD levels, e.g. 6.77 for CNY);
   * when omitted, inferred from cost.rate only if currency === display currency,
   * otherwise warn and treat as USD. */
  rate?: number
}

export type DynamicPricingConfig = {
  /** Master switch. Default true (applies the built-in time-of-day rule only to DeepSeek models and reads the context_over_200k tier). */
  enabled: boolean
  /** IANA timezone, e.g. "Asia/Shanghai". Empty → system timezone. */
  timezone: string
  schedule: DynamicPricingSchedule
  /** Global context-tier threshold (tokens), default 200_000. */
  contextThreshold: number
  providers: Record<string, { models: Record<string, ModelPricingRule> }>
}

export const DEFAULT_SCHEDULE: DynamicPricingSchedule = [
  // DeepSeek official peak hours: Beijing time Mon-Fri 9:00-12:00 / 14:00-18:00 (weekends off-peak).
  { level: "peak", windows: [
    { start: 9 * 60, end: 12 * 60, days: [1, 2, 3, 4, 5] },
    { start: 14 * 60, end: 18 * 60, days: [1, 2, 3, 4, 5] },
  ] },
  // Fallback (empty windows): everything else (weekends, weekday lunch 12-14 and nights) is off-peak.
  { level: "offpeak", windows: [] },
]

export const DEFAULT_DYNAMIC_PRICING: DynamicPricingConfig = {
  enabled: true,
  timezone: "Asia/Shanghai",
  schedule: DEFAULT_SCHEDULE,
  contextThreshold: 200_000,
  providers: {},
}
