import type { ModelPricingRule } from "./types.ts"

/**
 * DeepSeek official time-of-day pricing: off-peak is half of peak.
 * The built-in default applies as multipliers relative to the `state.provider`
 * static price (static = peak); users can override with absolute prices.
 */
export const DEEPSEEK_DEFAULT_RULE: ModelPricingRule = {
  multipliers: { peak: 1, offpeak: 0.5 },
}

/** Whether providerID or modelID is the DeepSeek official namespace. */
export function isDeepSeek(providerID: string, modelID: string): boolean {
  const pid = providerID.toLowerCase()
  const mid = modelID.toLowerCase()
  // provider id contains "deepseek" (e.g. deepseek) or modelID starts with the official deepseek/ prefix.
  return pid.includes("deepseek") || mid.startsWith("deepseek/")
}
