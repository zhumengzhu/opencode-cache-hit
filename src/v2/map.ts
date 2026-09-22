/**
 * Pure V2 → V1 shape mapping. No Solid, no host APIs: unit-testable without a
 * running OpenCode 2 instance (`tests/v2-adapter.test.ts`).
 */
import type { AssistantMessage, ModelCost, ProviderInfo, SessionObject, StreamPart } from "../types.ts"
import type { V2ContentPart, V2Message, V2Model, V2ModelCostTier, V2Provider, V2Session } from "./types.ts"

/** V2 keeps role in `type` and embeds model ids; V1 reads flat fields. */
export function toAssistantMessage(row: V2Message, sessionID?: string): AssistantMessage & { sessionID?: string } {
  return {
    id: row.id,
    messageID: row.id,
    role: row.type === "assistant" ? "assistant" : row.type,
    agent: row.agent,
    modelID: row.model?.id,
    providerID: row.model?.providerID,
    cost: row.cost,
    // V2 models compaction as its own message type; V1 has a `summary` flag.
    summary: row.type === "compaction" ? true : undefined,
    finish: row.finish,
    time: row.time,
    tokens: row.tokens
      ? {
          input: row.tokens.input,
          output: row.tokens.output,
          reasoning: row.tokens.reasoning,
          cache: { read: row.tokens.cache?.read ?? 0, write: row.tokens.cache?.write ?? 0 },
        }
      : undefined,
    sessionID,
  }
}

/** `api.state.session.get()` shape. Undefined input stays undefined (V1 optional call). */
export function toSessionObject(row: V2Session | undefined): SessionObject | undefined {
  if (!row) return undefined
  return {
    model: row.model ? { id: row.model.id, providerID: row.model.providerID } : undefined,
    cost: row.cost,
    tokens: row.tokens,
    parentID: row.parentID,
  }
}

/** V2 splits providers and models; V1 nests `models[id].cost` under the provider. */
export function toProviderInfos(
  providers: ReadonlyArray<V2Provider> | undefined,
  models: ReadonlyArray<V2Model> | undefined,
): ProviderInfo[] {
  const byProvider = new Map<string, Record<string, { cost: ModelCost }>>()
  for (const model of models ?? []) {
    const cost = toModelCost(model.cost)
    if (!cost) continue
    const bucket = byProvider.get(model.providerID) ?? {}
    bucket[model.id] = { cost }
    byProvider.set(model.providerID, bucket)
  }
  return (providers ?? []).map((provider) => ({
    id: provider.id,
    models: byProvider.get(provider.id) ?? {},
  }))
}

/**
 * V2 ships cost as a base entry plus optional `tier` entries; the V1 runtime
 * exposed base + `tiers`/`experimentalOver200K`, which the plugin normalizes
 * back. Emit the normalized V1 form directly (`context_over_200k` +
 * `contextThreshold`) so `normalizeRuntimeCost` is a no-op for V2 data.
 */
export function toModelCost(entries: ReadonlyArray<V2ModelCostTier> | undefined): ModelCost | null {
  if (!Array.isArray(entries) || entries.length === 0) return null
  const base = entries.find((entry) => !entry.tier) ?? entries[0]
  if (!base) return null
  const cost: ModelCost = {
    input: base.input ?? 0,
    output: base.output ?? 0,
    cache: { read: base.cache?.read ?? 0, write: base.cache?.write ?? 0 },
  }
  const tier = entries.find((entry) => entry.tier?.type === "context")
  if (tier) {
    cost.context_over_200k = {
      input: tier.input ?? 0,
      output: tier.output ?? 0,
      cache: { read: tier.cache?.read ?? 0, write: tier.cache?.write ?? 0 },
    }
    cost.contextThreshold = tier.tier?.size ?? 200_000
  }
  return cost
}

/**
 * V2 theme tokens are nested and semantic; V1's palette reads flat keys.
 * Missing keys fall back inside `buildPanelPalette`, so partial is safe.
 */
export function toThemeRecord(theme: unknown): Record<string, unknown> {
  const t = theme as
    | {
        text?: {
          base?: unknown
          muted?: unknown
          action?: Record<string, { base?: unknown }>
          feedback?: Record<string, { base?: unknown }>
        }
        border?: { base?: unknown }
      }
    | undefined
  return {
    primary: t?.text?.action?.primary?.base,
    text: t?.text?.base,
    textMuted: t?.text?.muted,
    success: t?.text?.feedback?.success?.base,
    warning: t?.text?.feedback?.warning?.base,
    error: t?.text?.feedback?.error?.base,
    border: t?.border?.base,
  }
}

/**
 * Part timestamps from a stored message. V2 text parts carry no time (the live
 * `session.text.started` event is the only source), reasoning/tool parts do.
 */
export function streamPartsFromContent(content: ReadonlyArray<V2ContentPart> | undefined): StreamPart[] {
  const parts: StreamPart[] = []
  for (const part of content ?? []) {
    if (part.type !== "text" && part.type !== "reasoning" && part.type !== "tool") continue
    const start = part.time?.created
    if (typeof start !== "number") continue
    parts.push({ type: part.type, time: { start } })
  }
  return parts
}
