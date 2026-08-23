import type { AssistantMessage, ProviderInfo, SubAgentSummary } from "../types.ts"
import { billingCost } from "./context.ts"
import { resolveModelCost } from "./lookup.ts"
import type { DynamicPricingConfig } from "./types.ts"

export type RecomputeResult = {
  /** Total cost recomputed per message (request time + context size), in USD. */
  cost: number
  /** Number of messages included (have tokens and a price). */
  counted: number
  /** Whether any message applied dynamic rules (time-of-day / context tier / multipliers). */
  dynamic: boolean
}

const EMPTY_RESULT: RecomputeResult = { cost: 0, counted: 0, dynamic: false }

/**
 * Recompute session cost message by message:
 * - time-of-day: `msg.time.created` (request start) → level
 * - context: total input (`input + cacheRead`; opencode semantics: input excludes cache) → context_over_200k tier
 * - usage: input / output / cache.read / cache.write (input is the cache-miss part; cache billed separately)
 * Messages that cannot be priced (no tokens or no model price) are skipped. Nothing priceable → null.
 */
export function recomputeSessionCost(
  messages: ReadonlyArray<AssistantMessage>,
  providers: ReadonlyArray<ProviderInfo>,
  rules: DynamicPricingConfig | undefined,
): RecomputeResult | null {
  if (!messages.length) return null
  let cost = 0
  let counted = 0
  let dynamic = false
  for (const msg of messages) {
    const tokens = msg.tokens
    if (!tokens) continue
    const input = tokens.input ?? 0
    const output = tokens.output ?? 0
    const cacheRead = tokens.cache?.read ?? 0
    const cacheWrite = tokens.cache?.write ?? 0
    if (input + output + cacheRead + cacheWrite === 0) continue
    const resolved = resolveModelCost(providers, msg.providerID ?? "", msg.modelID ?? "", {
      now: msg.time?.created,
      contextTokens: input + cacheRead,
      rules,
    })
    if (!resolved) continue
    cost += billingCost(resolved.rates, input, output, cacheRead, cacheWrite)
    counted += 1
    if (resolved.explicit) dynamic = true
  }
  if (counted === 0) return null
  return { cost, counted, dynamic }
}

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
