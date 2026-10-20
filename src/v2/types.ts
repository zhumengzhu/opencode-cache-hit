/**
 * Structural types for the OpenCode 2 TUI plugin context.
 *
 * Hand-written on purpose, like `TuiApi` in `../types.ts`: the plugin
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

/**
 * One stored content part, as the host writes it into the message row (see
 * `session_message.data.content`). Text parts carry no timing; reasoning and
 * tool parts do. Tool identity lives under `id` / `name` here, not under the
 * `callID` / `tool` names the internal contract uses.
 */
export type V2ContentPart = {
  type: string
  id?: string
  name?: string
  state?: { status?: string; input?: Record<string, unknown> }
  time?: { created?: number; completed?: number; ran?: number }
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
    /** Tool call identity on `session.tool.*` events. */
    id?: string
    name?: string
    status?: string
    /** Incremental stream text (`text.delta` / `reasoning.delta`). */
    delta?: string
    /** Authoritative full text on `text.ended` / `reasoning.ended`. */
    text?: string
    ordinal?: number
    /** `session.step.*`: one step is one assistant message. */
    agent?: string
    model?: V2ModelRef
    started?: number
    finish?: string
    cost?: number
    tokens?: V2TokenUsage
    /** `step.failed` / `tool.failed` carry it; nothing reads it. */
    error?: unknown
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
    on: <Type extends string>(type: Type, handler: (event: V2Event) => void) => () => void
  }
  /** Generated client. Used for uncapped history reads. */
  client?: {
    message?: {
      list: (input: {
        sessionID: string
        limit?: number
        order?: "asc" | "desc"
        /** Opaque page cursor; do not combine with `order`. */
        cursor?: string
      }) => Promise<{
        data?: V2Message[]
        cursor?: { next?: string | null; previous?: string | null }
      }>
    }
  }
  ui: {
    /** Disposer for the slot claim; not verified against the host, so callers guard the call. */
    slot: (claim: {
      append: string
      render: (input: { sessionID: string }) => unknown
    }) => (() => void) | undefined
  }
}
