/**
 * Structural types for the OpenCode 2 TUI plugin context.
 *
 * Hand-written on purpose, like `OpenCodeTuiApi` in `../types.ts`: the plugin
 * must not depend on `@opencode/plugin` at runtime. V1 does not substitute that
 * specifier, so a runtime import of it breaks V1 loading. Only the members this
 * adapter actually reads are declared.
 */

export type V2TokenUsage = {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

export type V2ModelRef = { id: string; providerID: string; variant?: string }

export type V2ContentPart = {
  type: string
  /** reasoning/tool parts carry `created`; text parts carry none. */
  time?: { created?: number; completed?: number; ran?: number }
  state?: { status?: string; input?: unknown }
  [key: string]: unknown
}

export type V2Message = {
  id: string
  /** "assistant" | "user" | "compaction" | "idle" | "synthetic" | ... */
  type: string
  agent?: string
  model?: V2ModelRef
  cost?: number
  tokens?: V2TokenUsage
  finish?: string
  time?: { created?: number; streamed?: number; completed?: number }
  content?: ReadonlyArray<V2ContentPart>
}

export type V2Session = {
  id: string
  parentID?: string
  agent?: string
  model?: V2ModelRef
  cost?: number
  tokens?: V2TokenUsage
  time?: { created?: number; updated?: number }
}

export type V2ModelCostTier = {
  tier?: { type: "context"; size: number }
  input: number
  output: number
  cache: { read: number; write: number }
}

export type V2Model = {
  id: string
  providerID: string
  /** Base entry first, then optional context-tier entries. */
  cost?: V2ModelCostTier[]
}

export type V2Provider = { id: string }

export type V2Event = {
  type: string
  /** Event creation time (ms). OpenTUI plugin events carry it at the top level. */
  created?: number
  data?: {
    sessionID?: string
    assistantMessageID?: string
    messageID?: string
    content?: ReadonlyArray<V2ContentPart>
    [key: string]: unknown
  }
}

export type V2Location = { directory: string }

export type V2Collection<Value> = {
  list: (location?: V2Location) => Value[] | undefined
  sync: (location?: V2Location) => Promise<void>
  invalidate: (location?: V2Location) => void
}

export type V2Context = {
  /** Absent when the CLI has not resolved a location yet. */
  location?: V2Location
  /** ResolvedTheme: nested semantic tokens (text.base, border.base, ...). */
  theme?: unknown
  data: {
    session: {
      list: () => V2Session[]
      get: (sessionID: string) => V2Session | undefined
      sync: () => Promise<void>
      invalidate: (sessionID: string) => void
      message: {
        list: (sessionID: string) => V2Message[]
        get: (sessionID: string, messageID: string) => V2Message | undefined
        sync: (sessionID: string) => Promise<void>
      }
    }
    location: {
      provider: V2Collection<V2Provider>
      model: V2Collection<V2Model>
    }
    on: <Type extends string>(type: Type, handler: (event: any) => void) => () => void
  }
  /** Generated client. Used for uncapped history reads. */
  client?: {
    message?: {
      list: (input: {
        sessionID: string
        limit?: number
        order?: "asc" | "desc"
      }) => Promise<{ data?: V2Message[] }>
    }
  }
  ui: {
    slot: (claim: {
      append: string
      render: (input: { sessionID: string }) => unknown
    }) => () => void
  }
}
