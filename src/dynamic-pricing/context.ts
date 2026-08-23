import type { ModelCost } from "../types.ts"

/**
 * Context tier: contextTokens above threshold returns the tiered price, else base.
 * threshold prefers the model's own tier size (`cost.contextThreshold`, from runtime tier.size).
 */
export function selectContextRates(
  cost: ModelCost,
  contextTokens: number | undefined,
  threshold = 200_000,
): ModelCost {
  if (!cost.context_over_200k) return cost
  if (contextTokens === undefined) return cost
  const eff = cost.contextThreshold ?? threshold
  return contextTokens > eff ? cost.context_over_200k : cost
}

type RuntimeTier = {
  input: number
  output: number
  cache: { read: number; write: number }
  tier?: { type: "context"; size: number }
}

/**
 * Runtime cost (`api.state.provider`) → plugin ModelCost.
 * opencode converts config-level context_over_200k into `tiers[]` / `experimentalOver200K`
 * at runtime; here we normalize back to plugin fields (including the tier size).
 * Idempotent when the config-level fields already exist.
 */
export function normalizeRuntimeCost(cost: ModelCost): ModelCost {
  if (cost.context_over_200k) return cost
  const raw = cost as ModelCost & {
    tiers?: RuntimeTier[]
    experimentalOver200K?: ModelCost
  }
  if (raw.experimentalOver200K) {
    return { ...cost, context_over_200k: raw.experimentalOver200K, contextThreshold: 200_000 }
  }
  const tier = raw.tiers?.find((t) => t.tier?.type === "context")
  if (tier) {
    return {
      ...cost,
      context_over_200k: {
        input: tier.input,
        output: tier.output,
        cache: { read: tier.cache?.read ?? 0, write: tier.cache?.write ?? 0 },
      },
      contextThreshold: tier.tier?.size ?? 200_000,
    }
  }
  return cost
}

/** Scale all rates by a factor (multiplier mode). Factor 1 returns rates unchanged. */
export function scaleRates(cost: ModelCost, factor: number): ModelCost {
  if (factor === 1) return cost
  return {
    input: cost.input * factor,
    output: cost.output * factor,
    cache: { read: cost.cache.read * factor, write: cost.cache.write * factor },
    context_over_200k: cost.context_over_200k
      ? {
          input: cost.context_over_200k.input * factor,
          output: cost.context_over_200k.output * factor,
          cache: {
            read: cost.context_over_200k.cache.read * factor,
            write: cost.context_over_200k.cache.write * factor,
          },
        }
      : undefined,
  }
}

/**
 * Usage → cost (USD). `input` is cache-miss input tokens (excludes cache, matching
 * opencode semantics); cache hits are billed separately via cacheReadRate × `cacheRead`.
 */
export function billingCost(
  rates: ModelCost,
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
): number {
  return (
    (input * rates.input +
      output * rates.output +
      cacheRead * rates.cache.read +
      cacheWrite * rates.cache.write) /
    1_000_000
  )
}
