import { describe, test, expect } from "bun:test"
import {
  lookupModelCost,
  computePricing,
  computeSubsSaved,
  computeSessionPricing,
  EMPTY_PRICING,
} from "../src/pricing.ts"
import type { ProviderInfo, SubAgentSummary } from "../src/types.ts"

const MOCK_PROVIDERS: ProviderInfo[] = [
  {
    id: "anthropic",
    models: {
      "claude-sonnet-4-20250514": {
        cost: { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
      },
    },
  },
  {
    id: "openai",
    models: {
      "gpt-4o": {
        cost: { input: 5, output: 15, cache: { read: 2.5, write: 5 } },
      },
    },
  },
]

describe("lookupModelCost", () => {
  test("finds matching provider + model", () => {
    const cost = lookupModelCost(MOCK_PROVIDERS, "anthropic", "claude-sonnet-4-20250514")
    expect(cost).not.toBeNull()
    expect(cost!.input).toBe(3)
    expect(cost!.cache.read).toBe(0.3)
  })

  test("returns null for unknown provider", () => {
    expect(lookupModelCost(MOCK_PROVIDERS, "unknown", "claude-sonnet-4-20250514")).toBeNull()
  })

  test("returns null for unknown model", () => {
    expect(lookupModelCost(MOCK_PROVIDERS, "anthropic", "nonexistent")).toBeNull()
  })

  test("returns null when providerID is undefined", () => {
    expect(lookupModelCost(MOCK_PROVIDERS, undefined, "claude-sonnet-4-20250514")).toBeNull()
  })

  test("returns null when modelID is undefined", () => {
    expect(lookupModelCost(MOCK_PROVIDERS, "anthropic", undefined)).toBeNull()
  })

  test("returns null for empty providers array", () => {
    expect(lookupModelCost([], "anthropic", "claude-sonnet-4-20250514")).toBeNull()
  })
})

describe("computePricing", () => {
  test("computes rates and saved correctly", () => {
    const result = computePricing(MOCK_PROVIDERS, "anthropic", "claude-sonnet-4-20250514", 1_000_000)
    expect(result.inputRate).toBe(3)
    expect(result.outputRate).toBe(15)
    expect(result.cacheReadRate).toBe(0.3)
    expect(result.cacheWriteRate).toBe(3.75)
    // saved = (3 - 0.3) * 1_000_000 / 1_000_000 = 2.7
    expect(result.saved).toBeCloseTo(2.7, 10)
  })

  test("returns EMPTY_PRICING when provider not found", () => {
    expect(computePricing(MOCK_PROVIDERS, "missing", "x", 500_000)).toEqual(EMPTY_PRICING)
  })

  test("returns EMPTY_PRICING when providers is empty", () => {
    expect(computePricing([], "anthropic", "claude-sonnet-4-20250514", 100)).toEqual(EMPTY_PRICING)
  })

  test("saved is 0 when cacheReadRate >= inputRate", () => {
    const providers: ProviderInfo[] = [
      {
        id: "weird",
        models: {
          "model-x": {
            cost: { input: 1, output: 5, cache: { read: 2, write: 1 } },
          },
        },
      },
    ]
    const result = computePricing(providers, "weird", "model-x", 500_000)
    expect(result.saved).toBe(0)
    expect(result.inputRate).toBe(1)
    expect(result.cacheReadRate).toBe(2)
  })

  test("saved scales with cacheRead count", () => {
    const half = computePricing(MOCK_PROVIDERS, "anthropic", "claude-sonnet-4-20250514", 500_000)
    const full = computePricing(MOCK_PROVIDERS, "anthropic", "claude-sonnet-4-20250514", 1_000_000)
    expect(full.saved).toBeCloseTo(half.saved * 2, 10)
  })

  test("saved is 0 when cacheRead is 0", () => {
    const result = computePricing(MOCK_PROVIDERS, "anthropic", "claude-sonnet-4-20250514", 0)
    expect(result.saved).toBe(0)
  })
})

describe("computeSubsSaved", () => {
  test("sums saved across multiple sub-agents", () => {
    const subs: SubAgentSummary[] = [
      { id: "a", model: "claude-sonnet-4-20250514", providerID: "anthropic", cost: 0.1, input: 100, output: 50, reasoning: 0, cacheRead: 1_000_000, cacheWrite: 0 },
      { id: "b", model: "gpt-4o", providerID: "openai", cost: 0.2, input: 200, output: 100, reasoning: 0, cacheRead: 1_000_000, cacheWrite: 0 },
    ]
    const result = computeSubsSaved(subs, MOCK_PROVIDERS)
    // a: (3 - 0.3) * 1M / 1M = 2.7
    // b: (5 - 2.5) * 1M / 1M = 2.5
    expect(result).toBeCloseTo(5.2, 10)
  })

  test("returns 0 for empty subs", () => {
    expect(computeSubsSaved([], MOCK_PROVIDERS)).toBe(0)
  })

  test("returns 0 when providers is empty", () => {
    const subs: SubAgentSummary[] = [
      { id: "a", model: "claude-sonnet-4-20250514", providerID: "anthropic", cost: 0.1, input: 100, output: 50, reasoning: 0, cacheRead: 1_000_000, cacheWrite: 0 },
    ]
    expect(computeSubsSaved(subs, [])).toBe(0)
  })

  test("skips subs with unknown provider", () => {
    const subs: SubAgentSummary[] = [
      { id: "a", model: "claude-sonnet-4-20250514", providerID: "anthropic", cost: 0.1, input: 100, output: 50, reasoning: 0, cacheRead: 1_000_000, cacheWrite: 0 },
      { id: "b", model: "unknown-model", providerID: "missing", cost: 0.2, input: 200, output: 100, reasoning: 0, cacheRead: 1_000_000, cacheWrite: 0 },
    ]
    const result = computeSubsSaved(subs, MOCK_PROVIDERS)
    expect(result).toBeCloseTo(2.7, 10)
  })
})

describe("computeSessionPricing", () => {
  test("uses each message model and reports net cache value", () => {
    const result = computeSessionPricing([
      {
        role: "assistant",
        providerID: "anthropic",
        modelID: "claude-sonnet-4-20250514",
        tokens: { input: 1_000_000, cache: { read: 1_000_000, write: 1_000_000 } },
      },
      {
        role: "assistant",
        providerID: "openai",
        modelID: "gpt-4o",
        tokens: { input: 1_000_000, cache: { read: 1_000_000 } },
      },
    ], MOCK_PROVIDERS)
    expect(result.counted).toBe(2)
    expect(result.readSavings).toBeCloseTo(5.2, 10)
    expect(result.writePremium).toBeCloseTo(0.75, 10)
    expect(result.netCacheValue).toBeCloseTo(4.45, 10)
  })

  test("can report a negative cache value when writes exceed read savings", () => {
    const result = computeSessionPricing([
      {
        role: "assistant",
        providerID: "anthropic",
        modelID: "claude-sonnet-4-20250514",
        tokens: { cache: { write: 1_000_000 } },
      },
    ], MOCK_PROVIDERS)
    expect(result.netCacheValue).toBeCloseTo(-0.75, 10)
  })

  test("excludes compaction messages", () => {
    const result = computeSessionPricing([
      { role: "assistant", agent: "compaction", providerID: "anthropic", modelID: "claude-sonnet-4-20250514", tokens: { input: 1_000_000 } },
    ], MOCK_PROVIDERS)
    expect(result.counted).toBe(0)
    expect(result.cost).toBe(0)
  })

  test("reports messages with missing rates as unpriced", () => {
    const result = computeSessionPricing([
      {
        role: "assistant",
        providerID: "missing",
        modelID: "unknown",
        cost: 1,
        tokens: { input: 1_000_000 },
      },
    ], MOCK_PROVIDERS)
    expect(result.counted).toBe(0)
    expect(result.unpriced).toBe(1)
  })
})
