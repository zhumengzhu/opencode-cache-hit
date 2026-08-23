import type { AssistantMessage, ModelCost, ProviderInfo, SubAgentSummary } from "./types.ts"
import type { DynamicPricingConfig } from "./dynamic-pricing/types.ts"
import { lookupModelCost, resolveModelCost } from "./dynamic-pricing/lookup.ts"
import { billingCost } from "./dynamic-pricing/context.ts"
import { isInteractiveAssistantMessage } from "./stats.ts"

export type { ModelCost } from "./types.ts"
export { lookupModelCost } from "./dynamic-pricing/lookup.ts"

export type PricingInfo = {
  inputRate: number
  outputRate: number
  cacheReadRate: number
  cacheWriteRate: number
  saved: number
  /** Matched time-of-day level (e.g. "peak"/"offpeak"); undefined when time-of-day rules are off. */
  level?: string
  /** Context tier: "base" or over-threshold "over"; undefined when the model has no tiers. */
  contextTier?: "base" | "over"
  /** Whether dynamic rules applied (user config / built-in DeepSeek default). */
  dynamic: boolean
}

export const EMPTY_PRICING: PricingInfo = {
  inputRate: 0,
  outputRate: 0,
  cacheReadRate: 0,
  cacheWriteRate: 0,
  saved: 0,
  dynamic: false,
}

export type SessionPricing = {
  cost: number
  readSavings: number
  writePremium: number
  netCacheValue: number
  counted: number
  unpriced: number
  dynamic: boolean
}

export const EMPTY_SESSION_PRICING: SessionPricing = {
  cost: 0,
  readSavings: 0,
  writePremium: 0,
  netCacheValue: 0,
  counted: 0,
  unpriced: 0,
  dynamic: false,
}

export type PricingContext = {
  /** Current time (ms) for time-of-day matching. Default Date.now(). */
  now?: number
  /** Context size (tokens) for context_over_200k tier selection. */
  contextTokens?: number
  /** Dynamic pricing config; when omitted, fully static pricing. */
  rules?: DynamicPricingConfig
}

export function computeSessionPricing(
  messages: readonly AssistantMessage[],
  providers: ReadonlyArray<ProviderInfo>,
  rules?: DynamicPricingConfig,
): SessionPricing {
  const result = { ...EMPTY_SESSION_PRICING }
  for (const message of messages) {
    if (message.role !== "assistant" || !isInteractiveAssistantMessage(message)) continue
    const tokens = message.tokens
    if (!tokens) {
      if ((message.cost ?? 0) !== 0) result.unpriced += 1
      continue
    }
    const input = tokens.input ?? 0
    const output = tokens.output ?? 0
    const cacheRead = tokens.cache?.read ?? 0
    const cacheWrite = tokens.cache?.write ?? 0
    if (input + output + cacheRead + cacheWrite === 0) {
      if ((message.cost ?? 0) !== 0) result.unpriced += 1
      continue
    }
    const resolved = resolveModelCost(providers, message.providerID ?? "", message.modelID ?? "", {
      now: message.time?.created,
      contextTokens: input + cacheRead,
      rules,
    })
    if (!resolved) {
      result.unpriced += 1
      continue
    }
    const rates = resolved.rates
    result.cost += billingCost(rates, input, output, cacheRead, cacheWrite)
    result.readSavings += (cacheRead * (rates.input - rates.cache.read)) / 1_000_000
    result.writePremium += (cacheWrite * (rates.cache.write - rates.input)) / 1_000_000
    result.counted += 1
    result.dynamic ||= resolved.explicit
  }
  result.netCacheValue = result.readSavings - result.writePremium
  return result
}

export function computePricing(
  providers: ReadonlyArray<ProviderInfo>,
  providerID: string | undefined,
  modelID: string | undefined,
  cacheRead: number,
  ctx: PricingContext = {},
): PricingInfo {
  const resolved = resolveModelCost(providers, providerID ?? "", modelID ?? "", {
    now: ctx.now,
    contextTokens: ctx.contextTokens,
    rules: ctx.rules,
  })
  if (!resolved) return EMPTY_PRICING
  const cost = resolved.rates
  const inputRate = cost.input
  const outputRate = cost.output
  const cacheReadRate = cost.cache.read
  const cacheWriteRate = cost.cache.write
  const saved =
    inputRate > cacheReadRate ? (cacheRead * (inputRate - cacheReadRate)) / 1_000_000 : 0
  return {
    inputRate,
    outputRate,
    cacheReadRate,
    cacheWriteRate,
    saved,
    level: resolved.level,
    contextTier: resolved.contextTier,
    dynamic: resolved.explicit,
  }
}

export function computeSubsSaved(
  subs: readonly SubAgentSummary[],
  providers: ReadonlyArray<ProviderInfo>,
  ctx: PricingContext = {},
): number {
  let total = 0
  for (const sub of subs) {
    const p = computePricing(providers, sub.providerID, sub.model, sub.cacheRead, {
      ...ctx,
      contextTokens: sub.input + sub.cacheRead,
    })
    total += p.saved
  }
  return total
}
