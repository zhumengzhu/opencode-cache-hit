import { describe, test, expect } from "bun:test"
import {
  parseClockTime,
  inWindow,
  tzPartsOf,
  startOfDayEpoch,
  dayMinuteOf,
  tzWeekdayOf,
  isLevelAt,
  nextBoundaryMs,
} from "../src/dynamic-pricing/schedule.ts"
import { DEFAULT_SCHEDULE } from "../src/dynamic-pricing/types.ts"

const TZ = "Asia/Shanghai" // UTC+8，无 DST

/** 北京时间 y-m-d h:m → epoch ms。 */
function bjt(y: number, m: number, d: number, h: number, min = 0, s = 0): number {
  return Date.UTC(y, m - 1, d, h - 8, min, s)
}

describe("parseClockTime", () => {
  test("parses HH:MM", () => {
    expect(parseClockTime("09:00")).toBe(540)
    expect(parseClockTime("18:30")).toBe(1110)
    expect(parseClockTime("00:00")).toBe(0)
    expect(parseClockTime("23:59")).toBe(1439)
  })
  test("rejects invalid input", () => {
    expect(parseClockTime("9")).toBeNull()
    expect(parseClockTime("24:00")).toBeNull()
    expect(parseClockTime("09:60")).toBeNull()
    expect(parseClockTime("abc")).toBeNull()
  })
})

describe("inWindow", () => {
  test("same-day window is half-open", () => {
    const w = { start: 540, end: 720 } // 09:00-12:00
    expect(inWindow(540, 1, w)).toBe(true)
    expect(inWindow(719, 1, w)).toBe(true)
    expect(inWindow(720, 1, w)).toBe(false)
    expect(inWindow(539, 1, w)).toBe(false)
  })
  test("cross-day window covers wrap-around", () => {
    const w = { start: 1080, end: 540 } // 18:00 - 次日09:00
    expect(inWindow(1080, 1, w)).toBe(true)
    expect(inWindow(1439, 1, w)).toBe(true)
    expect(inWindow(0, 1, w)).toBe(true)
    expect(inWindow(539, 1, w)).toBe(true)
    expect(inWindow(540, 1, w)).toBe(false)
    expect(inWindow(1000, 1, w)).toBe(false)
  })
  test("days filter applies to the current day (same-day window)", () => {
    const w = { start: 540, end: 720, days: [1, 2, 3, 4, 5] } // 工作日 09:00-12:00
    expect(inWindow(600, 1, w)).toBe(true) // 周一
    expect(inWindow(600, 5, w)).toBe(true) // 周五
    expect(inWindow(600, 6, w)).toBe(false) // 周六
    expect(inWindow(600, 7, w)).toBe(false) // 周日
  })
  test("cross-day window anchors to open day (start-day rule)", () => {
    const w = { start: 1080, end: 540, days: [1, 2, 3, 4, 5] } // 工作日 18:00 - 次日09:00
    // 开启日晚间段：仅工作日命中
    expect(inWindow(1200, 1, w)).toBe(true) // 周一 20:00
    expect(inWindow(1200, 5, w)).toBe(true) // 周五 20:00
    expect(inWindow(1200, 6, w)).toBe(false) // 周六 20:00
    // 次日早晨段：归属开启日（前一日）
    expect(inWindow(180, 2, w)).toBe(true) // 周二 03:00（周一开启）
    expect(inWindow(180, 6, w)).toBe(true) // 周六 03:00（周五开启）
    expect(inWindow(180, 7, w)).toBe(false) // 周日 03:00（周六非开启日）
    expect(inWindow(180, 1, w)).toBe(false) // 周一 03:00（周日非开启日）
  })
})

describe("tzPartsOf / dayMinuteOf / tzWeekdayOf", () => {
  test("maps epoch to Beijing wall clock", () => {
    const ts = bjt(2026, 8, 10, 10, 30, 15)
    expect(tzPartsOf(ts, TZ)).toEqual({ year: 2026, month: 8, day: 10, hour: 10, minute: 30, second: 15 })
    expect(dayMinuteOf(ts, TZ)).toBe(10 * 60 + 30 + 15 / 60)
    expect(startOfDayEpoch(ts, TZ)).toBe(bjt(2026, 8, 10, 0))
  })
  test("ISO weekday 1=Monday … 7=Sunday (2026-08-10 is Monday)", () => {
    expect(tzWeekdayOf(bjt(2026, 8, 10, 12, 0), TZ)).toBe(1) // 周一
    expect(tzWeekdayOf(bjt(2026, 8, 11, 12, 0), TZ)).toBe(2) // 周二
    expect(tzWeekdayOf(bjt(2026, 8, 14, 12, 0), TZ)).toBe(5) // 周五
    expect(tzWeekdayOf(bjt(2026, 8, 15, 12, 0), TZ)).toBe(6) // 周六
    expect(tzWeekdayOf(bjt(2026, 8, 16, 12, 0), TZ)).toBe(7) // 周日
    expect(tzWeekdayOf(bjt(2026, 8, 17, 12, 0), TZ)).toBe(1) // 下周一
    // 跨时区：UTC 周一凌晨 = 北京时间周一早晨，星期一致
    expect(tzWeekdayOf(Date.UTC(2026, 7, 10, 0, 30), TZ)).toBe(1)
    // 北京 00:30 周一 = UTC 周日 16:30 → 按北京时间仍为周一
    expect(tzWeekdayOf(bjt(2026, 8, 10, 0, 30), "UTC")).toBe(7)
  })
})

describe("isLevelAt (DeepSeek schedule)", () => {
  test("peak windows on weekdays", () => {
    expect(isLevelAt(bjt(2026, 8, 10, 9, 0), DEFAULT_SCHEDULE, TZ)).toBe("peak") // 周一
    expect(isLevelAt(bjt(2026, 8, 10, 11, 59), DEFAULT_SCHEDULE, TZ)).toBe("peak")
    expect(isLevelAt(bjt(2026, 8, 10, 14, 0), DEFAULT_SCHEDULE, TZ)).toBe("peak")
    expect(isLevelAt(bjt(2026, 8, 10, 17, 59), DEFAULT_SCHEDULE, TZ)).toBe("peak")
    expect(isLevelAt(bjt(2026, 8, 14, 9, 0), DEFAULT_SCHEDULE, TZ)).toBe("peak") // 周五
  })
  test("offpeak boundaries on weekdays (fallback)", () => {
    expect(isLevelAt(bjt(2026, 8, 10, 12, 0), DEFAULT_SCHEDULE, TZ)).toBe("offpeak")
    expect(isLevelAt(bjt(2026, 8, 10, 13, 30), DEFAULT_SCHEDULE, TZ)).toBe("offpeak")
    expect(isLevelAt(bjt(2026, 8, 10, 18, 0), DEFAULT_SCHEDULE, TZ)).toBe("offpeak")
    expect(isLevelAt(bjt(2026, 8, 10, 23, 59), DEFAULT_SCHEDULE, TZ)).toBe("offpeak")
    expect(isLevelAt(bjt(2026, 8, 10, 0, 30), DEFAULT_SCHEDULE, TZ)).toBe("offpeak")
    expect(isLevelAt(bjt(2026, 8, 10, 8, 59), DEFAULT_SCHEDULE, TZ)).toBe("offpeak")
  })
  test("weekend peak hours → offpeak (DeepSeek weekend idle)", () => {
    // 周六 09:00/11:00/15:00/17:00 全部为空闲
    expect(isLevelAt(bjt(2026, 8, 15, 9, 0), DEFAULT_SCHEDULE, TZ)).toBe("offpeak")
    expect(isLevelAt(bjt(2026, 8, 15, 11, 0), DEFAULT_SCHEDULE, TZ)).toBe("offpeak")
    expect(isLevelAt(bjt(2026, 8, 15, 15, 0), DEFAULT_SCHEDULE, TZ)).toBe("offpeak")
    expect(isLevelAt(bjt(2026, 8, 15, 17, 0), DEFAULT_SCHEDULE, TZ)).toBe("offpeak")
    // 周日 09:00/17:00 同样空闲
    expect(isLevelAt(bjt(2026, 8, 16, 9, 0), DEFAULT_SCHEDULE, TZ)).toBe("offpeak")
    expect(isLevelAt(bjt(2026, 8, 16, 17, 0), DEFAULT_SCHEDULE, TZ)).toBe("offpeak")
  })
  test("empty schedule returns undefined", () => {
    expect(isLevelAt(Date.now(), [], TZ)).toBeUndefined()
  })
  test("fallback level catches unmatched moments; no fallback → undefined", () => {
    const onlyWindowed = [{ level: "peak", windows: [{ start: 9 * 60, end: 12 * 60 }] }]
    // 12:00 未命中窗口级，无回退档 → undefined
    expect(isLevelAt(bjt(2026, 8, 10, 12, 0), onlyWindowed, TZ)).toBeUndefined()
    expect(isLevelAt(bjt(2026, 8, 10, 10, 0), onlyWindowed, TZ)).toBe("peak")

    const withFallback = [
      { level: "peak", windows: [{ start: 9 * 60, end: 12 * 60 }] },
      { level: "offpeak", windows: [] },
    ]
    expect(isLevelAt(bjt(2026, 8, 10, 10, 0), withFallback, TZ)).toBe("peak")
    expect(isLevelAt(bjt(2026, 8, 10, 12, 0), withFallback, TZ)).toBe("offpeak")
    expect(isLevelAt(bjt(2026, 8, 10, 3, 0), withFallback, TZ)).toBe("offpeak")

    // 仅回退档：任何时刻都命中回退档
    const onlyFallback = [{ level: "offpeak", windows: [] }]
    expect(isLevelAt(bjt(2026, 8, 10, 10, 0), onlyFallback, TZ)).toBe("offpeak")
  })
  test("fallback is last-resort even when written first", () => {
    const sched = [
      { level: "offpeak", windows: [] },
      { level: "peak", windows: [{ start: 9 * 60, end: 12 * 60, days: [1, 2, 3, 4, 5] }] },
    ]
    // 周一 10:00 → peak 窗口级优先于回退档
    expect(isLevelAt(bjt(2026, 8, 10, 10, 0), sched, TZ)).toBe("peak")
    // 周一 13:00 → 回退档
    expect(isLevelAt(bjt(2026, 8, 10, 13, 0), sched, TZ)).toBe("offpeak")
  })
  test("cross-day window start-day rule via isLevelAt", () => {
    const sched = [{ level: "night", windows: [{ start: 18 * 60, end: 9 * 60, days: [1, 2, 3, 4, 5] }] }]
    expect(isLevelAt(bjt(2026, 8, 14, 20, 0), sched, TZ)).toBe("night") // 周五晚
    expect(isLevelAt(bjt(2026, 8, 15, 3, 0), sched, TZ)).toBe("night") // 周六凌晨（周五开启）
    expect(isLevelAt(bjt(2026, 8, 15, 20, 0), sched, TZ)).toBeUndefined() // 周六晚
    expect(isLevelAt(bjt(2026, 8, 16, 3, 0), sched, TZ)).toBeUndefined() // 周日凌晨
    expect(isLevelAt(bjt(2026, 8, 17, 7, 0), sched, TZ)).toBeUndefined() // 周一凌晨（周日非开启日）
    expect(isLevelAt(bjt(2026, 8, 17, 20, 0), sched, TZ)).toBe("night") // 周一晚
  })
})

describe("nextBoundaryMs", () => {
  test("next boundary within the day", () => {
    // 10:00 → 12:00（2h）
    expect(nextBoundaryMs(bjt(2026, 8, 10, 10, 0), DEFAULT_SCHEDULE, TZ)).toBe(2 * 3_600_000)
    // 13:00 → 14:00（1h）
    expect(nextBoundaryMs(bjt(2026, 8, 10, 13, 0), DEFAULT_SCHEDULE, TZ)).toBe(3_600_000)
    // 08:00 → 09:00（1h）
    expect(nextBoundaryMs(bjt(2026, 8, 10, 8, 0), DEFAULT_SCHEDULE, TZ)).toBe(3_600_000)
  })
  test("rolls to tomorrow after 18:00", () => {
    // 18:30 → 次日 09:00（14.5h）
    expect(nextBoundaryMs(bjt(2026, 8, 10, 18, 30), DEFAULT_SCHEDULE, TZ)).toBe(14.5 * 3_600_000)
    // 23:59 → 次日 09:00
    expect(nextBoundaryMs(bjt(2026, 8, 10, 23, 59), DEFAULT_SCHEDULE, TZ)).toBe(9 * 3_600_000 + 60_000)
  })
  test("weekend: skips to Monday 09:00", () => {
    // 周五 18:00 → 周一 09:00（63h，跳过周末）
    expect(nextBoundaryMs(bjt(2026, 8, 14, 18, 0), DEFAULT_SCHEDULE, TZ)).toBe(63 * 3_600_000)
    // 周六 10:00 → 周一 09:00（47h）
    expect(nextBoundaryMs(bjt(2026, 8, 15, 10, 0), DEFAULT_SCHEDULE, TZ)).toBe(47 * 3_600_000)
    // 周日 23:00 → 周一 09:00（10h）
    expect(nextBoundaryMs(bjt(2026, 8, 16, 23, 0), DEFAULT_SCHEDULE, TZ)).toBe(10 * 3_600_000)
  })
  test("fallback-only schedule has no boundaries → 24h", () => {
    expect(nextBoundaryMs(Date.now(), [{ level: "offpeak", windows: [] }], TZ)).toBe(24 * 3_600_000)
  })
  test("empty schedule falls back to 24h", () => {
    expect(nextBoundaryMs(Date.now(), [], TZ)).toBe(24 * 3_600_000)
  })
})
