export type SessionSnapshot = {
  /** Provider/model lineage when this snapshot represents one lineage. */
  lineageKey?: string
  model: string
  providerID: string
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  cost: number
}

export type LineageCall = {
  id?: string
  created?: number
  completed?: number
  agent?: string
  hitPercent: number | null
}

export type LineageBucket = {
  key: string
  providerID: string
  modelID: string
  callCount: number
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  cost: number
  cacheRatio: number
  lastCall?: LineageCall
  agentCounts: Record<string, number>
}

export type SubAgentSummary = {
  id: string
  model: string
  providerID: string
  cost: number
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  speed?: number
  /** Session creation time (ms), from session.list — enables time-of-day pricing recompute. */
  created?: number
}

export type AssistantMessage = {
  role?: string
  id?: string
  messageID?: string
  modelID?: string
  providerID?: string
  agent?: string
  cost?: number
  /** OpenCode SDK: true = summary/compaction message, not a full LLM pricing turn */
  summary?: boolean
  finish?: string
  /** Session this message belongs to. V2 events carry it explicitly; V1 messages inherit it. */
  sessionID?: string
  time?: {
    created: number
    completed?: number
  }
  tokens?: {
    input?: number
    output?: number
    reasoning?: number
    cache?: { read?: number; write?: number }
  }
}

export type ModelCost = {
  input: number
  output: number
  cache: { read: number; write: number }
  /**
   * Context-tier price (threshold: `contextThreshold`, default 200k).
   * Accepts two sources: config-level `context_over_200k` in opencode.json, and
   * runtime `tiers`/`experimentalOver200K` from `state.provider` (normalized by normalizeRuntimeCost).
   */
  context_over_200k?: ModelCost
  /** This tier's threshold (tokens); from runtime tier.size, falls back to the global contextThreshold. */
  contextThreshold?: number
}

export type ProviderInfo = {
  id: string
  models: { [key: string]: { cost: ModelCost } }
}

export type ToolState = {
  status?: string
  time?: { start?: number; end?: number }
  input?: Record<string, unknown>
}

/** One streamed part as `api.state.part()` exposes it (no message identity). */
export type StreamPart = {
  type: string
  text?: string
  time?: { start?: number }
  /** Tool parts only: call identity and lifecycle. */
  callID?: string
  tool?: string
  state?: ToolState
}

/** A part event always carries the message it belongs to. */
export type TuiPart = StreamPart & { messageID: string }

/**
 * Internal event contract. V2 produces these natively; the V1 path maps its
 * legacy `{ properties }` payloads onto them in `v1-map.ts`, so nothing
 * downstream of the entrypoints knows which OpenCode version is running.
 *
 * - `tick` carries only the fact that session aggregates changed: consumers
 *   re-read state, they do not receive a message.
 */
export type TuiEvent =
  | { type: "part"; part: TuiPart }
  | { type: "message"; info: AssistantMessage }
  | { type: "delta"; messageID: string; field: "text" | "reasoning" }
  | { type: "tick" }

/** Session aggregate from `api.state.session.get()` — DB-level totals, not capped by message limit. */
export type SessionObject = {
  model?: { id: string; providerID: string }
  cost?: number
  tokens?: {
    input?: number
    output?: number
    reasoning?: number
    cache?: { read?: number; write?: number }
  }
  parentID?: string
}

/** Result of `client.session.messages`: assistant history, ascending, plus completeness. */
export type SessionMessagesPage = {
  messages: AssistantMessage[]
  /** false: the source stopped at `limit`; older history may exist. */
  complete: boolean
}

export type TuiApi = {
  state: {
    path: { directory: string }
    provider: ReadonlyArray<ProviderInfo>
    session: {
      /** Message mirror; may be capped by the host's window, hence optional totals downstream. */
      messages: (id: string) => AssistantMessage[] | undefined
      get?: (id: string) => SessionObject | undefined
    }
    part: (messageID: string) => ReadonlyArray<StreamPart> | undefined
  }
  client: {
    session: {
      /** All sessions; the response is parsed defensively by `parseSessionListResponse`. */
      list: () => Promise<unknown>
      messages?: (sessionId: string, limit: number) => Promise<SessionMessagesPage>
    }
  }
  event: {
    on: <Type extends TuiEvent["type"]>(
      type: Type,
      fn: (event: Extract<TuiEvent, { type: Type }>) => void,
    ) => () => void
  }
}
