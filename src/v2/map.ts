/**
 * Pure V2 → internal shape mapping. No Solid, no host APIs: unit-testable
 * without a running OpenCode 2 instance (`tests/v2-adapter.test.ts`).
 */
import type { AssistantMessage, ModelCost, ProviderInfo, SessionObject, StreamPart } from "../types.ts"
import type {
  V2ContentPart,
  V2Event,
  V2Message,
  V2Model,
  V2ModelCostTier,
  V2ModelRef,
  V2Provider,
  V2Session,
} from "./types.ts"

/** Step identity V2 reports on `session.step.*` rather than on the message. */
export type StepMeta = { agent?: string; model?: V2ModelRef; started?: number }

/**
 * The contract's `time` requires `created`, and V2 rows may omit it while
 * carrying other fields (`streamed`). Those are dropped: every consumer reads
 * `time.created`, so passing a `created`-less object through would just move the
 * lie downstream.
 */
export function toMessageTime(time: V2Message["time"]): AssistantMessage["time"] {
  if (typeof time?.created !== "number") return undefined
  return { created: time.created, completed: time.completed }
}

/** V2 keeps role in `type` and embeds model ids; the contract reads flat fields. */
export function toAssistantMessage(row: V2Message, sessionID?: string): AssistantMessage {
  return {
    id: row.id,
    messageID: row.id,
    // V2 models compaction as its own message type; the contract keeps it an
    // assistant message flagged `summary`, so stats/timeline can skip it.
    role: row.type === "compaction" ? "assistant" : row.type,
    agent: row.agent,
    modelID: row.model?.id,
    providerID: row.model?.providerID,
    cost: row.cost,
    summary: row.type === "compaction" ? true : undefined,
    finish: row.finish,
    time: toMessageTime(row.time),
    tokens: row.tokens
      ? {
          input: row.tokens.input,
          output: row.tokens.output,
          reasoning: row.tokens.reasoning,
          cache: { read: row.tokens.cache.read, write: row.tokens.cache.write },
        }
      : undefined,
    sessionID,
  }
}

/**
 * One terminal `session.step.ended` / `session.step.failed` → the contract's
 * assistant message.
 *
 * The store row and the event are projections of the same durable step end, so
 * they agree whenever both are present. `??` only bridges delivery order: the
 * row is created at `step.started` without cost/tokens/finish, and the step end
 * writes them. The row stays the only source for `summary`; a compaction never
 * emits step events (it has its own `session.compaction.*` family), so a
 * synthesized message is never a compaction.
 */
export function stepMessage(input: {
  row: V2Message | undefined
  meta: StepMeta | undefined
  event: V2Event
  sessionID: string
  /** Applied when neither the row nor the event names a finish (`step.failed` → "error", as V2 projects it). */
  defaultFinish?: string
}): AssistantMessage {
  const info = input.row ? toAssistantMessage(input.row, input.sessionID) : undefined
  const messageID = input.event.data?.assistantMessageID ?? ""
  return {
    ...info,
    id: messageID,
    messageID,
    role: info?.role ?? "assistant",
    sessionID: input.sessionID,
    agent: info?.agent ?? input.meta?.agent,
    modelID: info?.modelID ?? input.meta?.model?.id,
    providerID: info?.providerID ?? input.meta?.model?.providerID,
    cost: info?.cost ?? input.event.data?.cost,
    finish: info?.finish ?? input.event.data?.finish ?? input.defaultFinish,
    tokens: info?.tokens ?? input.event.data?.tokens,
    // The step end is the durable completion; keep it when the store lags.
    time: {
      created: info?.time?.created ?? input.meta?.started ?? input.event.created ?? Date.now(),
      completed: input.event.created ?? info?.time?.completed,
    },
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

/** V2 splits providers and models; the contract nests `models[id].cost` under the provider. */
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
  const base = entries.find((entry) => !entry.tier)
  if (!base) return null
  const cost: ModelCost = {
    input: base.input,
    output: base.output,
    cache: { read: base.cache.read, write: base.cache.write },
  }
  const tier = entries.find((entry) => entry.tier?.type === "context")
  if (tier) {
    cost.context_over_200k = {
      input: tier.input,
      output: tier.output,
      cache: { read: tier.cache.read, write: tier.cache.write },
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
 * Timed parts rebuilt from a stored message row.
 *
 * Why this exists: a plugin hot reload (the local-directory dev loop, or a
 * plugin update mid-turn) tears down the sidebar host and the adapter, so the
 * live `part` events of an in-flight message are delivered to a destroyed
 * tracker while `step.ended` lands in the fresh one. The row keeps the timed
 * parts, so replaying them through the normal `part` path restores TTFT and
 * tool durations.
 *
 * Limits, on purpose:
 *  - only the first content part may seed TTFT. Text parts carry no `time` in
 *    the store, so a reply that opens with text has no recoverable TTFT: the
 *    next timed part starts later, and using it would report an inflated value.
 *    Tool durations are replayed from any position — they do not depend on
 *    which part came first;
 *  - an unclosed tool (no `time.completed`, e.g. the turn was interrupted) is
 *    replayed as `running`, never as completed: `tool-timing` would otherwise
 *    fabricate `Date.now() - start` as its duration;
 *  - a tool part needs both `id` and `name` (`handleToolPart` drops it
 *    otherwise);
 *  - `created` is required and each start must be later than it: `recordPart`
 *    does not reject a start that predates the message, so a bogus stamp from
 *    the store must never reach it.
 */
export function partsFromContent(
  content: ReadonlyArray<V2ContentPart> | undefined,
  created: number | undefined,
): StreamPart[] {
  if (typeof created !== "number") return []
  const list = content ?? []
  const parts: StreamPart[] = []
  for (let index = 0; index < list.length; index++) {
    const part = list[index]!
    const start = part.time?.created
    if (typeof start !== "number" || start <= created) continue
    if (part.type === "tool") {
      if (!part.id || !part.name) continue
      const end = part.time?.completed
      const closed = typeof end === "number" && end >= start
      parts.push({
        type: "tool",
        callID: part.id,
        tool: part.name,
        // Top-level `time` feeds the TTFT tracker; only the first part qualifies.
        ...(index === 0 ? { time: { start } } : {}),
        state: {
          status: closed ? (part.state?.status === "error" ? "error" : "completed") : "running",
          time: closed ? { start, end } : { start },
          input: part.state?.input,
        },
      })
      continue
    }
    if (index !== 0) continue
    if (part.type === "reasoning" || part.type === "text") {
      parts.push({ type: part.type, time: { start } })
    }
  }
  return parts
}
