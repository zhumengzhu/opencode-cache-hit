import type { ModelCost, ProviderInfo } from "../types.ts"
import { normalizeRuntimeCost, selectContextRates, scaleRates } from "./context.ts"
import { DEEPSEEK_DEFAULT_RULE, isDeepSeek } from "./deepseek.ts"
import { isLevelAt } from "./schedule.ts"
import { type DynamicPricingConfig, type ModelPricingRule } from "./types.ts"

/** Static price lookup: providerID + modelID → ModelCost (runtime tiers normalized); miss returns null. */
export function lookupModelCost(
  providers: ReadonlyArray<ProviderInfo>,
  providerID: string | undefined,
  modelID: string | undefined,
): ModelCost | null {
  if (!providerID || !modelID) return null
  for (const p of providers) {
    if (p.id !== providerID) continue
    const model = p.models[modelID]
    return model?.cost ? normalizeRuntimeCost(model.cost) : null
  }
  return null
}

export type PricingLookupContext = {
  now?: number
  contextTokens?: number
  rules?: DynamicPricingConfig
}

export type ResolvedPricing = {
  rates: ModelCost
  /** Matched time-of-day level (e.g. "peak"/"offpeak"); undefined when no time-of-day rule applies. */
  level?: string
  /** Context tier: base "base" or over-threshold "over"; undefined when the model has no tiers. */
  contextTier?: "base" | "over"
  /** Whether dynamic rules applied (explicit config / built-in DeepSeek default). */
  explicit: boolean
}

/** providerID/modelID already warned about a DeepSeek schedule without days (once per config lifetime). */
const warnedNoWeekday = new Set<string>()

/**
 * DeepSeek model whose schedule has windowed levels but none with `days` → one-time
 * stderr hint (informational only, does not change billing). Legacy configs (peak
 * without days) still bill weekends as peak; add `days:[1,2,3,4,5]` to fix.
 */
function maybeWarnDeepSeekWeekend(rules: DynamicPricingConfig | undefined, providerID: string, modelID: string): void {
  if (!rules?.enabled || !isDeepSeek(providerID, modelID)) return
  const hasWindowed = rules.schedule.some((l) => l.windows.length > 0)
  const hasDays = rules.schedule.some((l) => l.windows.some((w) => w.days && w.days.length > 0))
  if (!(hasWindowed && !hasDays)) return
  const key = `${providerID}/${modelID}`
  if (warnedNoWeekday.has(key)) return
  warnedNoWeekday.add(key)
  console.warn(
    `[dynamicPricing] ${key} schedule is not weekday-aware — weekends 9:00-12:00/14:00-18:00 may still bill at peak. ` +
      `Add "days":[1,2,3,4,5] to the peak windows to match DeepSeek's weekend off-peak pricing.`,
  )
}

function effectiveRule(
  rules: DynamicPricingConfig | undefined,
  providerID: string,
  modelID: string,
): ModelPricingRule | undefined {
  // Master switch off → fully static (explicit rules, built-in default, context tiers all inactive).
  if (!rules?.enabled) return undefined
  const explicit = rules.providers[providerID]?.models[modelID]
  if (explicit) return explicit
  // Empty schedule → nothing to match; skip the built-in default (avoids a spurious ≈ marker).
  if (rules.schedule.length > 0 && isDeepSeek(providerID, modelID)) {
    return DEEPSEEK_DEFAULT_RULE
  }
  return undefined
}

function resolveLevel(now: number, rules: DynamicPricingConfig | undefined): string | undefined {
  if (!rules?.enabled) return undefined
  const tz = rules.timezone || "UTC"
  return isLevelAt(now, rules.schedule, tz)
}

function tierOf(cost: ModelCost, tokens: number | undefined, threshold: number): "base" | "over" | undefined {
  if (!cost.context_over_200k || tokens === undefined) return undefined
  const eff = cost.contextThreshold ?? threshold
  return tokens > eff ? "over" : "base"
}

/**
 * Resolve the model's current effective price. Priority:
 * 1. explicit `levels` absolute prices (per level; miss falls back to static) → 2. explicit `multipliers`
 * → 3. built-in DeepSeek default multipliers → 4. `state.provider` static price (with context tiers).
 * `enabled: false` turns off every dynamic dimension and returns the static base price.
 */
export function resolveModelCost(
  providers: ReadonlyArray<ProviderInfo>,
  providerID: string,
  modelID: string,
  ctx: PricingLookupContext = {},
): ResolvedPricing | null {
  const base = lookupModelCost(providers, providerID, modelID)
  if (!base) return null
  // Master switch off → fully static base price (context tiers off too), matching the README.
  if (ctx.rules && !ctx.rules.enabled) return { rates: base, explicit: false }
  const now = ctx.now ?? Date.now()
  const rules = ctx.rules
  const level = resolveLevel(now, rules)
  maybeWarnDeepSeekWeekend(rules, providerID, modelID)
  const rule = effectiveRule(rules, providerID, modelID)
  // Tier threshold priority: per-model rule.contextThreshold > runtime tier.size
  // (cost.contextThreshold) > global contextThreshold > 200k. Unified onto base so
  // tierOf and selectContextRates stay consistent.
  const effThreshold =
    rule?.contextThreshold ?? base.contextThreshold ?? rules?.contextThreshold ?? 200_000
  const effBase = base.contextThreshold === effThreshold ? base : { ...base, contextThreshold: effThreshold }
  const contextTier = tierOf(effBase, ctx.contextTokens, effThreshold)

  if (rule?.levels) {
    const absolute = level ? rule.levels[level] : undefined
    if (absolute) {
      // Absolute prices are complete (no context-tier semantics) → no context badge, avoids misleading.
      return { rates: absolute, level, contextTier: undefined, explicit: true }
    }
    // Level miss (custom schedule doesn't cover now / level name mismatch) → static price, never pick the first level arbitrarily.
    return { rates: selectContextRates(effBase, ctx.contextTokens, effThreshold), level: undefined, contextTier, explicit: true }
  }
  if (rule?.multipliers) {
    const factor = level ? rule.multipliers[level] ?? 1 : 1
    // Badge only when multipliers price the current level (e.g. a peak-only rule at an off-peak moment prices 1× full; no off-peak badge).
    const levelShown = level !== undefined && rule.multipliers[level] !== undefined
    return { rates: scaleRates(selectContextRates(effBase, ctx.contextTokens, effThreshold), factor), level: levelShown ? level : undefined, contextTier, explicit: true }
  }
  // Report the level only when the model is actually time-of-day priced (explicit
  // levels/multipliers or the built-in DeepSeek default); rule-less or
  // contextThreshold-only models get no level badge (the default fallback would
  // otherwise label static models off-peak/peak).
  const levelAware = rule?.levels !== undefined || rule?.multipliers !== undefined
  return { rates: selectContextRates(effBase, ctx.contextTokens, effThreshold), level: levelAware ? level : undefined, contextTier, explicit: rule !== undefined }
}
