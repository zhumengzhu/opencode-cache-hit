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
    if (msg.role !== "assistant") continue
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

export function toSubAgentSummary(id: string, snap: SessionSnapshot): SubAgentSummary {
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
}

/** Single assistant turn hit % (0–100), or null if skipped / no denominator. */
export function perMessageHitPercent(msg: AssistantMessage): number | null {
  if (msg.role !== "assistant" || msg.summary === true) return null
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
 * Skips `summary: true` assistant messages — not full LLM pricing turns.
 */
export function computePerCallHitTrend(messages: readonly AssistantMessage[]): PerCallHitTrend {
  let prevHit = -1
  let lastHit = -1
  for (const msg of messages) {
    const hit = perMessageHitPercent(msg)
    if (hit === null) continue
    prevHit = lastHit
    lastHit = hit
  }
  return {
    hitPercent: lastHit >= 0 ? lastHit : 0,
    trendPercent: prevHit >= 0 && lastHit >= 0 ? lastHit - prevHit : 0,
    hasTrend: prevHit >= 0 && lastHit >= 0,
  }
}

export function shortModelName(modelId: string): string {
  if (!modelId) return ""
  return modelId.includes("/") ? (modelId.split("/").pop() ?? modelId) : modelId
}

export type ContextUsage = {
  tokens: number
  limit: number
  /** 0–100, null when model limit is unknown */
  percent: number | null
}

export function contextUsage(
  messages: readonly AssistantMessage[],
  modelLimit: number | undefined,
): ContextUsage | null {
  const last = messages.findLast(
    (m) => m.role === "assistant" && ((m.tokens?.output ?? 0) > 0 || (m.tokens?.cache?.read ?? 0) > 0),
  )
  if (!last) return null
  const t = last.tokens
  const tokens = (t?.cache?.read ?? 0) + (t?.input ?? 0)
  if (tokens <= 0) return null
  const limit = modelLimit ?? 0
  return {
    tokens,
    limit,
    percent: limit > 0 ? Math.round((tokens / limit) * 100) : null,
  }
}
