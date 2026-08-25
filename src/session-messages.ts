import type { AssistantMessage } from "./types.ts"

/** The API has no total-count field, so keep the request well above the TUI mirror cap. */
export const SESSION_MESSAGE_LIMIT = 10_000

/** TUI state mirror caps at 100 most recent messages; at that size the history may be incomplete. */
export const TUI_MIRROR_LIMIT = 100

export type SessionMessageLoadStatus = "complete" | "capped" | "unavailable"

export type SessionMessageLoadResult = {
  messages: AssistantMessage[]
  status: SessionMessageLoadStatus
  source: "direct" | "mirror"
  reason?: "missing-client" | "request-failed" | "malformed-response" | "limit-reached"
}

type SessionMessagesClient = {
  messages?: (opts: {
    path: { id: string }
    query: { directory: string; limit: number }
  }) => Promise<unknown>
}

function responseEntries(raw: unknown): unknown[] | null {
  if (Array.isArray(raw)) return raw
  if (!raw || typeof raw !== "object") return null
  const data = (raw as { data?: unknown }).data
  return Array.isArray(data) ? data : null
}

function normalizeEntries(entries: readonly unknown[]): AssistantMessage[] | null {
  const messages: AssistantMessage[] = []
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") return null
    const info = (entry as { info?: unknown }).info
    if (!info || typeof info !== "object") return null
    const message = info as AssistantMessage
    if (typeof message.role !== "string") return null
    if (message.role === "assistant") messages.push(message)
  }
  return messages
}

/** A mirror below its cap covers the whole session; only a full mirror may be truncated. */
function fallbackResult(
  fallback: readonly AssistantMessage[],
  reason: "missing-client" | "request-failed" | "malformed-response",
): SessionMessageLoadResult {
  const messages = [...fallback]
  if (messages.length < TUI_MIRROR_LIMIT) {
    return { messages, status: "complete", source: "mirror" }
  }
  return { messages, status: "unavailable", source: "mirror", reason }
}

export async function loadSessionMessages(opts: {
  client: SessionMessagesClient
  sessionId: string
  directory: string
  fallback: readonly AssistantMessage[]
  limit?: number
}): Promise<SessionMessageLoadResult> {
  const fallback = opts.fallback
  const request = opts.client.messages
  if (!request) {
    return fallbackResult(fallback, "missing-client")
  }

  let raw: unknown
  try {
    raw = await request({
      path: { id: opts.sessionId },
      query: { directory: opts.directory, limit: opts.limit ?? SESSION_MESSAGE_LIMIT },
    })
  } catch {
    return fallbackResult(fallback, "request-failed")
  }

  const entries = responseEntries(raw)
  const messages = entries ? normalizeEntries(entries) : null
  if (!entries || !messages) {
    return fallbackResult(fallback, "malformed-response")
  }

  const limit = opts.limit ?? SESSION_MESSAGE_LIMIT
  if (entries.length >= limit) {
    return { messages, status: "capped", source: "direct", reason: "limit-reached" }
  }
  return { messages, status: "complete", source: "direct" }
}
