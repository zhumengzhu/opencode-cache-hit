import type { ProviderInfo, SubAgentSummary } from "../types.ts"
import { billingCost } from "./context.ts"
import { resolveModelCost } from "./lookup.ts"
import type { DynamicPricingConfig } from "./types.ts"

/**
 * Sub-agent cost recompute: aggregate tokens + session creation time (`sub.created`)
 * as a per-message approximation. No created or unpriced model → null (caller falls
 * back to msg.cost rather than guessing a level).
 */
export function recomputeSubAgentCost(
  sub: SubAgentSummary,
  providers: ReadonlyArray<ProviderInfo>,
  rules: DynamicPricingConfig | undefined,
): number | null {
  // No creation time → cannot price by level; caller falls back to msg.cost.
  if (sub.created === undefined) return null
  const input = sub.input
  const output = sub.output
  const cacheRead = sub.cacheRead
  const cacheWrite = sub.cacheWrite
  if (input + output + cacheRead + cacheWrite === 0) return null
  const resolved = resolveModelCost(providers, sub.providerID, sub.model, {
    now: sub.created,
    contextTokens: input + cacheRead,
    rules,
  })
  if (!resolved) return null
  return resolved.explicit ? billingCost(resolved.rates, input, output, cacheRead, cacheWrite) : null
}

/**
 * Offline recompute for timeline records: by record time (`created`) + context tier.
 * Without providerId, match modelId across providers; unpriced → null.
 */
export function recomputeRecordCost(
  record: {
    modelId?: string
    providerId?: string
    created?: string
    input?: number
    output?: number
    cacheRead?: number
    cacheWrite?: number
  },
  providers: ReadonlyArray<ProviderInfo>,
  rules: DynamicPricingConfig | undefined,
): number | null {
  const modelId = record.modelId ?? ""
  if (!modelId) return null
  const created = record.created ? Date.parse(record.created) : undefined
  if (!Number.isFinite(created ?? 0)) return null
  const input = record.input ?? 0
  const output = record.output ?? 0
  const cacheRead = record.cacheRead ?? 0
  const cacheWrite = record.cacheWrite ?? 0
  if (input + output + cacheRead + cacheWrite === 0) return null

  const byId = record.providerId
    ? resolveModelCost(providers, record.providerId, modelId, {
        now: created,
        contextTokens: input + cacheRead,
        rules,
      })
    : null
  const resolved =
    byId ??
    (() => {
      for (const p of providers) {
        if (!p.models[modelId]) continue
        const r = resolveModelCost(providers, p.id, modelId, {
          now: created,
          contextTokens: input + cacheRead,
          rules,
        })
        if (r) return r
      }
      return null
    })()
  if (!resolved) return null
  return resolved.explicit ? billingCost(resolved.rates, input, output, cacheRead, cacheWrite) : null
}
