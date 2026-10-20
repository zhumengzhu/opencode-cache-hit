/**
 * OpenCode 1 event → internal `TuiEvent` mapping.
 *
 * V1 is best-effort in 1.0.0 and does not share V2's event shape: it emits
 * untrusted `{ properties }` payloads under dotted names. This is the only
 * module that knows that shape. Everything downstream (sidebar host, stats,
 * timeline, rendering) consumes `TuiEvent`, so V2 does not pay for the
 * translation layer.
 *
 * The same holds for the client: V1's SDK wire format (`{ path, query }` in,
 * `{ data: [{ info }] }` out) is wrapped here, so the internal `TuiApi`
 * contract stays free of V1 dialect.
 */
import type {
  AssistantMessage,
  ProviderInfo,
  SessionMessagesPage,
  StreamPart,
  TuiApi,
  TuiEvent,
  TuiPart,
} from "./types.ts"

/** V1 event name behind each internal subscription. */
const V1_EVENT_NAMES: Record<TuiEvent["type"], string> = {
  message: "message.updated",
  tick: "message.updated",
  part: "message.part.updated",
  delta: "message.part.delta",
}

/** The subset of the V1 TUI api this plugin reads. */
export type V1Api = {
  state: {
    path: { directory: string }
    /** Forks (e.g. MiMo-Code) may omit these; `toTuiApi` fills the defaults. */
    provider?: ReadonlyArray<ProviderInfo>
    session: TuiApi["state"]["session"]
    part?: (messageID: string) => ReadonlyArray<StreamPart> | undefined
  }
  /** V1 SDK wire format: `{ path, query }` in, `{ data: [...] }` out. */
  client: {
    session: {
      list: (opts: { query: { directory: string } }) => Promise<unknown>
      messages?: (opts: {
        path: { id: string }
        query: { directory: string; limit: number }
      }) => Promise<unknown>
    }
  }
  event: {
    on: (name: string, fn: (event: unknown) => void) => () => void
  }
}

/** V1-only surface: OpenCode 2 registers slots through `setup(ctx)`, not the api. */
export type V1TuiApi = V1Api & {
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

/**
 * Wrap a V1 api so the sidebar host sees the internal contract.
 * `message.updated` is subscribed twice: once for full messages and once for
 * refresh-only ticks (session aggregate updates), so the mapper decides which
 * subscription an event belongs to. The client wrapper owns the V1 wire
 * format, including the directory the internal contract no longer carries.
 */
export function toTuiApi(api: V1Api): TuiApi {
  const v1Messages = api.client.session.messages
  return {
    // V1 is only a structural type here: normalize the members forks may omit
    // so the shared host can stay guard-free.
    state: {
      ...api.state,
      get provider() {
        return api.state.provider ?? []
      },
      part: api.state.part ?? (() => undefined),
    },
    client: {
      session: {
        list: () => api.client.session.list({ query: { directory: api.state.path.directory } }),
        messages: v1Messages
          ? (sessionId, limit) =>
              v1Messages({
                path: { id: sessionId },
                query: { directory: api.state.path.directory, limit },
              }).then((raw) => parseV1MessagePage(raw, limit))
          : undefined,
      },
    },
    event: {
      on: (type, fn) =>
        api.event.on(V1_EVENT_NAMES[type], (event) => {
          const mapped = mapV1Event(type, event)
          if (mapped?.type === type) fn(mapped as Extract<TuiEvent, { type: typeof type }>)
        }),
    },
  }
}

/**
 * V1 SDK message responses are untrusted wire data: a `{ data: [...] }` envelope
 * (or bare array) of `{ info }` entries of every role. Malformed shapes throw
 * so the history loader falls back to the TUI mirror.
 */
export function parseV1MessagePage(raw: unknown, limit: number): SessionMessagesPage {
  const record = isRecord(raw) ? raw : undefined
  const entries = Array.isArray(raw) ? raw : record?.data
  if (!Array.isArray(entries)) throw new Error("malformed V1 message response")
  const messages: AssistantMessage[] = []
  for (const entry of entries) {
    const info = isRecord(entry) && isRecord(entry.info) ? entry.info : undefined
    if (!info || typeof info.role !== "string") throw new Error("malformed V1 message response")
    if (info.role === "assistant") messages.push(info as AssistantMessage)
  }
  return { messages, complete: entries.length < limit }
}

export function mapV1Event(type: TuiEvent["type"], event: unknown): TuiEvent | undefined {
  const properties = propertiesOf(event)
  // Only a full message is actionable; anything else on `message.updated` is a
  // refresh tick.
  if (type === "tick") return isRecord(properties?.info) ? undefined : { type: "tick" }
  if (!properties) return undefined
  if (type === "part") return mapPart(properties.part)
  if (type === "delta") return mapDelta(properties)
  return isRecord(properties.info)
    ? { type: "message", info: properties.info as AssistantMessage }
    : undefined
}

/** Tool parts must keep `state` (V1 alone reports `pending`, needed for TTFT). */
function mapPart(value: unknown): TuiEvent | undefined {
  if (!isRecord(value) || typeof value.type !== "string" || typeof value.messageID !== "string") {
    return undefined
  }
  return { type: "part", part: value as TuiPart }
}

function mapDelta(properties: Record<string, unknown>): TuiEvent | undefined {
  const messageID = properties.messageID
  const field = properties.field
  if (typeof messageID !== "string" || !messageID) return undefined
  // V1 also emits `field: "tool"` deltas for tool-first turns. The contract has
  // no tool delta (V2 never produces one), so they are intentionally dropped;
  // V1 TTFT then relies on the tool part's own timestamps.
  if (field !== "text" && field !== "reasoning") return undefined
  return { type: "delta", messageID, field }
}

function propertiesOf(event: unknown): Record<string, unknown> | undefined {
  if (!isRecord(event)) return undefined
  return isRecord(event.properties) ? event.properties : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
