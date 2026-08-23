import { describe, expect, test } from "bun:test"
import { aggregateLineages } from "../src/lineage-stats.ts"
import { messageLineageKey, UNKNOWN_LINEAGE_KEY } from "../src/stats.ts"

describe("messageLineageKey", () => {
  test("uses provider and model ids", () => {
    expect(messageLineageKey({ role: "assistant", providerID: "openai", modelID: "gpt-5.6-sol" })).toBe(
      "openai:gpt-5.6-sol",
    )
  })

  test("keeps missing metadata in the unknown bucket", () => {
    expect(messageLineageKey({ role: "assistant", providerID: "openai" })).toBe(UNKNOWN_LINEAGE_KEY)
    expect(messageLineageKey({ role: "assistant", modelID: "gpt-5.6-sol" })).toBe(UNKNOWN_LINEAGE_KEY)
  })
})

describe("aggregateLineages", () => {
  test("separates mixed models and sums weighted cache ratios", () => {
    const buckets = aggregateLineages([
      {
        role: "assistant",
        id: "luna-1",
        providerID: "openai",
        modelID: "gpt-5.6-luna",
        time: { created: 300, completed: 400 },
        agent: "build",
        tokens: { input: 50, output: 4, cache: { read: 50, write: 2 } },
        cost: 0.2,
      },
      {
        role: "assistant",
        id: "sol-1",
        providerID: "openai",
        modelID: "gpt-5.6-sol",
        time: { created: 100, completed: 200 },
        agent: "plan",
        tokens: { input: 100, output: 8, cache: { read: 0 } },
        cost: 0.1,
      },
      {
        role: "assistant",
        id: "luna-2",
        providerID: "openai",
        modelID: "gpt-5.6-luna",
        time: { created: 500, completed: 600 },
        agent: "build",
        tokens: { input: 10, output: 2, cache: { read: 90 } },
        cost: 0.3,
      },
    ])
    expect(buckets).toHaveLength(2)
    const luna = buckets.find((bucket) => bucket.modelID === "gpt-5.6-luna")!
    expect(luna.callCount).toBe(2)
    expect(luna.input).toBe(60)
    expect(luna.cacheRead).toBe(140)
    expect(luna.cacheRatio).toBeCloseTo(140 / 200, 8)
    expect(luna.lastCall?.id).toBe("luna-2")
    expect(luna.agentCounts.build).toBe(2)
  })

  test("excludes summaries and compaction calls", () => {
    const buckets = aggregateLineages([
      { role: "assistant", summary: true, providerID: "openai", modelID: "gpt", tokens: { input: 100 } },
      { role: "assistant", agent: "compaction", providerID: "openai", modelID: "gpt", tokens: { input: 100 } },
      { role: "assistant", providerID: "openai", modelID: "gpt", tokens: { input: 10, cache: { read: 90 } } },
    ])
    expect(buckets).toHaveLength(1)
    expect(buckets[0].callCount).toBe(1)
    expect(buckets[0].input).toBe(10)
  })

  test("does not attribute missing metadata to the last known model", () => {
    const buckets = aggregateLineages([
      { role: "assistant", providerID: "openai", modelID: "gpt-sol", tokens: { input: 10 } },
      { role: "assistant", providerID: "openai", tokens: { input: 20 } },
      { role: "assistant", modelID: "gpt-sol", tokens: { input: 30 } },
    ])
    expect(buckets).toHaveLength(2)
    expect(buckets.find((bucket) => bucket.key === UNKNOWN_LINEAGE_KEY)?.input).toBe(50)
    expect(buckets.find((bucket) => bucket.modelID === "gpt-sol")?.input).toBe(10)
  })

  test("orders last call by completed time, then created time and id", () => {
    const buckets = aggregateLineages([
      { role: "assistant", id: "b", providerID: "p", modelID: "m", time: { created: 20, completed: 30 } },
      { role: "assistant", id: "a", providerID: "p", modelID: "m", time: { created: 10, completed: 30 } },
    ])
    expect(buckets[0].lastCall?.id).toBe("b")
  })
})
