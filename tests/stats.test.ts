import { describe, test, expect } from "bun:test"
import {
  emptySessionSnapshot,
  aggregateFromSessionObject,
  aggregateSessionFromMessages,
  cacheHitRatio,
  subAgentHasStats,
  sidebarShouldShow,
  computePerCallHitTrend,
  perMessageHitPercent,
  toSubAgentSummary,
  aggregateSubAgents,
  withModelFallback,
} from "../src/stats.ts"
import type { SubAgentSummary } from "../src/types.ts"

describe("aggregateFromSessionObject", () => {
  test("empty session returns zero snapshot", () => {
    expect(aggregateFromSessionObject({})).toEqual(emptySessionSnapshot())
  })

  test("reads aggregate fields from session object", () => {
    const snap = aggregateFromSessionObject({
      model: { id: "anthropic/claude-sonnet-4-20250514", providerID: "anthropic" },
      cost: 0.123,
      tokens: {
        input: 1000,
        output: 500,
        reasoning: 100,
        cache: { read: 8000, write: 2000 },
      },
    })
    expect(snap.model).toBe("anthropic/claude-sonnet-4-20250514")
    expect(snap.providerID).toBe("anthropic")
    expect(snap.cost).toBe(0.123)
    expect(snap.input).toBe(1000)
    expect(snap.output).toBe(500)
    expect(snap.reasoning).toBe(100)
    expect(snap.cacheRead).toBe(8000)
    expect(snap.cacheWrite).toBe(2000)
  })

  test("handles missing tokens and model", () => {
    const snap = aggregateFromSessionObject({ cost: 0.05 })
    expect(snap.cost).toBe(0.05)
    expect(snap.model).toBe("")
    expect(snap.input).toBe(0)
    expect(snap.cacheRead).toBe(0)
  })
})

describe("aggregateSessionFromMessages", () => {
  test("empty input", () => {
    expect(aggregateSessionFromMessages([])).toEqual(emptySessionSnapshot())
  })

  test("accumulates assistant fields", () => {
    const snap = aggregateSessionFromMessages([
      {
        role: "assistant",
        modelID: "deepseek-v4-flash",
        cost: 0.005,
        tokens: { input: 100, output: 50, cache: { read: 500 } },
      },
    ])
    expect(snap.cost).toBe(0.005)
    expect(snap.cacheRead).toBe(500)
  })

  test("excludes summary and compaction messages from totals", () => {
    const snap = aggregateSessionFromMessages([
      { role: "assistant", summary: true, tokens: { input: 100, output: 10, cache: { read: 90 } }, cost: 1 },
      { role: "assistant", agent: "compaction", tokens: { input: 200, output: 20, cache: { read: 180 } }, cost: 2 },
      { role: "assistant", modelID: "gpt-5.6", tokens: { input: 10, output: 5, cache: { read: 90 } }, cost: 0.1 },
    ])
    expect(snap.input).toBe(10)
    expect(snap.output).toBe(5)
    expect(snap.cacheRead).toBe(90)
    expect(snap.cost).toBe(0.1)
  })
})

describe("cacheHitRatio", () => {
  test("computes ratio", () => {
    expect(cacheHitRatio(800, 200)).toBe(0.8)
  })
})

describe("sidebarShouldShow", () => {
  test("visible with subs only", () => {
    expect(
      sidebarShouldShow(emptySessionSnapshot(), [
        { id: "x", model: "", providerID: "", cost: 0, input: 5, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      ]),
    ).toBe(true)
  })

  test("visible when main has stats", () => {
    expect(
      sidebarShouldShow({ ...emptySessionSnapshot(), cacheRead: 100 }, []),
    ).toBe(true)
  })

  test("hidden when no main stats and no subs", () => {
    expect(sidebarShouldShow(emptySessionSnapshot(), [])).toBe(false)
  })
})

describe("perMessageHitPercent", () => {
  test("null for summary or empty denom", () => {
    expect(perMessageHitPercent({ role: "assistant", summary: true })).toBeNull()
    expect(perMessageHitPercent({ role: "assistant", tokens: { input: 0 } })).toBeNull()
    expect(perMessageHitPercent({ role: "assistant", agent: "compaction", tokens: { input: 10, cache: { read: 90 } } })).toBeNull()
  })

  test("matches ratio", () => {
    expect(
      perMessageHitPercent({
        role: "assistant",
        tokens: { input: 10, cache: { read: 90 } },
      }),
    ).toBeCloseTo(90, 5)
  })
})

describe("computePerCallHitTrend", () => {
  test("trend between last two assistant turns", () => {
    const r = computePerCallHitTrend([
      { role: "assistant", tokens: { input: 100, cache: { read: 0 } } },
      { role: "assistant", tokens: { input: 10, cache: { read: 90 } } },
    ])
    expect(r.hitPercent).toBeCloseTo(90, 5)
    expect(r.trendPercent).toBeCloseTo(90, 5)
    expect(r.hasTrend).toBe(true)
    expect(r.state).toBe("steady")
  })

  test("does not compare different model lineages", () => {
    const r = computePerCallHitTrend([
      { role: "assistant", providerID: "openai", modelID: "gpt-sol", tokens: { input: 100, cache: { read: 0 } } },
      { role: "assistant", providerID: "openai", modelID: "gpt-luna", tokens: { input: 10, cache: { read: 90 } } },
    ])
    expect(r.hitPercent).toBeCloseTo(90, 5)
    expect(r.trendPercent).toBe(0)
    expect(r.hasTrend).toBe(false)
    expect(r.state).toBe("switch")
  })

  test("shows a trend after two calls on the new lineage", () => {
    const r = computePerCallHitTrend([
      { role: "assistant", providerID: "openai", modelID: "gpt-sol", tokens: { input: 100, cache: { read: 0 } } },
      { role: "assistant", providerID: "openai", modelID: "gpt-luna", tokens: { input: 10, cache: { read: 90 } } },
      { role: "assistant", providerID: "openai", modelID: "gpt-luna", tokens: { input: 50, cache: { read: 50 } } },
    ])
    expect(r.trendPercent).toBeCloseTo(-40, 5)
    expect(r.hasTrend).toBe(true)
    expect(r.state).toBe("steady")
  })
})

describe("aggregateSubAgents", () => {
  test("sums child sessions", () => {
    const total = aggregateSubAgents([
      { id: "a", model: "", providerID: "", cost: 1, input: 10, output: 2, reasoning: 0, cacheRead: 100, cacheWrite: 5 },
      { id: "b", model: "", providerID: "", cost: 2, input: 20, output: 3, reasoning: 1, cacheRead: 200, cacheWrite: 0 },
    ])
    expect(total.input).toBe(30)
    expect(total.cacheRead).toBe(300)
    expect(total.cacheWrite).toBe(5)
    expect(total.cost).toBe(3)
  })
})

describe("toSubAgentSummary", () => {
  test("maps snapshot fields", () => {
    const s = toSubAgentSummary("cid", {
      ...emptySessionSnapshot(),
      input: 1,
      cacheWrite: 2,
    })
    expect(s.id).toBe("cid")
    expect(s.cacheWrite).toBe(2)
    expect(s.speed).toBeUndefined()
  })

  test("includes speed when provided", () => {
    const s = toSubAgentSummary("cid", { ...emptySessionSnapshot(), input: 1 }, 42)
    expect(s.speed).toBe(42)
  })

  test("speed defaults to undefined when not provided", () => {
    const s = toSubAgentSummary("cid", emptySessionSnapshot())
    expect(s.speed).toBeUndefined()
  })
})

describe("subAgentHasStats", () => {
  test("detects activity", () => {
    expect(subAgentHasStats({ ...emptySessionSnapshot(), cacheRead: 1 })).toBe(true)
    expect(subAgentHasStats({ ...emptySessionSnapshot(), output: 10 })).toBe(true)
    expect(subAgentHasStats(emptySessionSnapshot())).toBe(false)
  })
})

describe("withModelFallback", () => {
  test("returns unchanged when model and providerID are present", () => {
    const snap = { ...emptySessionSnapshot(), model: "claude", providerID: "anthropic", cost: 1 }
    const result = withModelFallback(snap, [])
    expect(result.model).toBe("claude")
    expect(result.providerID).toBe("anthropic")
    expect(result.cost).toBe(1)
  })

  test("fills model from last assistant message without mutating input", () => {
    const snap = { ...emptySessionSnapshot(), cost: 5, cacheRead: 100 }
    const msgs: Parameters<typeof withModelFallback>[1] = [
      { role: "assistant", modelID: "gpt-5", providerID: "openai" },
      { role: "assistant", modelID: "claude", providerID: "anthropic" },
    ]
    const result = withModelFallback(snap, msgs)
    expect(result).not.toBe(snap)
    expect(result.model).toBe("claude")
    expect(result.providerID).toBe("anthropic")
    expect(result.cost).toBe(5)
    expect(result.cacheRead).toBe(100)
    expect(snap.model).toBe("")
    expect(snap.providerID).toBe("")
  })

  test("skips non-assistant messages", () => {
    const snap = { ...emptySessionSnapshot(), cost: 1 }
    const msgs: Parameters<typeof withModelFallback>[1] = [
      { role: "user" },
      { role: "assistant", modelID: "deepseek" },
    ]
    const result = withModelFallback(snap, msgs)
    expect(result.model).toBe("deepseek")
  })

  test("does nothing when messages have no model", () => {
    const snap = { ...emptySessionSnapshot(), cost: 1 }
    const result = withModelFallback(snap, [])
    expect(result.model).toBe("")
    expect(result.providerID).toBe("")
  })
})
