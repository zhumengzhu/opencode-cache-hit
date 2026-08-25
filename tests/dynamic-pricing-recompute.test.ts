import { describe, test, expect } from "bun:test"
import { recomputeSubAgentCost, recomputeRecordCost } from "../src/dynamic-pricing/recompute.ts"
import { normalizeDynamicPricingConfig } from "../src/plugin-config.ts"
import type { ProviderInfo } from "../src/types.ts"
import { DEFAULT_SCHEDULE } from "../src/dynamic-pricing/types.ts"

const TZ = "Asia/Shanghai"

function bjt(y: number, m: number, d: number, h: number, min = 0): number {
  return Date.UTC(y, m - 1, d, h - 8, min)
}

const PROVIDERS: ProviderInfo[] = [
  {
    id: "deepseek",
    models: {
      "deepseek/deepseek-v4-flash": {
        cost: { input: 0.5, output: 1.0, cache: { read: 0.01, write: 0 } },
      },
    },
  },
  {
    id: "openai",
    models: {
      "gpt-5.6": {
        cost: {
          input: 1.0,
          output: 3.0,
          cache: { read: 0.1, write: 0 },
          context_over_200k: { input: 2.0, output: 5.0, cache: { read: 0.2, write: 0 } },
        },
      },
    },
  },
]

const RULES = {
  enabled: true,
  timezone: TZ,
  schedule: DEFAULT_SCHEDULE,
  contextThreshold: 200_000,
  providers: {},
}

describe("recomputeSubAgentCost", () => {
  test("uses session created time for time-of-day pricing", () => {
    const sub = {
      id: "s1",
      model: "deepseek/deepseek-v4-flash",
      providerID: "deepseek",
      cost: 0.5,
      input: 100_000,
      output: 10_000,
      reasoning: 0,
      cacheRead: 50_000,
      cacheWrite: 0,
      created: bjt(2026, 8, 10, 22, 0), // offpeak → 半价
    }
    const cost = recomputeSubAgentCost(sub, PROVIDERS, RULES)
    const expected = (100_000 * 0.25 + 10_000 * 0.5 + 50_000 * 0.005) / 1_000_000
    expect(cost).toBeCloseTo(expected, 10)
  })
  test("returns null without created (cannot price time-of-day)", () => {
    const sub = {
      id: "s1",
      model: "deepseek/deepseek-v4-flash",
      providerID: "deepseek",
      cost: 0.5,
      input: 100_000,
      output: 10_000,
      reasoning: 0,
      cacheRead: 50_000,
      cacheWrite: 0,
    }
    expect(recomputeSubAgentCost(sub, PROVIDERS, RULES)).toBeNull()
  })
  test("returns null for unknown model", () => {
    const sub = {
      id: "s1",
      model: "nope",
      providerID: "deepseek",
      cost: 0,
      input: 100,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      created: bjt(2026, 8, 10, 22, 0),
    }
    expect(recomputeSubAgentCost(sub, PROVIDERS, RULES)).toBeNull()
  })
})

describe("recomputeRecordCost", () => {
  test("recomputes from record created time + context tier (explicit rule)", () => {
    const rules = {
      ...RULES,
      providers: {
        openai: { models: { "gpt-5.6": { contextThreshold: 200_000 } } },
      },
    }
    const r = recomputeRecordCost(
      {
        modelId: "gpt-5.6",
        providerId: "openai",
        created: "2026-08-10T10:00:00+08:00", // 北京 10:00
        input: 300_000,
        output: 1_000,
        cacheRead: 0,
        cacheWrite: 0,
      },
      PROVIDERS,
      rules,
    )
    const expected = (300_000 * 2.0 + 1_000 * 5.0) / 1_000_000
    expect(r).toBeCloseTo(expected, 10)
  })
  test("matches provider by modelId when providerId absent", () => {
    const r = recomputeRecordCost(
      {
        modelId: "deepseek/deepseek-v4-flash",
        created: "2026-08-10T22:00:00+08:00", // offpeak
        input: 100_000,
        output: 10_000,
        cacheRead: 50_000,
        cacheWrite: 0,
      },
      PROVIDERS,
      RULES,
    )
    const expected = (100_000 * 0.25 + 10_000 * 0.5 + 50_000 * 0.005) / 1_000_000
    expect(r).toBeCloseTo(expected, 10)
  })
  test("returns null when no model matches or nothing to price", () => {
    expect(recomputeRecordCost({ modelId: "nope", created: "2026-08-10T22:00:00+08:00", input: 100 }, PROVIDERS, RULES)).toBeNull()
    expect(recomputeRecordCost({ modelId: "", created: "2026-08-10T22:00:00+08:00" }, PROVIDERS, RULES)).toBeNull()
    expect(recomputeRecordCost({ modelId: "deepseek/deepseek-v4-flash", created: "bad" }, PROVIDERS, RULES)).toBeNull()
  })
})

describe("normalizeDynamicPricingConfig", () => {
  test("defaults when absent", () => {
    const cfg = normalizeDynamicPricingConfig(undefined)
    expect(cfg.enabled).toBe(true)
    expect(cfg.timezone).toBe("Asia/Shanghai")
    expect(cfg.schedule.length).toBeGreaterThan(0)
    expect(cfg.contextThreshold).toBe(200_000)
    expect(cfg.providers).toEqual({})
  })
  test("parses explicit rules", () => {
    const cfg = normalizeDynamicPricingConfig({
      enabled: false,
      timezone: "UTC",
      contextThreshold: 100_000,
      schedule: [{ level: "peak", windows: [{ start: "08:00", end: "20:00" }] }],
      providers: {
        deepseek: {
          models: {
            "deepseek/deepseek-v4-flash": {
              multipliers: { offpeak: 0.5 },
            },
          },
        },
      },
    })
    expect(cfg.enabled).toBe(false)
    expect(cfg.timezone).toBe("UTC")
    expect(cfg.contextThreshold).toBe(100_000)
    expect(cfg.schedule[0].windows[0]).toEqual({ start: 480, end: 1200 })
    expect(cfg.providers.deepseek.models["deepseek/deepseek-v4-flash"].multipliers?.offpeak).toBe(0.5)
  })
  test("rejects malformed schedule and falls back to defaults", () => {
    const cfg = normalizeDynamicPricingConfig({ schedule: [{ level: "peak", windows: [{ start: "99:99", end: "x" }] }] })
    expect(cfg.schedule.length).toBeGreaterThan(0)
  })
  test("converts non-USD levels to internal USD at load time", () => {
    const cfg = normalizeDynamicPricingConfig(
      {
        providers: {
          deepseek: {
            models: {
              "deepseek/deepseek-v4-flash": {
                currency: "CNY",
                levels: {
                  offpeak: { input: 1.5, output: 4.5, cacheRead: 0.05, cacheWrite: 0 },
                  peak: { input: 3, output: 9, cacheRead: 0.1, cacheWrite: 0 },
                },
              },
            },
          },
        },
      },
      { usdRate: 6.77, displayCurrency: "CNY" },
    )
    const rule = cfg.providers.deepseek.models["deepseek/deepseek-v4-flash"]
    expect(rule.levels?.offpeak.input).toBeCloseTo(1.5 / 6.77, 6)
    expect(rule.levels?.peak.output).toBeCloseTo(9 / 6.77, 6)
    expect(rule.currency).toBeUndefined()
  })
  test("keeps USD levels untouched", () => {
    const cfg = normalizeDynamicPricingConfig(
      {
        providers: {
          deepseek: {
            models: {
              "deepseek/deepseek-v4-flash": {
                levels: { offpeak: { input: 0.22, output: 0.44, cacheRead: 0.005, cacheWrite: 0 } },
              },
            },
          },
        },
      },
      { usdRate: 6.77 },
    )
    const rule = cfg.providers.deepseek.models["deepseek/deepseek-v4-flash"]
    expect(rule.levels?.offpeak.input).toBe(0.22)
  })
  test("converts CNY levels when display currency matches (#5)", () => {
    const cfg = normalizeDynamicPricingConfig(
      {
        providers: {
          deepseek: {
            models: {
              "deepseek/deepseek-v4-flash": {
                currency: "CNY",
                levels: { offpeak: { input: 6.77, output: 20, cacheRead: 0.1, cacheWrite: 0 } },
              },
            },
          },
        },
      },
      { usdRate: 6.77, displayCurrency: "CNY" },
    )
    const rule = cfg.providers.deepseek.models["deepseek/deepseek-v4-flash"]
    expect(rule.levels?.offpeak.input).toBeCloseTo(1, 6) // 6.77 / 6.77
  })
  test("uses explicit rule.rate for non-display currency (#5)", () => {
    const cfg = normalizeDynamicPricingConfig(
      {
        providers: {
          deepseek: {
            models: {
              "deepseek/deepseek-v4-flash": {
                currency: "EUR",
                rate: 1.08, // USD → EUR
                levels: { offpeak: { input: 1.08, output: 2, cacheRead: 0.01, cacheWrite: 0 } },
              },
            },
          },
        },
      },
      { usdRate: 6.77, displayCurrency: "CNY" },
    )
    const rule = cfg.providers.deepseek.models["deepseek/deepseek-v4-flash"]
    expect(rule.levels?.offpeak.input).toBeCloseTo(1, 6) // 1.08 / 1.08（不除以 USD→CNY 的 6.77）
  })
  test("keeps unconvertible levels as-is with a warning (#5)", () => {
    const original = console.error
    const calls: string[] = []
    console.error = (...a: unknown[]) => calls.push(String(a[0]))
    try {
      const cfg = normalizeDynamicPricingConfig(
        {
          providers: {
            deepseek: {
              models: {
                "deepseek/deepseek-v4-flash": {
                  currency: "EUR",
                  levels: { offpeak: { input: 1.08, output: 2, cacheRead: 0.01, cacheWrite: 0 } },
                },
              },
            },
          },
        },
        { usdRate: 6.77, displayCurrency: "CNY" },
      )
      const rule = cfg.providers.deepseek.models["deepseek/deepseek-v4-flash"]
      expect(rule.levels?.offpeak.input).toBe(1.08) // 无法换算 → 原样保留（视作 USD）
      expect(calls.some((c) => c.includes("cannot convert EUR"))).toBe(true)
    } finally {
      console.error = original
    }
  })
  test("parses nested cache object in levels (ModelCost shape)", () => {
    const cfg = normalizeDynamicPricingConfig(
      {
        providers: {
          openai: {
            models: {
              "gpt-5.6": {
                levels: { peak: { input: 0.9, output: 1.8, cache: { read: 0.05, write: 0.02 } } },
              },
            },
          },
        },
      },
      { usdRate: 6.77, displayCurrency: "CNY" },
    )
    const peak = cfg.providers.openai.models["gpt-5.6"].levels?.peak
    expect(peak?.cache.read).toBe(0.05)
    expect(peak?.cache.write).toBe(0.02)
  })
  test("flat cache fields win over nested cache object", () => {
    const cfg = normalizeDynamicPricingConfig(
      {
        providers: {
          openai: {
            models: {
              "gpt-5.6": {
                levels: {
                  peak: { input: 0.9, output: 1.8, cacheRead: 0.11, cache: { read: 0.05, write: 0 } },
                },
              },
            },
          },
        },
      },
      { usdRate: 6.77, displayCurrency: "CNY" },
    )
    const peak = cfg.providers.openai.models["gpt-5.6"].levels?.peak
    expect(peak?.cache.read).toBe(0.11) // 扁平优先
  })
  test("malformed nested cache (non-object) is safely treated as 0", () => {
    const cfg = normalizeDynamicPricingConfig(
      {
        providers: {
          openai: {
            models: {
              "gpt-5.6": {
                levels: { peak: { input: 0.9, output: 1.8, cache: 5 } },
              },
            },
          },
        },
      },
      { usdRate: 6.77, displayCurrency: "CNY" },
    )
    const peak = cfg.providers.openai.models["gpt-5.6"].levels?.peak
    expect(peak?.cache.read).toBe(0)
    expect(peak?.cache.write).toBe(0)
  })
  test("CNY levels with nested cache are converted to USD", () => {
    const cfg = normalizeDynamicPricingConfig(
      {
        providers: {
          deepseek: {
            models: {
              "deepseek/deepseek-v4-flash": {
                currency: "CNY",
                levels: { offpeak: { input: 6.77, output: 13.54, cache: { read: 0.677, write: 0 } } },
              },
            },
          },
        },
      },
      { usdRate: 6.77, displayCurrency: "CNY" },
    )
    const offpeak = cfg.providers.deepseek.models["deepseek/deepseek-v4-flash"].levels?.offpeak
    expect(offpeak?.cache.read).toBeCloseTo(0.1, 6) // 0.677 / 6.77
    expect(offpeak?.input).toBeCloseTo(1, 6)
  })
})
