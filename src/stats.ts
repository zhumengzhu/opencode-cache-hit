import type { AssistantMessage, SessionObject, SessionSnapshot, SubAgentSummary } from "./types.ts"

export function mainSessionHasStats(main: SessionSnapshot): boolean {
  return (
    main.cacheRead > 0 ||
    main.cacheWrite > 0 ||
    main.cost > 0 ||
    main.input > 0 ||
    main.output > 0
  )
}

export function emptySessionSnapshot(): SessionSnapshot {
  return { model: "", providerID: "", input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
}

export function aggregateFromSessionObject(session: SessionObject): SessionSnapshot {
  const t = session.tokens
  const c = t?.cache
  return {
    model: session.model?.id ?? "",
    providerID: session.model?.providerID ?? "",
    input: t?.input ?? 0,
    output: t?.output ?? 0,
    reasoning: t?.reasoning ?? 0,
    cacheRead: c?.read ?? 0,
    cacheWrite: c?.write ?? 0,
    cost: session.cost ?? 0,
  }
}

export function aggregateSessionFromMessages(messages: readonly AssistantMessage[]): SessionSnapshot {
  let model = "",
    providerID = "",
    input = 0,
    output = 0,
    reasoning = 0,
    cacheRead = 0,
    cacheWrite = 0,
    cost = 0
  for (const msg of messages) {
    if (msg.role !== "assistant" || !isInteractiveAssistantMessage(msg)) continue
    const t = msg.tokens ?? {}
    input += t.input ?? 0
    output += t.output ?? 0
    reasoning += t.reasoning ?? 0
    cacheRead += t.cache?.read ?? 0
    cacheWrite += t.cache?.write ?? 0
    cost += msg.cost ?? 0
    if (msg.modelID) model = msg.modelID
    if (msg.providerID) providerID = msg.providerID
  }
  return { model, providerID, input, output, reasoning, cacheRead, cacheWrite, cost }
}

export function toSubAgentSummary(
  id: string,
  snap: SessionSnapshot,
  speed?: number,
  created?: number,
): SubAgentSummary {
  return {
    id,
    model: snap.model,
    providerID: snap.providerID,
    cost: snap.cost,
    input: snap.input,
    output: snap.output,
    reasoning: snap.reasoning,
    cacheRead: snap.cacheRead,
    cacheWrite: snap.cacheWrite,
    speed,
    created,
  }
}

export function aggregateSubAgents(subs: readonly SubAgentSummary[]): SessionSnapshot {
  const total = emptySessionSnapshot()
  for (const s of subs) {
    total.input += s.input
    total.output += s.output
    total.reasoning += s.reasoning
    total.cacheRead += s.cacheRead
    total.cacheWrite += s.cacheWrite
    total.cost += s.cost
  }
  return total
}

export function cacheHitRatio(cacheRead: number, input: number): number {
  const denom = cacheRead + input
  return denom > 0 ? cacheRead / denom : 0
}

export function subAgentHasStats(snap: SessionSnapshot): boolean {
  return (
    snap.cost > 0 ||
    snap.cacheRead > 0 ||
    snap.cacheWrite > 0 ||
    snap.input > 0 ||
    snap.output > 0 ||
    snap.reasoning > 0
  )
}

/**
 * Fill missing model / providerID from the last assistant message.
 * Session aggregates may have cost/tokens but lack model metadata;
 * this avoids losing pricing/display when session.get() is used.
 */
export function withModelFallback(
  snap: SessionSnapshot,
  messages: readonly AssistantMessage[],
): SessionSnapshot {
  if (snap.model && snap.providerID) return snap

  let model = snap.model
  let providerID = snap.providerID
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== "assistant") continue
    if (!model && m.modelID) model = m.modelID
    if (!providerID && m.providerID) providerID = m.providerID
    if (model && providerID) break
  }
  return model === snap.model && providerID === snap.providerID
    ? snap
    : { ...snap, model, providerID }
}

export function sidebarShouldShow(
  main: SessionSnapshot,
  subs: readonly SubAgentSummary[],
): boolean {
  return subs.length > 0 || mainSessionHasStats(main)
}

export type PerCallHitTrend = {
  hitPercent: number
  trendPercent: number
  hasTrend: boolean
  state: "steady" | "switch" | "warming"
}

export const UNKNOWN_LINEAGE_KEY = "unknown"

/** Assistant turns that represent an interactive, billable model call. */
export function isInteractiveAssistantMessage(msg: AssistantMessage): boolean {
  return msg.summary !== true && msg.agent !== "compaction"
}

export function messageLineageKey(msg: AssistantMessage): string {
  return msg.providerID && msg.modelID ? `${msg.providerID}:${msg.modelID}` : UNKNOWN_LINEAGE_KEY
}

export function compareAssistantMessages(a: AssistantMessage, b: AssistantMessage): number {
  const aCompleted = a.time?.completed ?? -Infinity
  const bCompleted = b.time?.completed ?? -Infinity
  if (aCompleted !== bCompleted) return aCompleted - bCompleted
  const aCreated = a.time?.created ?? -Infinity
  const bCreated = b.time?.created ?? -Infinity
  if (aCreated !== bCreated) return aCreated - bCreated
  return (a.id ?? a.messageID ?? "").localeCompare(b.id ?? b.messageID ?? "")
}

/** Single assistant turn hit % (0–100), or null if skipped / no denominator. */
export function perMessageHitPercent(msg: AssistantMessage): number | null {
  if (msg.role !== "assistant" || !isInteractiveAssistantMessage(msg)) return null
  const t = msg.tokens
  if (!t) return null
  const input = t.input ?? 0
  const read = t.cache?.read ?? 0
  const denom = read + input
  if (denom <= 0) return null
  return (read / denom) * 100
}

/**
 * Per-turn hit rates for the top Hit row (visual-cache).
 * Skips summary and compaction assistant messages — not full LLM pricing turns.
 */
export function computePerCallHitTrend(messages: readonly AssistantMessage[]): PerCallHitTrend {
  const calls = messages
    .filter((msg) => msg.role === "assistant" && isInteractiveAssistantMessage(msg))
    .slice()
    .sort(compareAssistantMessages)
    .map((msg) => ({
      msg,
      hit: perMessageHitPercent(msg),
    }))
    .filter((call) => call.hit !== null)
  const last = calls[calls.length - 1]
  if (!last) {
    return { hitPercent: 0, trendPercent: 0, hasTrend: false, state: "warming" }
  }
  const previous = calls[calls.length - 2]
  const hit = last.hit ?? 0
  const switched = Boolean(previous && messageLineageKey(last.msg) !== messageLineageKey(previous.msg))
  const state = !previous ? "warming" : switched ? "switch" : "steady"
  return {
    hitPercent: hit,
    trendPercent: previous && !switched ? hit - (previous.hit ?? 0) : 0,
    hasTrend: Boolean(previous && !switched),
    state,
  }
}

export function shortModelName(modelId: string): string {
  if (!modelId) return ""
  return modelId.includes("/") ? (modelId.split("/").pop() ?? modelId) : modelId
}
