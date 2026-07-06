import { describe, expect, test } from "bun:test"
import {
  computeTokenSpeed,
  computeAvgTokenSpeed,
  formatTokenSpeed,
  estimateStreamingSpeed,
  computeTokenTpotMs,
  computeAvgTokenTpotMs,
  formatTokenTpot,
} from "../src/token-speed.ts"
import {
  advanceStreamingNow,
  formatStreamingNowDisplay,
  initialStreamingTickState,
  STREAMING_HOLD_MS,
} from "../src/streaming-state.ts"

describe("computeTokenSpeed", () => {
  test("returns 0 when tokens < 2", () => {
    expect(computeTokenSpeed(1, 0, 1000)).toBe(0)
    expect(computeTokenSpeed(0, 1, 1000)).toBe(0)
    expect(computeTokenSpeed(0, 0, 1000)).toBe(0)
  })

  test("computes speed for duration >= 500ms", () => {
    expect(computeTokenSpeed(100, 50, 500)).toBe(300)
  })

  test("computes speed for valid duration", () => {
    expect(computeTokenSpeed(100, 0, 1000)).toBe(100)
  })

  test("includes reasoning tokens", () => {
    expect(computeTokenSpeed(100, 50, 1000)).toBe(150)
  })

  test("handles zero tokens", () => {
    expect(computeTokenSpeed(0, 0, 1000)).toBe(0)
  })
})

describe("computeAvgTokenSpeed", () => {
  test("returns 0 for empty messages", () => {
    expect(computeAvgTokenSpeed([])).toBe(0)
  })

  test("skips messages without time.completed", () => {
    const msgs = [{ tokens: { output: 100 }, time: { created: 0 } }]
    expect(computeAvgTokenSpeed(msgs)).toBe(0)
  })

  test("skips summary messages", () => {
    const msgs = [
      {
        summary: true,
        tokens: { output: 100 },
        time: { created: 0, completed: 1000 },
      },
    ]
    expect(computeAvgTokenSpeed(msgs)).toBe(0)
  })

  test("includes messages with short duration if tokens >= 2", () => {
    const msgs = [
      {
        tokens: { output: 100 },
        time: { created: 0, completed: 400 },
      },
    ]
    expect(computeAvgTokenSpeed(msgs)).toBe(250)
  })

  test("skips messages with zero tokens", () => {
    const msgs = [
      {
        tokens: { output: 0, reasoning: 0 },
        time: { created: 0, completed: 1000 },
      },
    ]
    expect(computeAvgTokenSpeed(msgs)).toBe(0)
  })

  test("computes average for valid messages", () => {
    const msgs = [
      {
        tokens: { output: 100, reasoning: 0 },
        time: { created: 0, completed: 1000 },
      },
      {
        tokens: { output: 200, reasoning: 0 },
        time: { created: 0, completed: 1000 },
      },
    ]
    expect(computeAvgTokenSpeed(msgs)).toBe(150)
  })

  test("includes reasoning tokens", () => {
    const msgs = [
      {
        tokens: { output: 100, reasoning: 50 },
        time: { created: 0, completed: 1000 },
      },
    ]
    expect(computeAvgTokenSpeed(msgs)).toBe(150)
  })

  test("excludes TTFT when firstPartTime map is provided", () => {
    const msgs = [
      {
        id: "m1",
        tokens: { output: 100, reasoning: 0 },
        time: { created: 0, completed: 4000 },
      },
    ]
    const withTtft = computeAvgTokenSpeed(msgs)
    const withoutTtft = computeAvgTokenSpeed(msgs, new Map([["m1", 3000]]))
    expect(withoutTtft).toBeGreaterThan(withTtft)
    expect(withoutTtft).toBe(100)
    expect(withTtft).toBe(25)
  })
})

describe("computeTokenTpotMs", () => {
  test("returns undefined for generationMs < 500", () => {
    expect(computeTokenTpotMs(100, 50, 400)).toBeUndefined()
  })

  test("returns undefined when tokens <= 1", () => {
    expect(computeTokenTpotMs(1, 0, 1000)).toBeUndefined()
    expect(computeTokenTpotMs(0, 1, 1000)).toBeUndefined()
    expect(computeTokenTpotMs(0, 0, 1000)).toBeUndefined()
  })

  test("computes TPOT for valid input", () => {
    expect(computeTokenTpotMs(100, 50, 1500)).toBeCloseTo(10.067, 2)
  })

  test("includes reasoning tokens in numerator", () => {
    expect(computeTokenTpotMs(100, 100, 1000)).toBeCloseTo(5.025, 2)
  })

  test("handles output only (no reasoning)", () => {
    expect(computeTokenTpotMs(100, 0, 1000)).toBeCloseTo(10.101, 2)
  })
})

describe("computeAvgTokenTpotMs", () => {
  test("returns undefined for empty messages", () => {
    expect(computeAvgTokenTpotMs([])).toBeUndefined()
  })

  test("skips messages without time.completed", () => {
    const msgs = [{ tokens: { output: 100 }, time: { created: 0 } }]
    expect(computeAvgTokenTpotMs(msgs)).toBeUndefined()
  })

  test("skips summary messages", () => {
    const msgs = [
      { summary: true, tokens: { output: 100 }, time: { created: 0, completed: 1000 } },
    ]
    expect(computeAvgTokenTpotMs(msgs)).toBeUndefined()
  })

  test("skips messages with duration < 500ms", () => {
    const msgs = [{ tokens: { output: 100 }, time: { created: 0, completed: 400 } }]
    expect(computeAvgTokenTpotMs(msgs)).toBeUndefined()
  })

  test("skips messages with tokens <= 1", () => {
    const msgs = [{ tokens: { output: 1, reasoning: 0 }, time: { created: 0, completed: 1000 } }]
    expect(computeAvgTokenTpotMs(msgs)).toBeUndefined()
  })

  test("computes weighted average for valid messages", () => {
    const msgs = [
      { tokens: { output: 100, reasoning: 0 }, time: { created: 0, completed: 1000 } },
      { tokens: { output: 200, reasoning: 0 }, time: { created: 0, completed: 1000 } },
    ]
    expect(computeAvgTokenTpotMs(msgs)).toBeCloseTo(6.711, 2)
  })

  test("includes reasoning tokens", () => {
    const msgs = [
      { tokens: { output: 100, reasoning: 50 }, time: { created: 0, completed: 1000 } },
    ]
    expect(computeAvgTokenTpotMs(msgs)).toBeCloseTo(6.711, 2)
  })

  test("excludes TTFT when firstPartTime map is provided", () => {
    const msgs = [
      { id: "m1", tokens: { output: 100, reasoning: 0 }, time: { created: 0, completed: 4000 } },
    ]
    const withoutTtft = computeAvgTokenTpotMs(msgs)
    const withTtft = computeAvgTokenTpotMs(msgs, new Map([["m1", 3000]]))
    expect(withoutTtft!).toBeGreaterThan(withTtft!)
    expect(withoutTtft).toBeCloseTo(40.404, 2)
    expect(withTtft).toBeCloseTo(10.101, 2)
  })
})

describe("formatTokenTpot", () => {
  test("formats undefined as em-dash", () => {
    expect(formatTokenTpot(undefined)).toBe("—")
  })

  test("formats < 1 as '<1 ms/tok'", () => {
    expect(formatTokenTpot(0.5)).toBe("<1 ms/tok")
  })

  test("formats zero as '<1 ms/tok'", () => {
    expect(formatTokenTpot(0)).toBe("<1 ms/tok")
  })

  test("formats normal value rounded", () => {
    expect(formatTokenTpot(48.7)).toBe("49 ms/tok")
  })

  test("formats >= 1000 as seconds", () => {
    expect(formatTokenTpot(1500)).toBe("1.5s/tok")
  })
})

describe("formatTokenSpeed", () => {
  test("formats speed < 1 as '<1 tok/s'", () => {
    expect(formatTokenSpeed(0.5)).toBe("<1 tok/s")
  })

  test("formats speed >= 1 rounded", () => {
    expect(formatTokenSpeed(42.7)).toBe("43 tok/s")
  })

  test("formats zero as '<1 tok/s'", () => {
    expect(formatTokenSpeed(0)).toBe("<1 tok/s")
  })
})

describe("estimateStreamingSpeed", () => {
  test("returns 0 for empty text", () => {
    expect(estimateStreamingSpeed("", 0, 1000)).toBe(0)
  })

  test("returns 0 for elapsed < 500ms", () => {
    expect(estimateStreamingSpeed("hello", 0, 400)).toBe(0)
  })

  test("estimates speed based on char count", () => {
    const result = estimateStreamingSpeed("abcdefgh", 0, 1000)
    expect(result).toBe(2)
  })

  test("uses Math.max(1, ...) for estimation", () => {
    const result = estimateStreamingSpeed("ab", 0, 1000)
    expect(result).toBe(1)
  })

  test("excludes TTFT when firstPartTime is after created", () => {
    const withTtft = estimateStreamingSpeed("abcdefgh", 0, 4000)
    const withoutTtft = estimateStreamingSpeed("abcdefgh", 0, 4000, 3000)
    expect(withoutTtft).toBeGreaterThan(withTtft)
    expect(withoutTtft).toBe(2)
    expect(withTtft).toBe(0.5)
  })

  test("ignores firstPartTime at or before created", () => {
    expect(estimateStreamingSpeed("abcdefgh", 1000, 2000, 1000)).toBe(2)
    expect(estimateStreamingSpeed("abcdefgh", 1000, 2000, 500)).toBe(2)
  })
})

describe("advanceStreamingNow", () => {
  const part = (id: string) => {
    if (id !== "m1") return undefined
    return [{ type: "text", text: "abcdefgh" }]
  }

  test("idle when no in-flight assistant message", () => {
    const r = advanceStreamingNow(initialStreamingTickState(), {
      messages: [{ role: "assistant", time: { created: 0, completed: 1000 } }],
      now: 5000,
    })
    expect(r.phase).toBe("idle")
    expect(r.speed).toBe(0)
  })

  test("warmup during in-flight before measurable speed", () => {
    const r = advanceStreamingNow(initialStreamingTickState(), {
      messages: [{ role: "assistant", id: "m1", time: { created: 9900 } }],
      part,
      now: 10000,
    })
    expect(r.phase).toBe("warmup")
    expect(r.wasInFlight).toBe(true)
  })

  test("active with positive speed while streaming", () => {
    const r = advanceStreamingNow(initialStreamingTickState(), {
      messages: [{ role: "assistant", id: "m1", time: { created: 0 } }],
      part,
      now: 1000,
    })
    expect(r.phase).toBe("active")
    expect(r.speed).toBe(2)
    expect(r.lastActiveSpeed).toBe(2)
  })

  test("uses firstPartTime map to exclude TTFT", () => {
    const ttftMs = 3000
    const firstPartTime = new Map([["m1", ttftMs]])
    const r = advanceStreamingNow(initialStreamingTickState(), {
      messages: [{ role: "assistant", id: "m1", time: { created: 0 } }],
      part,
      now: 4000,
      firstPartTime,
    })
    expect(r.phase).toBe("active")
    expect(r.speed).toBe(2)
  })

  test("holds last speed briefly after stream ends", () => {
    const active = advanceStreamingNow(initialStreamingTickState(), {
      messages: [{ role: "assistant", id: "m1", time: { created: 0 } }],
      part,
      now: 1000,
    })
    const hold = advanceStreamingNow(active, {
      messages: [{ role: "assistant", id: "m1", time: { created: 0, completed: 1000 } }],
      now: 1500,
    })
    expect(hold.phase).toBe("hold")
    expect(hold.speed).toBe(2)
    expect(hold.holdUntil).toBe(1500 + STREAMING_HOLD_MS)
  })

  test("returns idle after hold window expires", () => {
    const active = advanceStreamingNow(initialStreamingTickState(), {
      messages: [{ role: "assistant", id: "m1", time: { created: 0 } }],
      part,
      now: 1000,
    })
    const hold = advanceStreamingNow(active, {
      messages: [{ role: "assistant", id: "m1", time: { created: 0, completed: 1000 } }],
      now: 1500,
    })
    const idle = advanceStreamingNow(hold, {
      messages: [{ role: "assistant", id: "m1", time: { created: 0, completed: 1000 } }],
      now: 1500 + STREAMING_HOLD_MS + 1,
    })
    expect(idle.phase).toBe("idle")
  })
})

describe("formatStreamingNowDisplay", () => {
  test("idle shows stable dot label", () => {
    expect(formatStreamingNowDisplay("idle", 0, "·")).toEqual({ value: "·", tone: "idle" })
  })

  test("warmup shows em-dash with live tone", () => {
    expect(formatStreamingNowDisplay("warmup", 0, "·")).toEqual({ value: "—", tone: "live" })
  })

  test("active converts speed to ms/tok with ~ estimate prefix", () => {
    expect(formatStreamingNowDisplay("active", 20, "·")).toEqual({ value: "~50 ms/tok", tone: "live" })
  })

  test("hold converts speed to ms/tok with fading tone and ~ estimate prefix", () => {
    expect(formatStreamingNowDisplay("hold", 25, "·")).toEqual({ value: "~40 ms/tok", tone: "fading" })
  })

  test("active with zero speed shows em-dash", () => {
    expect(formatStreamingNowDisplay("active", 0, "·")).toEqual({ value: "—", tone: "live" })
  })

  test("active with useTps shows tok/s with ~ estimate prefix", () => {
    expect(formatStreamingNowDisplay("active", 20, "·", true)).toEqual({ value: "~20 tok/s", tone: "live" })
  })

  test("hold with useTps shows tok/s with fading tone", () => {
    expect(formatStreamingNowDisplay("hold", 10, "·", true)).toEqual({ value: "~10 tok/s", tone: "fading" })
  })

  test("warmup with useTps shows em-dash with live tone", () => {
    expect(formatStreamingNowDisplay("warmup", 0, "·", true)).toEqual({ value: "—", tone: "live" })
  })

  test("idle with useTps still shows idle label", () => {
    expect(formatStreamingNowDisplay("idle", 0, "·", true)).toEqual({ value: "·", tone: "idle" })
  })

  test("active with useTps and speed < 1 omits ~ prefix", () => {
    expect(formatStreamingNowDisplay("active", 0.3, "·", true)).toEqual({ value: "<1 tok/s", tone: "live" })
  })
})
