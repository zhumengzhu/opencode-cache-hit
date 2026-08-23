import type { DynamicPricingSchedule, TimeWindow } from "./types.ts"

/** "09:00" → 540; "18:30" → 1110. Invalid input returns null. */
export function parseClockTime(raw: string): number | null {
  const m = raw.match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

/** Previous ISO weekday (1=Monday…7=Sunday), wrapping (Monday's previous day is Sunday). */
function prevWeekday(weekday: number): number {
  return ((weekday - 2 + 7) % 7) + 1
}

/** Whether the window applies every day (`days` omitted or empty). */
function isEveryDayWindow(w: TimeWindow): boolean {
  return !w.days || w.days.length === 0
}

export function inWindow(dayMinute: number, weekday: number, w: TimeWindow): boolean {
  const anyDay = isEveryDayWindow(w)
  if (w.start <= w.end) {
    // Same-day window: current day only; days filters the current day.
    if (!anyDay && !w.days.includes(weekday)) return false
    return dayMinute >= w.start && dayMinute < w.end
  }
  // Cross-midnight windows anchor to their open day: the evening part [start, 24:00)
  // belongs to weekday; the morning part [00:00, end) is opened by the previous day.
  if (dayMinute >= w.start) return anyDay || w.days.includes(weekday)
  const prev = prevWeekday(weekday)
  return dayMinute < w.end && (anyDay || w.days.includes(prev))
}

export type TzParts = {
  year: number
  month: number // 1-12
  day: number
  hour: number // 0-23 ("24:xx" normalized)
  minute: number
  second: number
}

const tzFormatterCache = new Map<string, Intl.DateTimeFormat>()

function tzFormatter(timezone: string): Intl.DateTimeFormat {
  let f = tzFormatterCache.get(timezone)
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
    tzFormatterCache.set(timezone, f)
  }
  return f
}

/** Calendar fields of a timestamp in the given timezone (hour "24" normalized to next-day 00:00). */
export function tzPartsOf(ts: number, timezone: string): TzParts {
  const parts = Object.fromEntries(
    tzFormatter(timezone).formatToParts(new Date(ts)).map((p) => [p.type, p.value]),
  )
  let year = Number(parts.year)
  let month = Number(parts.month)
  let day = Number(parts.day)
  let hour = Number(parts.hour)
  const minute = Number(parts.minute)
  const second = Number(parts.second)
  if (hour === 24) {
    hour = 0
    const d = new Date(Date.UTC(year, month - 1, day + 1))
    year = d.getUTCFullYear()
    month = d.getUTCMonth() + 1
    day = d.getUTCDate()
  }
  return { year, month, day, hour, minute, second }
}

/** Epoch ms of "today 00:00:00" in the given timezone (real zone midnight, not UTC midnight). */
export function startOfDayEpoch(ts: number, timezone: string): number {
  const p = tzPartsOf(ts, timezone)
  const elapsedMs = p.hour * 3_600_000 + p.minute * 60_000 + p.second * 1000
  return Math.floor(ts / 1000) * 1000 - elapsedMs
}

/** Minutes-of-day of a timestamp in the given timezone (0..1439.99). */
export function dayMinuteOf(ts: number, timezone: string): number {
  const p = tzPartsOf(ts, timezone)
  return p.hour * 60 + p.minute + p.second / 60
}

/** ISO weekday of a timestamp in the given timezone (1=Monday … 7=Sunday). */
export function tzWeekdayOf(ts: number, timezone: string): number {
  const p = tzPartsOf(ts, timezone)
  // Date.getUTCDay(): 0=Sunday…6=Saturday → ISO 1=Monday…7=Sunday.
  const dow = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()
  return ((dow + 6) % 7) + 1
}

/**
 * Level name matching `now` (first matching windowed level, in schedule order).
 * Fallback contract: see types.ts ScheduleLevel — last-resort, not first-match.
 * Empty schedule, or no windowed level / fallback match → undefined.
 */
export function isLevelAt(
  now: number,
  schedule: DynamicPricingSchedule,
  timezone: string,
): string | undefined {
  if (schedule.length === 0) return undefined
  const min = dayMinuteOf(now, timezone)
  const weekday = tzWeekdayOf(now, timezone)
  let fallback: string | undefined
  for (const lvl of schedule) {
    if (lvl.windows.length === 0) {
      fallback = lvl.level
      continue
    }
    for (const w of lvl.windows) {
      if (inWindow(min, weekday, w)) return lvl.level
    }
  }
  return fallback
}

/**
 * Milliseconds to the next schedule boundary (any level, any window start/end).
 * Weekday-aware: scan up to 7 days forward from today, collecting only the
 * boundaries carried by each day (same-day windows carry start/end on their open
 * day; cross-midnight windows carry start on the open day and end on the next),
 * so the next boundary after Friday 18:00 skips the weekend to Monday 09:00.
 * No windowed level → 24h.
 */
export function nextBoundaryMs(
  now: number,
  schedule: DynamicPricingSchedule,
  timezone: string,
): number {
  let best = Number.POSITIVE_INFINITY
  const t0 = startOfDayEpoch(now, timezone)
  for (let d = 0; d <= 7; d++) {
    const dayStart = t0 + d * 86_400_000
    const wd = tzWeekdayOf(dayStart, timezone)
    for (const lvl of schedule) {
      for (const w of lvl.windows) {
        for (const m of [w.start, w.end]) {
          const b = dayStart + m * 60_000
          if (b > now && boundaryCarriedByDay(m, wd, w)) {
            best = Math.min(best, b - now)
          }
        }
      }
    }
  }
  return Number.isFinite(best) ? best : 86_400_000
}

/** Whether boundary minute m is carried by that weekday's day (see nextBoundaryMs). */
function boundaryCarriedByDay(m: number, weekday: number, w: TimeWindow): boolean {
  if (w.start <= w.end) {
    // Same-day window: the open day carries both start and end boundaries.
    return isEveryDayWindow(w) || w.days.includes(weekday)
  }
  // Cross-midnight window: start is carried by the open day; end falls on the
  // next day, carried by the day after the open day.
  const anyDay = isEveryDayWindow(w)
  if (m === w.start) return anyDay || w.days.includes(weekday)
  return anyDay || w.days.includes(prevWeekday(weekday))
}
