/**
 * OpenCode 2 TUI context → the `OpenCodeTuiApi` shape the sidebar host already
 * consumes. Keeping the adapter at the API boundary leaves every downstream
 * module (stats, pricing, timeline, rendering) shared by both versions.
 *
 * Verified against OpenCode 2.0.12:
 *  - the CLI loader only reads `exports["./tui"]` and calls `setup(context)`
 *  - `ctx.data.session.message.list()` is a cache read; `sync()` fills it
 *  - `ctx.data.location.{provider,model}.list()` are reactive store reads
 *  - events are `{type, created, data}`, not V1's `{properties}`
 * See docs/en/design.md § Version support.
 */
import type { AssistantMessage, OpenCodeTuiApi, ProviderInfo, StreamPart } from "../types.ts"
import type { V2Context, V2Event } from "./types.ts"
import { streamPartsFromContent, toAssistantMessage, toProviderInfos, toSessionObject } from "./map.ts"

type V1Event = { properties?: Record<string, unknown> }
type Handler = (event: V1Event) => void

export type V2Api = OpenCodeTuiApi & { dispose: () => void }

export function createV2Api(ctx: V2Context): V2Api {
  const location = ctx.location ?? { directory: "" }
  const listeners = new Map<string, Set<Handler>>()
  /** messageID → streaming part starts, for TTFT when part events were missed. */
  const parts = new Map<string, StreamPart[]>()
  /** callID → tool call identity, so success/failed can close the part opened by input.started. */
  const toolStarts = new Map<string, { messageID: string; name: string; start?: number }>()
  const synced = new Set<string>()
  const disposers: Array<() => void> = []

  const emit = (name: string, event: V1Event) => {
    for (const handler of listeners.get(name) ?? []) handler(event)
  }
  const on = (name: string, handler: Handler) => {
    const set = listeners.get(name) ?? new Set<Handler>()
    set.add(handler)
    listeners.set(name, set)
    return () => set.delete(handler)
  }
  const rememberParts = (messageID: string, next: StreamPart[]) => {
    if (!messageID || next.length === 0) return
    const existing = parts.get(messageID) ?? []
    parts.set(messageID, [...existing, ...next])
  }
  const messageIDOf = (event: V2Event) => event.data?.assistantMessageID ?? event.data?.messageID ?? ""

  const ensureMessages = (sessionID: string) => {
    if (!sessionID || synced.has(sessionID)) return
    synced.add(sessionID)
    void ctx.data.session.message.sync(sessionID).catch(() => synced.delete(sessionID))
  }

  // One-shot syncs for the location collections the sidebar prices from.
  void ctx.data.location.provider.sync(location).catch(() => {})
  void ctx.data.location.model.sync(location).catch(() => {})

  const subscribe = <Type extends string>(type: Type, handler: (event: any) => void) => {
    disposers.push(ctx.data.on(type, handler))
  }

  const emitPart = (type: string, event: V2Event) => {
    const messageID = messageIDOf(event)
    if (!messageID) return
    const start = event.created
    const part: StreamPart = { type, time: typeof start === "number" ? { start } : undefined }
    if (typeof start === "number") rememberParts(messageID, [part])
    emit("message.part.updated", { properties: { part: { ...part, messageID } } })
  }

  // Usage changes carry only session aggregates; V1 consumers only need the
  // refresh tick from `message.updated`, so an empty payload is the right signal.
  subscribe("session.usage.updated", () => emit("message.updated", { properties: {} }))

  subscribe("session.message.content.updated", (event: V2Event) => {
    const sessionID = event.data?.sessionID ?? ""
    const messageID = event.data?.messageID ?? ""
    rememberParts(messageID, streamPartsFromContent(event.data?.content))
    const row = messageID ? ctx.data.session.message.get(sessionID, messageID) : undefined
    if (!row) return
    emit("message.updated", { properties: { info: toAssistantMessage(row, sessionID) } })
  })

  subscribe("session.text.started", (event: V2Event) => emitPart("text", event))
  subscribe("session.reasoning.started", (event: V2Event) => emitPart("reasoning", event))
  // Tool parts need callID/tool/state.time, which V2 splits across three events:
  // `input.started` names the call and starts the clock, success/failed stop it.
  subscribe("session.tool.input.started", (event: V2Event) => {
    const messageID = event.data?.assistantMessageID ?? ""
    const callID = String(event.data?.id ?? "")
    if (!messageID || !callID) return
    const name = String(event.data?.name ?? "")
    const start = event.created
    toolStarts.set(callID, { messageID, name, start })
    if (typeof start === "number") rememberParts(messageID, [{ type: "tool", time: { start } }])
    emit("message.part.updated", {
      properties: { part: { type: "tool", messageID, callID, tool: name, state: { status: "running", time: { start } } } },
    })
  })
  const finishTool = (status: string) => (event: V2Event) => {
    const callID = String(event.data?.id ?? "")
    const known = toolStarts.get(callID)
    const messageID = event.data?.assistantMessageID ?? known?.messageID ?? ""
    if (!messageID || !callID) return
    emit("message.part.updated", {
      properties: {
        part: {
          type: "tool",
          messageID,
          callID,
          tool: known?.name ?? "",
          state: { status, time: { start: known?.start, end: event.created } },
        },
      },
    })
  }
  subscribe("session.tool.success", finishTool("completed"))
  subscribe("session.tool.failed", finishTool("error"))
  subscribe("session.text.delta", (event: V2Event) => {
    const messageID = messageIDOf(event)
    if (messageID) emit("message.part.delta", { properties: { messageID, field: "text" } })
  })
  subscribe("session.reasoning.delta", (event: V2Event) => {
    const messageID = messageIDOf(event)
    if (messageID) emit("message.part.delta", { properties: { messageID, field: "reasoning" } })
  })

  const messagesOf = (sessionID: string): AssistantMessage[] => {
    const rows = ctx.data.session.message.list(sessionID)
    if (rows.length === 0) ensureMessages(sessionID)
    return rows.map((row) => toAssistantMessage(row, sessionID))
  }

  const api: V2Api = {
    state: {
      path: { directory: location.directory },
      get provider() {
        return toProviderInfos(
          ctx.data.location.provider.list(location),
          ctx.data.location.model.list(location),
        ) as ReadonlyArray<ProviderInfo>
      },
      session: {
        messages: messagesOf,
        get: (id: string) => toSessionObject(ctx.data.session.get(id)),
      },
      part: (messageID: string) => parts.get(messageID),
    },
    client: {
      session: {
        list: async () => {
          await ctx.data.session.sync().catch(() => {})
          return ctx.data.session.list().map((session) => ({
            ...session,
            parentID: session.parentID,
          }))
        },
        messages: async (opts: {
          path: { id: string }
          query: { directory: string; limit: number }
        }) => {
          // The store window is capped at the initial page size; V1 asked for a
          // large limit, so go to the API for full history when the client is
          // available and fall back to the store otherwise.
          const list = ctx.client?.message?.list
          if (list) {
            try {
              const response = await list({
                sessionID: opts.path.id,
                limit: opts.query.limit,
                order: "desc",
              })
              return {
                data: (response?.data ?? [])
                  .slice()
                  .reverse()
                  .map((row) => ({ info: toAssistantMessage(row, opts.path.id) })),
              }
            } catch {
              ensureMessages(opts.path.id)
              return { data: messagesOf(opts.path.id).map((info) => ({ info })) }
            }
          }
          ensureMessages(opts.path.id)
          return { data: messagesOf(opts.path.id).map((info) => ({ info })) }
        },
      },
    },
    event: { on },
  }

  return {
    ...api,
    dispose: () => {
      for (const dispose of disposers) dispose()
      disposers.length = 0
      listeners.clear()
    },
  }
}
