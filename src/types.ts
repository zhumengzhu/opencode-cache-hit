export type SessionSnapshot = {
  model: string
  providerID: string
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  cost: number
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
  cost?: number
  /** OpenCode SDK: true = summary/compaction message, not a full LLM pricing turn */
  summary?: boolean
  finish?: string
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

export type StreamPart = {
  type: string
  text?: string
  time?: { start?: number }
}

export type PartUpdatedPart = {
  type: string
  messageID: string
  time?: { start?: number }
}

export function isPartUpdatedEvent(
  event: { properties?: Record<string, unknown> },
): event is { properties: { part: PartUpdatedPart } } {
  const p = event.properties?.part
  return (
    typeof p === "object" &&
    p !== null &&
    typeof (p as Record<string, unknown>).type === "string" &&
    typeof (p as Record<string, unknown>).messageID === "string"
  )
}

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

export type OpenCodeTuiApi = {
  state: {
    path: { directory: string }
    provider: ReadonlyArray<ProviderInfo>
    session: {
      messages: (id: string) => unknown[] | undefined
      get?: (id: string) => SessionObject | undefined
    }
    part: (messageID: string) => ReadonlyArray<StreamPart> | undefined
  }
  client: {
    session: {
      list: (opts: { query: { directory: string } }) => Promise<unknown>
    }
  }
  event: {
    on: (
      name: string,
      fn: (event: { properties?: Record<string, unknown> }) => void,
    ) => () => void
  }
  slots: {
    register: (opts: {
      order: number
      slots: {
        sidebar_content: (
          ctx: { theme: { current: Record<string, unknown> } },
          props: { session_id: string },
        ) => unknown
      }
    }) => void
  }
}
