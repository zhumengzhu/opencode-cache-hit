import { describe, test, expect } from "bun:test"
import { resolveModelCost, lookupModelCost } from "../src/dynamic-pricing/lookup.ts"
import { computePricing } from "../src/pricing.ts"
import type { ProviderInfo } from "../src/types.ts"
import { DEFAULT_SCHEDULE } from "../src/dynamic-pricing/types.ts"

const TZ = "Asia/Shanghai"

/** 北京时间 y-m-d h:m → epoch ms。 */
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

const DEFAULT_RULES = {
  enabled: true,
  timezone: TZ,
  schedule: DEFAULT_SCHEDULE,
  contextThreshold: 200_000,
  providers: {},
}

describe("lookupModelCost", () => {
  test("finds static cost including context_over_200k", () => {
    const cost = lookupModelCost(PROVIDERS, "openai", "gpt-5.6")
    expect(cost?.context_over_200k?.input).toBe(2.0)
  })
})

describe("resolveModelCost — context tier", () => {
  test("uses over-200k tier when contextTokens exceed threshold", () => {
    const r = resolveModelCost(PROVIDERS, "openai", "gpt-5.6", {
      contextTokens: 250_000,
      rules: DEFAULT_RULES,
    })
    expect(r?.rates.input).toBe(2.0)
    expect(r?.contextTier).toBe("over")
  })
  test("uses base tier under threshold", () => {
    const r = resolveModelCost(PROVIDERS, "openai", "gpt-5.6", {
      contextTokens: 100_000,
      rules: DEFAULT_RULES,
    })
    expect(r?.rates.input).toBe(1.0)
    expect(r?.contextTier).toBe("base")
  })
  test("no context info → base tier", () => {
    const r = resolveModelCost(PROVIDERS, "openai", "gpt-5.6", { rules: DEFAULT_RULES })
    expect(r?.rates.input).toBe(1.0)
    expect(r?.contextTier).toBeUndefined()
  })
})

describe("resolveModelCost — built-in DeepSeek time-of-day", () => {
  test("peak keeps static rates", () => {
    const r = resolveModelCost(PROVIDERS, "deepseek", "deepseek/deepseek-v4-flash", {
      now: bjt(2026, 8, 10, 10, 0),
      rules: DEFAULT_RULES,
    })
    expect(r?.rates.input).toBe(0.5)
    expect(r?.level).toBe("peak")
    expect(r?.explicit).toBe(true)
  })
  test("offpeak halves static rates", () => {
    const r = resolveModelCost(PROVIDERS, "deepseek", "deepseek/deepseek-v4-flash", {
      now: bjt(2026, 8, 10, 22, 0),
      rules: DEFAULT_RULES,
    })
    expect(r?.rates.input).toBe(0.25)
    expect(r?.rates.cache.read).toBe(0.005)
    expect(r?.level).toBe("offpeak")
  })
  test("weekend peak hours → offpeak 0.5× (DeepSeek weekend idle)", () => {
    // 周六 10:00 本应全价的时段 → 空闲半价
    const sat = resolveModelCost(PROVIDERS, "deepseek", "deepseek/deepseek-v4-flash", {
      now: bjt(2026, 8, 15, 10, 0),
      rules: DEFAULT_RULES,
    })
    expect(sat?.level).toBe("offpeak")
    expect(sat?.rates.input).toBe(0.25)
    // 周日 15:00 同样
    const sun = resolveModelCost(PROVIDERS, "deepseek", "deepseek/deepseek-v4-flash", {
      now: bjt(2026, 8, 16, 15, 0),
      rules: DEFAULT_RULES,
    })
    expect(sun?.level).toBe("offpeak")
    expect(sun?.rates.input).toBe(0.25)
  })
  test("disabled rules → static rates, no level", () => {
    const r = resolveModelCost(PROVIDERS, "deepseek", "deepseek/deepseek-v4-flash", {
      now: bjt(2026, 8, 10, 22, 0),
      rules: { ...DEFAULT_RULES, enabled: false },
    })
    expect(r?.rates.input).toBe(0.5)
    expect(r?.level).toBeUndefined()
  })
})

describe("resolveModelCost — level only for time-of-day priced models", () => {
  test("model without any dynamic rule: no level even when schedule fallback matches", () => {
    // gpt-5.6 仅有 context 分档，无 levels/multipliers；周六 10:00 默认回退档命中 offpeak，但不标注
    const r = resolveModelCost(PROVIDERS, "openai", "gpt-5.6", {
      now: bjt(2026, 8, 15, 10, 0),
      rules: DEFAULT_RULES,
    })
    expect(r?.rates.input).toBe(1.0)
    expect(r?.level).toBeUndefined()
    expect(r?.explicit).toBe(false)
  })
  test("contextThreshold-only rule: no level badge (but still explicit)", () => {
    const rules = {
      ...DEFAULT_RULES,
      providers: {
        openai: { models: { "gpt-5.6": { contextThreshold: 100_000 } } },
      },
    }
    const r = resolveModelCost(PROVIDERS, "openai", "gpt-5.6", {
      now: bjt(2026, 8, 10, 10, 0), // 周一 10:00 —— 本会命中 peak
      contextTokens: 50_000,
      rules,
    })
    expect(r?.rates.input).toBe(1.0)
    expect(r?.level).toBeUndefined()
    expect(r?.explicit).toBe(true)
  })
  test("multipliers without the current level: full price, no badge", () => {
    // 只配了 peak 的模型：offpeak 时刻 factor=1（全价），不贴「空闲」徽标
    const rules = {
      ...DEFAULT_RULES,
      providers: {
        openai: {
          models: { "gpt-5.6": { multipliers: { peak: 0.9 } } },
        },
      },
    }
    const offpeak = resolveModelCost(PROVIDERS, "openai", "gpt-5.6", {
      now: bjt(2026, 8, 15, 10, 0), // 周六 → 回退档 offpeak
      rules,
    })
    expect(offpeak?.rates.input).toBe(1.0) // 无 offpeak 档 → 不折价
    expect(offpeak?.level).toBeUndefined()
    const peak = resolveModelCost(PROVIDERS, "openai", "gpt-5.6", {
      now: bjt(2026, 8, 10, 10, 0), // 周一 10:00 → peak
      rules,
    })
    expect(peak?.rates.input).toBe(0.9)
    expect(peak?.level).toBe("peak")
  })
  test("DeepSeek built-in default still reports level", () => {
    const r = resolveModelCost(PROVIDERS, "deepseek", "deepseek/deepseek-v4-flash", {
      now: bjt(2026, 8, 10, 10, 0),
      rules: DEFAULT_RULES,
    })
    expect(r?.level).toBe("peak")
  })
})

describe("resolveModelCost — explicit rules override", () => {
  test("absolute levels win over multiplier fallback", () => {
    const rules = {
      ...DEFAULT_RULES,
      providers: {
        deepseek: {
          models: {
            "deepseek/deepseek-v4-flash": {
              levels: {
                peak: { input: 0.44, output: 0.88, cache: { read: 0.01, write: 0 } },
                offpeak: { input: 0.22, output: 0.44, cache: { read: 0.005, write: 0 } },
              },
            },
          },
        },
      },
    }
    const r = resolveModelCost(PROVIDERS, "deepseek", "deepseek/deepseek-v4-flash", {
      now: bjt(2026, 8, 10, 22, 0),
      rules,
    })
    expect(r?.rates.input).toBe(0.22)
    expect(r?.level).toBe("offpeak")
  })
  test("levels + fallback: weekend falls to offpeak levels", () => {
    const rules = {
      ...DEFAULT_RULES,
      providers: {
        deepseek: {
          models: {
            "deepseek/deepseek-v4-flash": {
              levels: {
                peak: { input: 0.44, output: 0.88, cache: { read: 0.01, write: 0 } },
                offpeak: { input: 0.22, output: 0.44, cache: { read: 0.005, write: 0 } },
              },
            },
          },
        },
      },
    }
    // 周六 10:00 → 回退档 offpeak → 取 levels.offpeak
    const r = resolveModelCost(PROVIDERS, "deepseek", "deepseek/deepseek-v4-flash", {
      now: bjt(2026, 8, 15, 10, 0),
      rules,
    })
    expect(r?.level).toBe("offpeak")
    expect(r?.rates.input).toBe(0.22)
  })
  test("per-model contextThreshold override", () => {
    const rules = {
      ...DEFAULT_RULES,
      providers: {
        openai: { models: { "gpt-5.6": { contextThreshold: 100_000 } } },
      },
    }
    const r = resolveModelCost(PROVIDERS, "openai", "gpt-5.6", {
      contextTokens: 150_000,
      rules,
    })
    expect(r?.rates.input).toBe(2.0)
    expect(r?.contextTier).toBe("over")
  })
  test("unknown model returns null", () => {
    expect(resolveModelCost(PROVIDERS, "openai", "nope", { rules: DEFAULT_RULES })).toBeNull()
  })

  test("absolute levels keep no context badge; multipliers keep it (#3)", () => {
    const rules = {
      ...DEFAULT_RULES,
      providers: {
        openai: {
          models: {
            "gpt-5.6": {
              levels: { peak: { input: 0.9, output: 1.8, cache: { read: 0.05, write: 0 } } },
            },
          },
        },
      },
    }
    // 命中时段 → 绝对价（完整价格，无 context 分档语义）→ 不标注 badge
    const hit = resolveModelCost(PROVIDERS, "openai", "gpt-5.6", {
      now: bjt(2026, 8, 10, 10, 0), // peak
      contextTokens: 250_000,
      rules,
    })
    expect(hit?.rates.input).toBe(0.9)
    expect(hit?.contextTier).toBeUndefined()

    // multipliers 模式 → context 档叠加，badge 保留
    const rules2 = {
      ...DEFAULT_RULES,
      providers: {
        openai: { models: { "gpt-5.6": { multipliers: { peak: 1, offpeak: 1 } } } },
      },
    }
    const tiered = resolveModelCost(PROVIDERS, "openai", "gpt-5.6", {
      now: bjt(2026, 8, 10, 10, 0),
      contextTokens: 250_000,
      rules: rules2,
    })
    expect(tiered?.contextTier).toBe("over")
  })
})

describe("resolveModelCost — runtime cost normalization (#1)", () => {
  const RUNTIME_PROVIDERS: ProviderInfo[] = [
    {
      id: "openai",
      models: {
        "gpt-5.6": {
          cost: {
            input: 1.0,
            output: 3.0,
            cache: { read: 0.1, write: 0 },
            // 运行时格式：opencode 把配置层 context_over_200k 转为 tiers / experimentalOver200K
            experimentalOver200K: { input: 2.0, output: 5.0, cache: { read: 0.2, write: 0 } },
          },
        },
      },
    },
    {
      id: "anthropic",
      models: {
        "claude-x": {
          cost: {
            input: 3,
            output: 15,
            cache: { read: 0.3, write: 3.75 },
            tiers: [
              { input: 6, output: 30, cache: { read: 0.6, write: 7.5 }, tier: { type: "context", size: 100_000 } },
            ],
          },
        },
      },
    },
  ]

  test("normalizes experimentalOver200K into context tier", () => {
    const r = resolveModelCost(RUNTIME_PROVIDERS, "openai", "gpt-5.6", {
      contextTokens: 250_000,
      rules: DEFAULT_RULES,
    })
    expect(r?.rates.input).toBe(2.0)
    expect(r?.contextTier).toBe("over")
  })

  test("normalizes tiers[] with its own size threshold", () => {
    const r = resolveModelCost(RUNTIME_PROVIDERS, "anthropic", "claude-x", {
      contextTokens: 150_000, // > tier.size 100k，尽管 < 全局 200k
      rules: DEFAULT_RULES,
    })
    expect(r?.rates.input).toBe(6)
    expect(r?.contextTier).toBe("over")
  })

  test("per-model rule threshold wins over runtime tier size", () => {
    // 运行时 experimentalOver200K 阈值为 200k；用户显式配置 100k → 150k 应判 over。
    const rules = {
      ...DEFAULT_RULES,
      providers: {
        openai: { models: { "gpt-5.6": { contextThreshold: 100_000 } } },
      },
    }
    const r = resolveModelCost(RUNTIME_PROVIDERS, "openai", "gpt-5.6", {
      contextTokens: 150_000,
      rules,
    })
    expect(r?.rates.input).toBe(2.0)
    expect(r?.contextTier).toBe("over")
  })
})

describe("resolveModelCost — enabled:false disables everything (#2)", () => {
  test("explicit levels are ignored when disabled", () => {
    const rules = {
      ...DEFAULT_RULES,
      enabled: false,
      providers: {
        deepseek: {
          models: {
            "deepseek/deepseek-v4-flash": {
              levels: {
                peak: { input: 9, output: 27, cache: { read: 0.3, write: 0 } },
                offpeak: { input: 4.5, output: 13.5, cache: { read: 0.15, write: 0 } },
              },
            },
          },
        },
      },
    }
    const r = resolveModelCost(PROVIDERS, "deepseek", "deepseek/deepseek-v4-flash", {
      now: bjt(2026, 8, 10, 10, 0), // peak
      rules,
    })
    expect(r?.rates.input).toBe(0.5) // 静态价，非 9
    expect(r?.explicit).toBe(false)
  })

  test("context tier is disabled too", () => {
    const rules = { ...DEFAULT_RULES, enabled: false }
    const r = resolveModelCost(PROVIDERS, "openai", "gpt-5.6", {
      contextTokens: 250_000,
      rules,
    })
    expect(r?.rates.input).toBe(1.0) // 基础档，不应用 context_over_200k
    expect(r?.contextTier).toBeUndefined()
  })
})

describe("resolveModelCost — DeepSeek legacy schedule warning (#Q6)", () => {
  const DS_PRO: ProviderInfo[] = [
    {
      id: "deepseek",
      models: {
        // 独立模型 key，避免与其它用例共用模块级去重 Set
        "deepseek/deepseek-v4-pro": {
          cost: { input: 1.0, output: 2.0, cache: { read: 0.1, write: 0 } },
        },
      },
    },
  ]
  test("warns once for windowed schedule without days; silent with days / non-DeepSeek", () => {
    const warnings: string[] = []
    const origWarn = console.warn
    console.warn = (msg?: unknown) => { warnings.push(String(msg)) }
    try {
      const legacy = {
        ...DEFAULT_RULES,
        schedule: [{ level: "peak", windows: [{ start: 9 * 60, end: 12 * 60 }] }],
      }
      const hit = (rules: typeof DEFAULT_RULES) =>
        resolveModelCost(DS_PRO, "deepseek", "deepseek/deepseek-v4-pro", {
          now: bjt(2026, 8, 10, 10, 0),
          rules,
        })
      // 旧配置（无 days）→ 仅提示一次（Set 去重）
      hit(legacy)
      hit(legacy)
      expect(warnings.length).toBe(1)
      expect(warnings[0]).toContain("days")
      // 星期感知默认 schedule → 不提示
      warnings.length = 0
      hit(DEFAULT_RULES)
      expect(warnings.length).toBe(0)
      // 非 DeepSeek 模型 → 不提示
      warnings.length = 0
      resolveModelCost(PROVIDERS, "openai", "gpt-5.6", { rules: legacy })
      expect(warnings.length).toBe(0)
    } finally {
      console.warn = origWarn
    }
  })
})

describe("resolveModelCost — level miss falls back to static (#4)", () => {
  test("levels do not match current level → static rates, not first level", () => {
    const rules = {
      ...DEFAULT_RULES,
      // 自定义 schedule 仅覆盖 20:00-22:00，当前 10:00 未命中任何时段
      schedule: [{ level: "peak", windows: [{ start: 20 * 60, end: 22 * 60 }] }],
      providers: {
        deepseek: {
          models: {
            "deepseek/deepseek-v4-flash": {
              levels: {
                peak: { input: 9, output: 27, cache: { read: 0.3, write: 0 } },
                offpeak: { input: 4.5, output: 13.5, cache: { read: 0.15, write: 0 } },
              },
            },
          },
        },
      },
    }
    const r = resolveModelCost(PROVIDERS, "deepseek", "deepseek/deepseek-v4-flash", {
      now: bjt(2026, 8, 10, 10, 0),
      rules,
    })
    expect(r?.rates.input).toBe(0.5) // 回退静态价，而非 9 或 4.5
    expect(r?.level).toBeUndefined()
  })
})

describe("computePricing — backward compat + dynamic fields", () => {
  test("no ctx → static behavior, dynamic=false", () => {
    const p = computePricing(PROVIDERS, "deepseek", "deepseek/deepseek-v4-flash", 1_000_000)
    expect(p.inputRate).toBe(0.5)
    expect(p.dynamic).toBe(false)
    expect(p.level).toBeUndefined()
  })
  test("with rules + now → level and halved rates", () => {
    const p = computePricing(PROVIDERS, "deepseek", "deepseek/deepseek-v4-flash", 1_000_000, {
      now: bjt(2026, 8, 10, 22, 0),
      rules: DEFAULT_RULES,
    })
    expect(p.inputRate).toBe(0.25)
    expect(p.level).toBe("offpeak")
    expect(p.dynamic).toBe(true)
    expect(p.saved).toBe(((0.25 - 0.005) * 1_000_000) / 1_000_000)
  })
})
