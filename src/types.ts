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
}

export type ProviderInfo = {
  id: string
  models: { [key: string]: { cost: ModelCost; limit?: { context: number; output: number } } }
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
      get: (id: string) => SessionObject | undefined
    }
  }
  client: {
    session: {
      list: (opts: { query: { directory: string } }) => Promise<unknown>
    }
  }
  event: {
    on: (
      name: string,
      fn: (event: { properties?: { info?: { sessionID?: string } } }) => void,
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
