/**
 * OpenCode 2 TUI context → the internal `TuiApi` contract the sidebar host
 * consumes. V2 events already have the natural shape, so the adapter emits
 * them with only the fields the UI reads; there is no V1 translation here.
 * Keeping the adapter at the API boundary leaves every downstream module
 * (stats, pricing, timeline, rendering) shared by both versions.
 *
 * Verified against OpenCode 2.0.32 (OpenTUI 0.6.6):
 *  - the CLI loader only reads `exports["./tui"]` and calls `setup(context)`
 *  - `ctx.data.session.message.list()` is a cache read; `sync()` fills it
 *  - `ctx.data.location.{provider,model}.list()` are reactive store reads
 *  - events are `{type, created, data}`, not V1's `{properties}`
 * See docs/en/design.md § Version support.
 */
import type {
  AssistantMessage,
  SessionMessagesPage,
  StreamPart,
  TuiApi,
  TuiEvent,
  TuiPart,
} from "../types.ts"
import type { V2Context, V2Event, V2Message } from "./types.ts"
import {
  partsFromContent,
  stepMessage,
  toAssistantMessage,
  toProviderInfos,
  toSessionObject,
  type StepMeta,
} from "./map.ts"

type Handler = (event: TuiEvent) => void

export type V2Api = TuiApi & { dispose: () => void }


/** Bound process-lifetime caches; sessions and messages come and go. */
const MAX_PART_MESSAGES = 200
const MAX_SYNCED_SESSIONS = 200
const MAX_TRACKED_STEPS = 200
const MAX_TRACKED_TOOL_CALLS = 200
/** OpenCode 2 caps one `message.list` page at 200 rows (schema `<= 200`). */
const HISTORY_PAGE_LIMIT = 200

/** Drop the oldest inserted key once a process-lifetime cache is full. */
function evictOldest<Key>(
  cache: { size: number; keys: () => IterableIterator<Key>; delete: (key: Key) => unknown },
  max: number,
) {
  while (cache.size > max) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) return
    cache.delete(oldest)
  }
}

export function createV2Api(ctx: V2Context): V2Api {
  /** Lazy read: the CLI may resolve the location after the plugin loads. */
  const location = () => ctx.location ?? { directory: "" }
  let syncedLocation = ""
  const ensureLocationSync = () => {
    const loc = location()
    if (!loc.directory || syncedLocation === loc.directory) return
    // Same policy as `ensureMessages`: a failed sync must not pin the directory
    // as synced, or provider/model costs stay empty for the rest of the process.
    // The marker set below still coalesces concurrent reads into one attempt.
    syncedLocation = loc.directory
    void Promise.all([ctx.data.location.provider.sync(loc), ctx.data.location.model.sync(loc)]).catch(() => {
      if (syncedLocation === loc.directory) syncedLocation = ""
    })
  }
  const listeners = new Map<TuiEvent["type"], Set<Handler>>()
  /** messageID → streaming part starts, for TTFT when part events were missed. */
  const parts = new Map<string, StreamPart[]>()
  /** callID → tool call identity, so success/failed can close the part opened by input.started. */
  const toolStarts = new Map<string, { messageID: string; name: string; start?: number }>()
  /** messageID → step identity; V2 reports model/agent on the step, not on the message. */
  const stepStarts = new Map<string, StepMeta>()
  /** Session ids whose `message.sync` has landed; `syncing` is the in-flight promise per session. */
  const synced = new Set<string>()
  const syncing = new Map<string, Promise<void>>()
  const disposers: Array<() => void> = []

  const emit = (event: TuiEvent) => {
    for (const handler of listeners.get(event.type) ?? []) handler(event)
  }
  const on = <Type extends TuiEvent["type"]>(
    type: Type,
    handler: (event: Extract<TuiEvent, { type: Type }>) => void,
  ) => {
    const set = listeners.get(type) ?? new Set<Handler>()
    const listener = handler as Handler
    set.add(listener)
    listeners.set(type, set)
    return () => set.delete(listener)
  }
  const storeParts = (messageID: string, next: StreamPart[]) => {
    parts.set(messageID, next)
    evictOldest(parts, MAX_PART_MESSAGES)
  }
  const rememberParts = (messageID: string, next: StreamPart[]) => {
    if (!messageID || next.length === 0) return
    const existing = parts.get(messageID) ?? []
    storeParts(messageID, [...existing, ...next])
  }
  /**
   * Live fragments arrive as deltas; the sidebar's in-flight speed needs the
   * accumulated text, otherwise every V2 session stays in `warmup`. Append to
   * the trailing part of the same kind, creating it when the started event was
   * missed.
   */
  const appendStreamText = (messageID: string, type: string, delta: string) => {
    if (!messageID || !delta) return
    const existing = parts.get(messageID) ?? []
    const last = existing[existing.length - 1]
    const next =
      last?.type === type
        ? [...existing.slice(0, -1), { ...last, text: (last.text ?? "") + delta }]
        : [...existing, { type, text: delta }]
    storeParts(messageID, next)
  }
  /** `ended` is the durable full value, so it wins over accumulated deltas. */
  const setStreamText = (messageID: string, type: string, text: string) => {
    if (!messageID) return
    const existing = parts.get(messageID) ?? []
    let index = -1
    for (let i = existing.length - 1; i >= 0; i--) {
      if (existing[i]?.type === type) {
        index = i
        break
      }
    }
    if (index === -1) {
      if (text) storeParts(messageID, [...existing, { type, text }])
      return
    }
    storeParts(messageID, [
      ...existing.slice(0, index),
      { ...existing[index], text },
      ...existing.slice(index + 1),
    ])
  }
  const messageIDOf = (event: V2Event) => event.data?.assistantMessageID ?? event.data?.messageID ?? ""
  const deltaOf = (event: V2Event) => (typeof event.data?.delta === "string" ? event.data.delta : "")
  const textOf = (event: V2Event) => (typeof event.data?.text === "string" ? event.data.text : "")

  /**
   * `synced` means the sync landed. `syncing` holds the one in-flight promise
   * per session so concurrent reads share it — and so a store read can wait for
   * it instead of guessing. Marking before the promise resolves would let an
   * empty window claim a completeness the store has not proven.
   */
  const ensureMessages = (sessionID: string): Promise<void> => {
    if (!sessionID || synced.has(sessionID)) return Promise.resolve()
    const active = syncing.get(sessionID)
    if (active) return active
    const promise = ctx.data.session.message
      .sync(sessionID)
      .then(() => {
        synced.add(sessionID)
        evictOldest(synced, MAX_SYNCED_SESSIONS)
      })
      .catch(() => {})
      .finally(() => {
        // A later read may have replaced this entry (e.g. after `session.deleted`).
        if (syncing.get(sessionID) === promise) syncing.delete(sessionID)
      })
    syncing.set(sessionID, promise)
    return promise
  }

  const emitPart = (type: string, event: V2Event) => {
    const messageID = messageIDOf(event)
    if (!messageID) return
    const start = event.created
    const part: TuiPart = { type, messageID, time: typeof start === "number" ? { start } : undefined }
    if (typeof start === "number") rememberParts(messageID, [{ type, time: { start } }])
    emit({ type: "part", part })
  }

  // One step is one assistant message: `step.started` names it, `step.ended`
  // (cost, tokens, finish) or `step.failed` (provider error, content filter,
  // abort) finalizes it. The store row, when projected, carries the compaction
  // `summary` flag, so the terminal message prefers it and falls back to the
  // event payload.
  const emitStep = (defaultFinish?: string) => (event: V2Event) => {
    const sessionID = event.data?.sessionID ?? ""
    const messageID = event.data?.assistantMessageID ?? ""
    if (!sessionID || !messageID) return
    const meta = stepStarts.get(messageID)
    stepStarts.delete(messageID)
    const row = ctx.data.session.message.get(sessionID, messageID)
    // A reload tears down this adapter mid-turn, so the live part events of the
    // message may never have reached the instance that reports the step. Replay
    // the row's timed parts first (both consumers are idempotent) so TTFT and
    // tool durations survive; see `partsFromContent` for what it cannot recover.
    for (const part of partsFromContent(row?.content, row?.time?.created)) {
      emit({ type: "part", part: { ...part, messageID } })
    }
    const info = stepMessage({ row, meta, event, sessionID, defaultFinish })
    emit({ type: "message", info })
  }

  /** Tool parts need callID/tool/state.time, which V2 splits across three events. */
  const finishTool = (status: string) => (event: V2Event) => {
    const callID = event.data?.id ?? ""
    const known = toolStarts.get(callID)
    if (callID) toolStarts.delete(callID)
    const messageID = event.data?.assistantMessageID ?? known?.messageID ?? ""
    if (!messageID || !callID) return
    emit({
      type: "part",
      part: {
        type: "tool",
        messageID,
        callID,
        tool: known?.name ?? "",
        state: { status, time: { start: known?.start, end: event.created } },
      },
    })
  }

  const emitDelta = (field: "text" | "reasoning") => (event: V2Event) => {
    const messageID = messageIDOf(event)
    appendStreamText(messageID, field, deltaOf(event))
    if (messageID) emit({ type: "delta", messageID, field })
  }

  /** Deltas are live-only; the durable `ended` events replay the full value. */
  const setEndedText = (field: "text" | "reasoning") => (event: V2Event) => {
    setStreamText(messageIDOf(event), field, textOf(event))
  }

  /**
   * The whole host-event surface in one table: it is the single list of
   * subscriptions (the loop below registers exactly its keys), and
   * `tests/fixtures/v2-events.ts` must cover every key.
   */
  const handlers: Record<string, (event: V2Event) => void> = {
    // Usage changes carry only session aggregates, so `tick` is the whole
    // signal: consumers re-read `session.get()` instead of receiving a message.
    "session.usage.updated": () => emit({ type: "tick" }),
    "session.step.started": (event) => {
      const messageID = event.data?.assistantMessageID ?? ""
      if (!messageID) return
      stepStarts.set(messageID, {
        agent: event.data?.agent,
        model: event.data?.model,
        started: event.data?.started,
      })
      evictOldest(stepStarts, MAX_TRACKED_STEPS)
    },
    "session.step.ended": emitStep(),
    "session.step.failed": emitStep("error"),
    "session.text.started": (event) => emitPart("text", event),
    "session.reasoning.started": (event) => emitPart("reasoning", event),
    // `input.started` names the call and starts the clock; success/failed stop it.
    "session.tool.input.started": (event) => {
      const messageID = event.data?.assistantMessageID ?? ""
      const callID = event.data?.id ?? ""
      if (!messageID || !callID) return
      const name = event.data?.name ?? ""
      const start = event.created
      toolStarts.set(callID, { messageID, name, start })
      evictOldest(toolStarts, MAX_TRACKED_TOOL_CALLS)
      if (typeof start === "number") rememberParts(messageID, [{ type: "tool", time: { start } }])
      emit({
        type: "part",
        part: { type: "tool", messageID, callID, tool: name, state: { status: "running", time: { start } } },
      })
    },
    "session.tool.success": finishTool("completed"),
    "session.tool.failed": finishTool("error"),
    "session.text.delta": emitDelta("text"),
    "session.reasoning.delta": emitDelta("reasoning"),
    "session.text.ended": setEndedText("text"),
    "session.reasoning.ended": setEndedText("reasoning"),
    // Sessions come and go for the lifetime of the TUI process; drop cached ids
    // when the server reports the session gone.
    "session.deleted": (event) => {
      const sessionID = event.data?.sessionID ?? ""
      if (!sessionID) return
      synced.delete(sessionID)
      syncing.delete(sessionID)
    },
  }
  for (const [type, handler] of Object.entries(handlers)) disposers.push(ctx.data.on(type, handler))

  const messagesOf = (sessionID: string): AssistantMessage[] => {
    const rows = ctx.data.session.message.list(sessionID)
    if (rows.length === 0) void ensureMessages(sessionID)
    return rows.map((row) => toAssistantMessage(row, sessionID))
  }
  /**
   * Store fallback when the API client is missing or its first page failed.
   * `limit` is not applied: this window is owned by the host.
   *
   * Completeness is only provable for the empty case. The host fills the
   * window with one page (`message.sync` takes `initialMessageLimit ?? 20`, and
   * the TUI passes no limit), then pages older rows in on scroll — so a
   * populated window says nothing about whether older rows exist, and its row
   * count is not a usable proxy (a 220-message session shows 20). The plugin
   * contract exposes no cursor (`more()` exists on the runtime Data object but
   * is not declared), so a non-empty window is reported incomplete rather than
   * silently claiming a completeness it cannot prove.
   *
   * An empty window can simply mean `message.sync` has not landed yet, and
   * nothing re-reads the store after it does. Wait for that one in-flight sync
   * before deciding: an empty window then means either a real empty session
   * (`complete`) or a failed sync (`incomplete`).
   */
  const storePage = async (sessionID: string): Promise<SessionMessagesPage> => {
    if (!synced.has(sessionID) && ctx.data.session.message.list(sessionID).length === 0) {
      await ensureMessages(sessionID)
    }
    // Read directly: `messagesOf` kicks another sync when the window is still
    // empty, which would double-request after a failed one.
    const history = ctx.data.session.message.list(sessionID).map((row) => toAssistantMessage(row, sessionID))
    return {
      messages: history.filter((message) => message.role === "assistant"),
      complete: history.length === 0 && synced.has(sessionID),
    }
  }

  const api: TuiApi = {
    state: {
      get path() {
        ensureLocationSync()
        return { directory: location().directory }
      },
      get provider() {
        ensureLocationSync()
        return toProviderInfos(
          ctx.data.location.provider.list(location()),
          ctx.data.location.model.list(location()),
        )
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
          return ctx.data.session.list()
        },
        messages: async (sessionID: string, limit: number) => {
          // The store window is capped at the initial page size; go to the API
          // for history when the client is available and fall back to the store
          // otherwise. One request returns at most 200 rows, so walk
          // `cursor.next` until the requested total or the end of history.
          const list = ctx.client?.message?.list
          if (!list) return storePage(sessionID)
          const rows: V2Message[] = []
          let cursor: string | undefined
          try {
            while (rows.length < limit) {
              const page = await list({
                sessionID,
                limit: Math.min(HISTORY_PAGE_LIMIT, limit - rows.length),
                ...(cursor ? { cursor } : { order: "desc" }),
              })
              const data = page?.data ?? []
              rows.push(...data)
              const next = page?.cursor?.next
              if (!next || data.length === 0) break
              cursor = next
            }
          } catch {
            // Keep the pages already read; only a failed first page falls back.
            if (rows.length === 0) return storePage(sessionID)
          }
          return {
            messages: rows
              .slice()
              .reverse()
              .map((row) => toAssistantMessage(row, sessionID))
              .filter((message) => message.role === "assistant"),
            complete: rows.length < limit,
          }
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
