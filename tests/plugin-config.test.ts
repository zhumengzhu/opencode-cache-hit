import { describe, test, expect } from "bun:test"
import {
  normalizePluginConfig,
  normalizeDisplayConfig,
  normalizeTimelineConfig,
  normalizeCacheTTLConfig,
  normalizeDynamicPricingConfig,
  isToolSummaryEnabled,
  parseDuration,
  DEFAULT_PLUGIN_CONFIG,
  DEFAULT_TIMELINE,
  DEFAULT_CACHE_TTL,
} from "../src/plugin-config.ts"
import { DEFAULT_DYNAMIC_PRICING } from "../src/dynamic-pricing/types.ts"

describe("normalizeDisplayConfig", () => {
  test("defaults lang en and panelBorder", () => {
    expect(normalizeDisplayConfig(null).lang).toBe("en")
    expect(normalizeDisplayConfig({}).panelBorder).toBe(true)
    expect(normalizeDisplayConfig({ agentsBorder: false }).panelBorder).toBe(false)
  })

  test("parses overrides", () => {
    const d = normalizeDisplayConfig({ mainHitLabel: "累计", panelBorder: false })
    expect(d.mainHitLabel).toBe("累计")
    expect(d.panelBorder).toBe(false)
  })

  test("ignores removed showMainSession", () => {
    const d = normalizeDisplayConfig({ showMainSession: false } as Record<string, unknown>)
    expect("showMainSession" in d).toBe(false)
  })
})

describe("normalizeTimelineConfig", () => {
  test("defaults disabled", () => {
    const t = normalizeTimelineConfig(null)
    expect(t.enabled).toBe(false)
    expect(t.maxMemoryRows).toBe(50)
    expect(t.toolSummary).toEqual({ allTools: true, bash: false })
  })

  test("parses enabled", () => {
    const t = normalizeTimelineConfig({ enabled: true, dir: "/tmp/logs" })
    expect(t.enabled).toBe(true)
    expect(t.dir).toBe("/tmp/logs")
  })

  test("parses toolSummary boolean", () => {
    expect(normalizeTimelineConfig({ toolSummary: false }).toolSummary).toBe(false)
    expect(normalizeTimelineConfig({ toolSummary: true }).toolSummary).toBe(true)
  })

  test("parses toolSummary object", () => {
    const t = normalizeTimelineConfig({
      toolSummary: { allTools: true, bash: false },
    })
    expect(t.toolSummary).toEqual({ allTools: true, bash: false })
  })

  test("toolSummary object defaults allTools to true", () => {
    const t = normalizeTimelineConfig({
      toolSummary: { bash: false, read: true },
    })
    expect(t.toolSummary).toEqual({ allTools: true, bash: false, read: true })
  })

  test("ignores unknown toolSummary keys", () => {
    const t = normalizeTimelineConfig({
      toolSummary: { allTools: false, unknownTool: true },
    })
    expect(t.toolSummary).toEqual({ allTools: false })
  })
})

describe("normalizePluginConfig", () => {
  test("merges cost and display", () => {
    const c = normalizePluginConfig({
      currency: "CNY",
      costUnit: "USD",
      rate: 7,
      display: { lang: "zh" },
    })
    expect(c.cost.rate).toBe(7)
    expect(c.display.lang).toBe("zh")
    expect(c.timeline.enabled).toBe(false)
  })
})

describe("isToolSummaryEnabled", () => {
  test("boolean true enables all tools", () => {
    expect(isToolSummaryEnabled(true, "bash")).toBe(true)
    expect(isToolSummaryEnabled(true, "read")).toBe(true)
  })

  test("boolean false disables all tools", () => {
    expect(isToolSummaryEnabled(false, "bash")).toBe(false)
    expect(isToolSummaryEnabled(false, "read")).toBe(false)
  })

  test("object with allTools=true enables unlisted tools", () => {
    expect(isToolSummaryEnabled({ allTools: true }, "bash")).toBe(true)
    expect(isToolSummaryEnabled({ allTools: true }, "read")).toBe(true)
  })

  test("object with allTools=false disables unlisted tools", () => {
    expect(isToolSummaryEnabled({ allTools: false }, "bash")).toBe(false)
    expect(isToolSummaryEnabled({ allTools: false }, "read")).toBe(false)
  })

  test("per-tool override takes precedence", () => {
    const setting = { allTools: true, bash: false, read: true }
    expect(isToolSummaryEnabled(setting, "bash")).toBe(false)
    expect(isToolSummaryEnabled(setting, "read")).toBe(true)
    expect(isToolSummaryEnabled(setting, "edit")).toBe(true) // falls back to allTools
  })

  test("per-tool override on disabled allTools", () => {
    const setting = { allTools: false, read: true }
    expect(isToolSummaryEnabled(setting, "bash")).toBe(false)
    expect(isToolSummaryEnabled(setting, "read")).toBe(true)
  })
})

describe("parseDuration", () => {
  test("parses seconds", () => {
    expect(parseDuration("30s")).toBe(30_000)
    expect(parseDuration("60sec")).toBe(60_000)
    expect(parseDuration("1second")).toBe(1_000)
    expect(parseDuration("2seconds")).toBe(2_000)
  })

  test("parses minutes", () => {
    expect(parseDuration("5m")).toBe(300_000)
    expect(parseDuration("1min")).toBe(60_000)
    expect(parseDuration("2minute")).toBe(120_000)
    expect(parseDuration("3minutes")).toBe(180_000)
  })

  test("parses hours", () => {
    expect(parseDuration("1h")).toBe(3_600_000)
    expect(parseDuration("2hr")).toBe(7_200_000)
    expect(parseDuration("1hour")).toBe(3_600_000)
    expect(parseDuration("3hours")).toBe(10_800_000)
  })

  test("parses decimal values", () => {
    expect(parseDuration("1.5h")).toBe(5_400_000)
    expect(parseDuration("0.5m")).toBe(30_000)
  })

  test("parses raw milliseconds", () => {
    expect(parseDuration("300000")).toBe(300_000)
    expect(parseDuration("3600000")).toBe(3_600_000)
  })

  test("returns null for invalid input", () => {
    expect(parseDuration("")).toBe(null)
    expect(parseDuration("abc")).toBe(null)
    expect(parseDuration("0s")).toBe(null)
    expect(parseDuration("-5m")).toBe(null)
  })

  test("case insensitive", () => {
    expect(parseDuration("5M")).toBe(300_000)
    expect(parseDuration("1H")).toBe(3_600_000)
  })
})

describe("normalizeCacheTTLConfig", () => {
  test("defaults enabled with empty providers", () => {
    const c = normalizeCacheTTLConfig(null)
    expect(c.enabled).toBe(true)
    expect(c.providers).toEqual({})
  })

  test("parses providers with string values", () => {
    const c = normalizeCacheTTLConfig({
      enabled: true,
      providers: {
        anthropic: "5m",
        deepseek: "2h",
      },
    })
    expect(c.providers.anthropic).toBe("5m")
    expect(c.providers.deepseek).toBe("2h")
  })

  test("ignores non-string provider values", () => {
    const c = normalizeCacheTTLConfig({
      providers: {
        anthropic: 300000,
        openai: "5m",
        deepseek: true,
      },
    })
    expect(Object.keys(c.providers)).toEqual(["openai"])
    expect(c.providers.openai).toBe("5m")
  })

  test("respects enabled flag", () => {
    const c = normalizeCacheTTLConfig({ enabled: false })
    expect(c.enabled).toBe(false)
  })

  // Regression for #1/#3: normalize must always emit `providers`, even when the
  // raw config supplies only `enabled`. A missing providers field is what crashed
  // getTTL in stale-cached builds.
  test("always emits providers even when raw omits it", () => {
    const c = normalizeCacheTTLConfig({ enabled: true })
    expect(c.providers).toBeDefined()
    expect(c.providers).toEqual({})
  })
})

describe("deep clone isolation", () => {
  test("normalizePluginConfig(null) does not share nested refs with DEFAULT_PLUGIN_CONFIG", () => {
    const cfg = normalizePluginConfig(null)
    expect(cfg).not.toBe(DEFAULT_PLUGIN_CONFIG)
    expect(cfg.cacheTTL).not.toBe(DEFAULT_PLUGIN_CONFIG.cacheTTL)
    expect(cfg.cacheTTL.providers).not.toBe(DEFAULT_PLUGIN_CONFIG.cacheTTL.providers)
    expect(cfg.timeline).not.toBe(DEFAULT_PLUGIN_CONFIG.timeline)
    expect(cfg.timeline.toolSummary).not.toBe(DEFAULT_PLUGIN_CONFIG.timeline.toolSummary)
  })

  test("normalizeTimelineConfig(null) mutations do not pollute DEFAULT_TIMELINE", () => {
    const t = normalizeTimelineConfig(null)
    t.toolSummary = false
    t.enabled = true

    expect(DEFAULT_TIMELINE.toolSummary).toEqual({ allTools: true, bash: false })
    expect(DEFAULT_TIMELINE.enabled).toBe(false)
  })

  test("normalizeCacheTTLConfig(null) mutations do not pollute DEFAULT_CACHE_TTL", () => {
    const c = normalizeCacheTTLConfig(null)
    c.providers["xai"] = "5m"
    c.enabled = false

    expect(DEFAULT_CACHE_TTL.providers).toEqual({})
    expect(DEFAULT_CACHE_TTL.enabled).toBe(true)
  })
})

describe("normalizeDynamicPricingConfig — schedule days + fallback", () => {
  test("parses days:[1..5]", () => {
    const c = normalizeDynamicPricingConfig({
      schedule: [
        { level: "peak", windows: [{ start: "09:00", end: "12:00", days: [1, 2, 3, 4, 5] }] },
      ],
    })
    expect(c.schedule[0].windows[0].days).toEqual([1, 2, 3, 4, 5])
  })
  test("ignores invalid days values and warns", () => {
    const c = normalizeDynamicPricingConfig({
      schedule: [
        { level: "peak", windows: [{ start: "09:00", end: "12:00", days: [0, 8, "mon", 2, 7] }] },
      ],
    })
    expect(c.schedule[0].windows[0].days).toEqual([2, 7])
  })
  test("days: [] means all days (omitted)", () => {
    const c = normalizeDynamicPricingConfig({
      schedule: [
        { level: "peak", windows: [{ start: "09:00", end: "12:00", days: [] }] },
      ],
    })
    expect(c.schedule[0].windows[0].days).toBeUndefined()
  })
  test("empty windows level kept as fallback", () => {
    const c = normalizeDynamicPricingConfig({
      schedule: [
        { level: "peak", windows: [{ start: "09:00", end: "12:00" }] },
        { level: "offpeak", windows: [] },
      ],
    })
    expect(c.schedule.length).toBe(2)
    expect(c.schedule[0].level).toBe("peak")
    expect(c.schedule[1]).toEqual({ level: "offpeak", windows: [] })
  })
  test("dedupes more than one fallback, keeps first, windowed levels first", () => {
    const c = normalizeDynamicPricingConfig({
      schedule: [
        { level: "offpeak", windows: [] },
        { level: "peak", windows: [{ start: "09:00", end: "12:00" }] },
        { level: "night", windows: [] },
      ],
    })
    expect(c.schedule.map((l) => l.level)).toEqual(["peak", "offpeak"])
    expect(c.schedule[1].windows).toEqual([])
  })
  test("windowed level with all-invalid windows is dropped (not turned into fallback)", () => {
    const c = normalizeDynamicPricingConfig({
      schedule: [
        { level: "peak", windows: [{ start: "oops", end: "12:00" }] },
        { level: "offpeak", windows: [{ start: "18:00", end: "09:00" }] },
      ],
    })
    expect(c.schedule.map((l) => l.level)).toEqual(["offpeak"])
  })
  test("default schedule is weekday-aware with fallback", () => {
    const c = normalizeDynamicPricingConfig({})
    const peak = c.schedule.find((l) => l.level === "peak")
    expect(peak?.windows.every((w) => w.days?.length === 5)).toBe(true)
    const offpeak = c.schedule.find((l) => l.level === "offpeak")
    expect(offpeak?.windows).toEqual([])
  })
  test("invalid raw schedule falls back to defaults", () => {
    const c = normalizeDynamicPricingConfig({ schedule: "nope" })
    expect(c.schedule).toEqual(structuredClone(DEFAULT_DYNAMIC_PRICING.schedule))
  })
})
