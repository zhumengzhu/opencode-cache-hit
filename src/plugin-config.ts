import { type CostDisplayConfig, normalizeCostDisplay, DEFAULT_COST_DISPLAY, resolveExchangeRate, CURRENCY_PRESETS } from "./format-cost.ts"
import { resolveLang, type Lang } from "./i18n.ts"
import {
  type DynamicPricingConfig,
  type DynamicPricingSchedule,
  type ModelPricingRule,
  type TimeWindow,
  DEFAULT_DYNAMIC_PRICING,
} from "./dynamic-pricing/types.ts"
import { parseClockTime } from "./dynamic-pricing/schedule.ts"

export type { DynamicPricingConfig } from "./dynamic-pricing/types.ts"

export type DisplayConfig = {
  /** `en` | `zh` | `auto` (follow system locale). Default `en`. */
  lang: Lang | "auto"
  /** Optional override for the hit-rate line prefix (default from i18n). */
  mainHitLabel?: string
  /** Outer panel border (visual-cache style). Default true. */
  panelBorder: boolean
  /** @deprecated Use panelBorder */
  agentsBorder?: boolean
  /** Show token speed section. Default true. */
  showSpeed: boolean
  /** Speed display unit. Default "tpot". */
  speedUnit: "tpot" | "tps"
}

export const DEFAULT_DISPLAY: DisplayConfig = {
  lang: "en",
  panelBorder: true,
  showSpeed: true,
  speedUnit: "tpot",
}

export type ToolSummaryConfig = {
  /** Default for tools not explicitly listed. Default true. */
  allTools: boolean
  /** Per-tool overrides. When present, overrides allTools for that tool. */
  bash?: boolean
  read?: boolean
  write?: boolean
  edit?: boolean
  grep?: boolean
  glob?: boolean
  webfetch?: boolean
  websearch?: boolean
  task?: boolean
  question?: boolean
}

export type ToolSummarySetting = boolean | ToolSummaryConfig

export type TimelineConfig = {
  enabled: boolean
  /** Empty → `~/.local/share/opencode/logs/cache-hit`. Supports `~/…` expansion. */
  dir: string
  flushIncomplete: boolean
  logSummaryMessages: boolean
  maxMemoryRows: number
  /** 0 = unlimited; after each append keep only the last N lines in the active file */
  maxLinesPerFile: number
  /** 0 = off; when active file reaches this size (bytes), roll to `.jsonl.1` before append */
  rotateMaxBytes: number
  /** How many rotated backups to keep (`file.jsonl.1` … `.N`); 0 = delete on roll */
  retainRotated: number
  /** 0 = off; delete `*.jsonl*` in log dir older than N days (on collector start) */
  maxAgeDays: number
  /** 0 = unlimited; max number of `*.jsonl*` files in log dir (oldest mtime deleted first) */
  maxLogFiles: number
  /**
   * Controls whether tool summaries (privacy-sensitive hints from tool input)
   * are recorded in JSONL `toolDurations[].summary`.
   *
   * - `true`  → all tools record summaries
   * - `false` → no summaries; only `tool` + `durationMs` are recorded
   * - `{ allTools, bash?, read?, ... }` → per-tool control
   *
   * Default `{ allTools: true, bash: false }`: secure-by-default — bash commands
   * may contain credentials, tokens, or file paths and are only truncated, not sanitized.
   */
  toolSummary: ToolSummarySetting
}

export const DEFAULT_TIMELINE: TimelineConfig = {
  enabled: false,
  dir: "",
  flushIncomplete: false,
  logSummaryMessages: true,
  maxMemoryRows: 50,
  maxLinesPerFile: 0,
  rotateMaxBytes: 0,
  retainRotated: 5,
  maxAgeDays: 0,
  maxLogFiles: 0,
  // Secure-by-default: bash summaries may leak credentials/tokens (only truncated, not sanitized).
  toolSummary: { allTools: true, bash: false },
}

export type CacheTTLConfig = {
  enabled: boolean
  /** TTL per provider (or provider:model). Values like "5m", "1h", "30s". Falls back to built-in defaults. */
  providers: Record<string, string>
}

export const DEFAULT_CACHE_TTL: CacheTTLConfig = {
  enabled: true,
  providers: {},
}

export type PluginConfig = {
  cost: CostDisplayConfig
  display: DisplayConfig
  timeline: TimelineConfig
  cacheTTL: CacheTTLConfig
  /** Dynamic pricing: time-of-day (peak/offpeak) and context tiers (context_over_200k). */
  dynamicPricing: DynamicPricingConfig
}

export const DEFAULT_PLUGIN_CONFIG: PluginConfig = {
  cost: { ...DEFAULT_COST_DISPLAY },
  display: { ...DEFAULT_DISPLAY },
  timeline: { ...DEFAULT_TIMELINE },
  cacheTTL: { ...DEFAULT_CACHE_TTL },
  dynamicPricing: structuredClone(DEFAULT_DYNAMIC_PRICING),
}

const TOOL_SUMMARY_KEYS: ReadonlySet<string> = new Set([
  "allTools", "bash", "read", "write", "edit",
  "grep", "glob", "webfetch", "websearch", "task", "question",
])

function parseToolSummarySetting(raw: unknown): ToolSummarySetting {
  if (typeof raw === "boolean") return raw
  if (!raw || typeof raw !== "object") return true
  const o = raw as Record<string, unknown>
  const result: ToolSummaryConfig = { allTools: true }
  if (typeof o.allTools === "boolean") result.allTools = o.allTools
  for (const key of TOOL_SUMMARY_KEYS) {
    if (key === "allTools") continue
    if (typeof o[key] === "boolean") {
      ;(result as Record<string, boolean>)[key] = o[key] as boolean
    }
  }
  return result
}

export function isToolSummaryEnabled(setting: ToolSummarySetting, tool: string): boolean {
  if (typeof setting === "boolean") return setting
  const override = (setting as Record<string, boolean | undefined>)[tool]
  if (typeof override === "boolean") return override
  return setting.allTools
}

export function normalizeTimelineConfig(raw: unknown): TimelineConfig {
  const t = structuredClone(DEFAULT_TIMELINE)
  if (!raw || typeof raw !== "object") return t
  const o = raw as Record<string, unknown>
  if (typeof o.enabled === "boolean") t.enabled = o.enabled
  if (typeof o.dir === "string") t.dir = o.dir
  if (typeof o.flushIncomplete === "boolean") t.flushIncomplete = o.flushIncomplete
  if (typeof o.logSummaryMessages === "boolean") t.logSummaryMessages = o.logSummaryMessages
  if (typeof o.maxMemoryRows === "number" && o.maxMemoryRows > 0) {
    t.maxMemoryRows = Math.floor(o.maxMemoryRows)
  }
  if (typeof o.maxLinesPerFile === "number" && o.maxLinesPerFile >= 0) {
    t.maxLinesPerFile = Math.floor(o.maxLinesPerFile)
  }
  if (typeof o.rotateMaxBytes === "number" && o.rotateMaxBytes >= 0) {
    t.rotateMaxBytes = Math.floor(o.rotateMaxBytes)
  }
  if (typeof o.retainRotated === "number" && o.retainRotated >= 0) {
    t.retainRotated = Math.floor(o.retainRotated)
  }
  if (typeof o.maxAgeDays === "number" && o.maxAgeDays >= 0) {
    t.maxAgeDays = Math.floor(o.maxAgeDays)
  }
  if (typeof o.maxLogFiles === "number" && o.maxLogFiles >= 0) {
    t.maxLogFiles = Math.floor(o.maxLogFiles)
  }
  if (o.toolSummary !== undefined) {
    t.toolSummary = parseToolSummarySetting(o.toolSummary)
  }
  return t
}

export function normalizeDisplayConfig(raw: unknown): DisplayConfig {
  const d = structuredClone(DEFAULT_DISPLAY)
  if (!raw || typeof raw !== "object") return d
  const o = raw as Record<string, unknown>
  if (typeof o.lang === "string") {
    d.lang = o.lang === "auto" ? "auto" : resolveLang(o.lang)
  }
  if (typeof o.mainHitLabel === "string" && o.mainHitLabel.length > 0) d.mainHitLabel = o.mainHitLabel
  if (typeof o.panelBorder === "boolean") d.panelBorder = o.panelBorder
  else if (typeof o.agentsBorder === "boolean") d.panelBorder = o.agentsBorder
  if (typeof o.showSpeed === "boolean") d.showSpeed = o.showSpeed
  if (typeof o.speedUnit === "string") {
    const v = o.speedUnit.toLowerCase()
    if (v === "tps" || v === "tpot") d.speedUnit = v
  }
  return d
}

export function normalizeCacheTTLConfig(raw: unknown): CacheTTLConfig {
  const t = structuredClone(DEFAULT_CACHE_TTL)
  if (!raw || typeof raw !== "object") return t
  const o = raw as Record<string, unknown>
  if (typeof o.enabled === "boolean") t.enabled = o.enabled
  if (o.providers && typeof o.providers === "object") {
    const providers = o.providers as Record<string, unknown>
    for (const [key, value] of Object.entries(providers)) {
      if (typeof value === "string") {
        t.providers[key] = value
      }
    }
  }
  return t
}

const TIME_UNITS: Record<string, number> = {
  s: 1000,
  sec: 1000,
  second: 1000,
  seconds: 1000,
  m: 60_000,
  min: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
}

export function parseDuration(raw: string): number | null {
  const match = raw.trim().match(/^(\d+(?:\.\d+)?)\s*([a-z]+)$/i)
  if (!match) {
    const num = Number(raw)
    return Number.isFinite(num) && num > 0 ? Math.floor(num) : null
  }
  const value = Number(match[1])
  const unit = match[2].toLowerCase()
  const multiplier = TIME_UNITS[unit]
  if (!multiplier || !Number.isFinite(value) || value <= 0) return null
  return Math.floor(value * multiplier)
}

function normalizeModelPricingRule(raw: unknown): ModelPricingRule {
  const rule: ModelPricingRule = {}
  if (!raw || typeof raw !== "object") return rule
  const o = raw as Record<string, unknown>
  if (typeof o.currency === "string" && o.currency.toUpperCase() in CURRENCY_PRESETS) {
    rule.currency = o.currency.toUpperCase()
  }
  if (typeof o.rate === "number" && Number.isFinite(o.rate) && o.rate > 0) {
    rule.rate = o.rate
  }
  const levels = o.levels
  if (levels && typeof levels === "object") {
    const out: Record<string, { input: number; output: number; cache: { read: number; write: number } }> = {}
    for (const [level, v] of Object.entries(levels as Record<string, unknown>)) {
      const lv = v as Record<string, unknown> | undefined
      if (!lv || typeof lv !== "object") continue
      const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0)
      // Accept both shapes: flat cacheRead/cacheWrite (docs/example) and nested cache:{read,write} (ModelCost type).
      const nestCache = lv.cache as { read?: unknown; write?: unknown } | undefined
      out[level] = {
        input: num(lv.input),
        output: num(lv.output),
        cache: {
          read: num(lv.cacheRead ?? lv.cache_read ?? nestCache?.read),
          write: num(lv.cacheWrite ?? lv.cache_write ?? nestCache?.write),
        },
      }
    }
    if (Object.keys(out).length > 0) rule.levels = out
  }
  const multipliers = o.multipliers
  if (multipliers && typeof multipliers === "object") {
    const out: Record<string, number> = {}
    for (const [level, v] of Object.entries(multipliers as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v) && v > 0) out[level] = v
    }
    if (Object.keys(out).length > 0) rule.multipliers = out
  }
  if (typeof o.contextThreshold === "number" && Number.isFinite(o.contextThreshold) && o.contextThreshold > 0) {
    rule.contextThreshold = Math.floor(o.contextThreshold)
  }
  return rule
}

/** Parse `days` (ISO 1=Monday…7=Sunday): filter invalid values with a warning, dedupe, sort; empty/invalid result = every day (omitted). */
function normalizeDays(raw: unknown): number[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const seen = new Set<number>()
  for (const v of raw) {
    if (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 7) {
      seen.add(v)
    } else {
      console.warn(
        `dynamicPricing: ignoring invalid schedule days value ${JSON.stringify(v)}` +
          " (expected integer 1..7, ISO 1=Monday … 7=Sunday)",
      )
    }
  }
  return seen.size > 0 ? [...seen].sort() : undefined
}

function normalizeSchedule(raw: unknown): DynamicPricingSchedule {
  if (!Array.isArray(raw)) return structuredClone(DEFAULT_DYNAMIC_PRICING.schedule)
  const out: DynamicPricingSchedule = []
  for (const item of raw) {
    const o = item as Record<string, unknown> | undefined
    if (!o || typeof o !== "object") continue
    if (typeof o.level !== "string" || !Array.isArray(o.windows)) continue
    // A level with explicit empty windows is the catch-all fallback.
    if (o.windows.length === 0) {
      out.push({ level: o.level, windows: [] })
      continue
    }
    const windows = o.windows
      .map((w) => {
        const ww = w as Record<string, unknown> | undefined
        if (!ww || typeof ww !== "object") return null
        const start = typeof ww.start === "string" ? parseClockTime(ww.start) : null
        const end = typeof ww.end === "string" ? parseClockTime(ww.end) : null
        if (start === null || end === null) return null
        const days = normalizeDays(ww.days)
        return days ? { start, end, days } : { start, end }
      })
      .filter((w): w is TimeWindow => w !== null)
    // All windows invalid → drop the level (matches legacy behavior; a typo'd config must not silently become a fallback).
    if (windows.length > 0) out.push({ level: o.level, windows })
  }
  // At most one fallback (contract: types.ts ScheduleLevel): truncate extra empty-windows levels; windowed levels keep their order.
  const windowed = out.filter((l) => l.windows.length > 0)
  const fallbacks = out.filter((l) => l.windows.length === 0)
  if (fallbacks.length > 1) {
    console.warn(
      "dynamicPricing: schedule has more than one fallback level (level with empty windows); " +
        "keeping only the first as the catch-all",
    )
  }
  const merged = [...windowed, ...fallbacks.slice(0, 1)]
  return merged.length > 0 ? merged : structuredClone(DEFAULT_DYNAMIC_PRICING.schedule)
}

export function normalizeDynamicPricingConfig(
  raw: unknown,
  opts?: { usdRate?: number; displayCurrency?: string },
): DynamicPricingConfig {
  const d = structuredClone(DEFAULT_DYNAMIC_PRICING)
  if (!raw || typeof raw !== "object") return d
  const o = raw as Record<string, unknown>
  if (typeof o.enabled === "boolean") d.enabled = o.enabled
  if (typeof o.timezone === "string" && o.timezone.length > 0) d.timezone = o.timezone
  if (o.schedule !== undefined) d.schedule = normalizeSchedule(o.schedule)
  if (typeof o.contextThreshold === "number" && Number.isFinite(o.contextThreshold) && o.contextThreshold > 0) {
    d.contextThreshold = Math.floor(o.contextThreshold)
  }
  if (o.providers && typeof o.providers === "object") {
    const providers: DynamicPricingConfig["providers"] = {}
    for (const [pid, pv] of Object.entries(o.providers as Record<string, unknown>)) {
      const po = pv as Record<string, unknown> | undefined
      if (!po || typeof po !== "object") continue
      const modelsRaw = po.models
      if (!modelsRaw || typeof modelsRaw !== "object") continue
      const models: Record<string, ModelPricingRule> = {}
      for (const [mid, mv] of Object.entries(modelsRaw as Record<string, unknown>)) {
        const rule = normalizeModelPricingRule(mv)
        // Non-USD absolute levels are converted to internal USD at load; lookup always computes in USD.
        // Rate (USD → levels currency) priority: rule.rate > cost.rate when the levels currency
        // equals the display currency > warn and treat as USD when undeterminable (avoids converting
        // with a wrong display rate, e.g. dividing EUR by USD→CNY).
        if (rule.levels && rule.currency && rule.currency !== "USD") {
          let usdPerLevel: number | undefined = rule.rate
          if (usdPerLevel === undefined && rule.currency === opts?.displayCurrency && opts?.usdRate && opts.usdRate > 0) {
            usdPerLevel = opts.usdRate
          }
          if (usdPerLevel === undefined || usdPerLevel <= 0) {
            console.error(
              `dynamicPricing: cannot convert ${rule.currency} levels to USD for ${pid}/${mid} — ` +
                `set "rate" (USD→${rule.currency}) or use cost.currency = ${rule.currency}; treating values as USD`,
            )
          } else {
            for (const [level, rates] of Object.entries(rule.levels)) {
              rule.levels[level] = {
                input: rates.input / usdPerLevel,
                output: rates.output / usdPerLevel,
                cache: { read: rates.cache.read / usdPerLevel, write: rates.cache.write / usdPerLevel },
              }
            }
            delete rule.currency
          }
        }
        if (Object.keys(rule).length > 0) models[mid] = rule
      }
      if (Object.keys(models).length > 0) providers[pid] = { models }
    }
    if (Object.keys(providers).length > 0) d.providers = providers
  }
  return d
}

export function normalizePluginConfig(raw: unknown): PluginConfig {
  if (!raw || typeof raw !== "object") return structuredClone(DEFAULT_PLUGIN_CONFIG)
  const o = raw as Record<string, unknown>
  const cost = normalizeCostDisplay(raw)
  const displayRaw = o.display
  // Non-USD absolute levels are converted to internal USD at the display rate. Usable
  // rates: per-model rule.rate (USD → levels currency); or cost.rate when the levels
  // currency equals the display currency. When the display is USD but levels are CNY
  // etc., the two don't match — a per-model rate must be configured explicitly.
  const usdRate =
    cost.currency === "USD" ? (DEFAULT_COST_DISPLAY.rate ?? 6.77) : resolveExchangeRate(cost)
  return {
    cost,
    display: normalizeDisplayConfig(displayRaw),
    timeline: normalizeTimelineConfig(o.timeline),
    cacheTTL: normalizeCacheTTLConfig(o.cacheTTL),
    dynamicPricing: normalizeDynamicPricingConfig(o.dynamicPricing, {
      usdRate,
      displayCurrency: cost.currency,
    }),
  }
}
