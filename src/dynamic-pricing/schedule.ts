import type { DynamicPricingSchedule, TimeWindow } from "./types.ts"

/** "09:00" → 540；"18:30" → 1110。非法输入返回 null。 */
export function parseClockTime(raw: string): number | null {
  const m = raw.match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

/** ISO 星期（1=周一…7=周日）的前一日，回绕（周一的前一日是周日）。 */
function prevWeekday(weekday: number): number {
  return ((weekday - 2 + 7) % 7) + 1
}

/** 窗口是否每天适用（`days` 省略或空数组）。 */
function isEveryDayWindow(w: TimeWindow): boolean {
  return !w.days || w.days.length === 0
}

export function inWindow(dayMinute: number, weekday: number, w: TimeWindow): boolean {
  const anyDay = isEveryDayWindow(w)
  if (w.start <= w.end) {
    // 非跨天：仅当日；days 作用于「当日」。
    if (!anyDay && !w.days.includes(weekday)) return false
    return dayMinute >= w.start && dayMinute < w.end
  }
  // 跨天窗口锚定「开启日」：晚间段 [start, 24:00) 归属 weekday；
  // 早晨段 [00:00, end) 由前一日开启（weekday 的前一日，回绕）。
  if (dayMinute >= w.start) return anyDay || w.days.includes(weekday)
  const prev = prevWeekday(weekday)
  return dayMinute < w.end && (anyDay || w.days.includes(prev))
}

export type TzParts = {
  year: number
  month: number // 1-12
  day: number
  hour: number // 0-23（"24:xx" 已归一化）
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

/** 取某时刻在指定时区的日历字段（hour "24" 归一化为次日 0 点）。 */
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

/** 指定时区下"当天 00:00:00"的 epoch 毫秒（真实时区零点，非 UTC 零点）。 */
export function startOfDayEpoch(ts: number, timezone: string): number {
  const p = tzPartsOf(ts, timezone)
  const elapsedMs = p.hour * 3_600_000 + p.minute * 60_000 + p.second * 1000
  return Math.floor(ts / 1000) * 1000 - elapsedMs
}

/** 指定时区下该时刻的"当天分钟数"（0..1439.99）。 */
export function dayMinuteOf(ts: number, timezone: string): number {
  const p = tzPartsOf(ts, timezone)
  return p.hour * 60 + p.minute + p.second / 60
}

/** 指定时区下该时刻的 ISO 星期（1=周一 … 7=周日）。 */
export function tzWeekdayOf(ts: number, timezone: string): number {
  const p = tzPartsOf(ts, timezone)
  // Date.getUTCDay()：0=周日…6=周六 → ISO 1=周一…7=周日。
  const dow = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()
  return ((dow + 6) % 7) + 1
}

/**
 * 判定 now 命中的时段档名（按 schedule 顺序，首个匹配的窗口级）。
 * 回退档契约见 types.ts ScheduleLevel：last-resort，不参与 first-match。
 * schedule 为空或窗口级与回退档均未命中 → undefined。
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
 * 距下一个时段窗口边界的毫秒数（任一 level 任一 window 的 start/end）。
 * 星期感知：自 now 所在日向前扫描最多 7 天，只收集「该日承载」的边界
 * （同天窗口的 start/end 落在开启日；跨天窗口的 start 落在开启日、end 落在次日），
 * 因此周五 18:00 的下一边界会跳过周末直达周一 09:00。
 * 无任何窗口级时返回 24h。
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

/** 边界分钟 m 是否由 weekday 当日承载（见 nextBoundaryMs 注释）。 */
function boundaryCarriedByDay(m: number, weekday: number, w: TimeWindow): boolean {
  if (w.start <= w.end) {
    // 同天窗口：开启日当天承载 start 与 end 两个边界。
    return isEveryDayWindow(w) || w.days.includes(weekday)
  }
  // 跨天窗口：start 由开启日承载；end 落在次日，由「开启日的次日」承载。
  const anyDay = isEveryDayWindow(w)
  if (m === w.start) return anyDay || w.days.includes(weekday)
  return anyDay || w.days.includes(prevWeekday(weekday))
}
