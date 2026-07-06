import { describe, expect, test } from "bun:test"
import { formatSparkline, collectSpeedValues, collectTpotValues } from "../src/sparkline.ts"

describe("formatSparkline", () => {
  test("empty array returns empty string", () => {
    expect(formatSparkline([])).toBe("")
  })

  test("single value returns middle block", () => {
    expect(formatSparkline([42])).toBe("▄")
  })

  test("identical values return middle block", () => {
    expect(formatSparkline([10, 10, 10])).toBe("▄▄▄")
  })

  test("ascending values produce ascending blocks", () => {
    const result = formatSparkline([1, 2, 3, 4, 5, 6, 7, 8])
    expect(result.length).toBe(7)
    expect(result).toContain("▁")
    expect(result).toContain("█")
  })

  test("descending values produce descending blocks", () => {
    const result = formatSparkline([8, 7, 6, 5, 4, 3, 2, 1])
    expect(result.length).toBe(7)
  })

  test("respects width parameter", () => {
    const result = formatSparkline([1, 2, 3, 4, 5], 3)
    expect(result.length).toBe(3)
  })

  test("takes last N values when exceeding width", () => {
    const result = formatSparkline([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3)
    expect(result.length).toBe(3)
  })
})

describe("collectSpeedValues", () => {
  test("empty records returns empty array", () => {
    expect(collectSpeedValues([])).toEqual([])
  })

  test("skips records without durationMs", () => {
    expect(collectSpeedValues([{ output: 100 }])).toEqual([])
  })

  test("skips records without output", () => {
    expect(collectSpeedValues([{ durationMs: 1000 }])).toEqual([])
  })

  test("collects records with short duration when tokens >= 2", () => {
    expect(collectSpeedValues([{ durationMs: 400, output: 100 }])).toEqual([250])
  })

  test("computes speed for valid records", () => {
    const result = collectSpeedValues([{ durationMs: 1000, output: 100 }])
    expect(result).toEqual([100])
  })

  test("filters out zero speed", () => {
    expect(collectSpeedValues([{ durationMs: 1000, output: 0 }])).toEqual([])
  })

  test("respects maxPoints parameter", () => {
    const records = [
      { durationMs: 1000, output: 100 },
      { durationMs: 1000, output: 200 },
      { durationMs: 1000, output: 300 },
    ]
    expect(collectSpeedValues(records, 2)).toEqual([200, 300])
  })
})

describe("collectTpotValues", () => {
  test("empty records returns empty array", () => {
    expect(collectTpotValues([])).toEqual([])
  })

  test("skips records without durationMs", () => {
    expect(collectTpotValues([{ output: 100 }])).toEqual([])
  })

  test("skips records with tokens <= 1", () => {
    expect(collectTpotValues([{ durationMs: 1000, output: 1 }])).toEqual([])
    expect(collectTpotValues([{ durationMs: 1000, output: 0, reasoning: 1 }])).toEqual([])
    expect(collectTpotValues([{ durationMs: 1000, output: 0 }])).toEqual([])
  })

  test("skips records with durationMs < 500", () => {
    expect(collectTpotValues([{ durationMs: 400, output: 100 }])).toEqual([])
  })

  test("computes TPOT for valid records", () => {
    // 100 tokens, 1000ms → 1000 / (100 - 1) = 10.101...
    const result = collectTpotValues([{ durationMs: 1000, output: 100 }])
    expect(result).toHaveLength(1)
    expect(result[0]).toBeCloseTo(10.101, 2)
  })

  test("includes reasoning tokens", () => {
    // 150 tokens (100+50), 1000ms → 1000 / 149 = 6.711...
    const result = collectTpotValues([{ durationMs: 1000, output: 100, reasoning: 50 }])
    expect(result).toHaveLength(1)
    expect(result[0]).toBeCloseTo(6.711, 2)
  })

  test("respects maxPoints parameter", () => {
    const records = [
      { durationMs: 1000, output: 100 },
      { durationMs: 1000, output: 200 },
      { durationMs: 1000, output: 300 },
    ]
    expect(collectTpotValues(records, 2)).toHaveLength(2)
  })
})
