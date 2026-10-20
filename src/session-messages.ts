import type { AssistantMessage, TuiApi } from "./types.ts"

/** Requested history size; the API has no total-count field, so keep it well above the TUI mirror cap. */
export const SESSION_MESSAGE_LIMIT = 10_000

/** TUI state mirror caps at 100 most recent messages; at that size the history may be incomplete. */
export const TUI_MIRROR_LIMIT = 100

export type SessionMessageLoadStatus = "complete" | "capped" | "unavailable"

export type SessionMessageLoadResult = {
  messages: AssistantMessage[]
  status: SessionMessageLoadStatus
  source: "direct" | "mirror"
  reason?: "missing-client" | "request-failed"
}

/** A mirror below its cap covers the whole session; only a full mirror may be truncated. */
function fallbackResult(
  fallback: readonly AssistantMessage[],
  reason: "missing-client" | "request-failed",
): SessionMessageLoadResult {
  const messages = [...fallback]
  if (messages.length < TUI_MIRROR_LIMIT) {
    return { messages, status: "complete", source: "mirror" }
  }
  return { messages, status: "unavailable", source: "mirror", reason }
}

/**
 * Load full session history through the version-neutral client contract; the
 * response is already typed (`SessionMessagesPage`), so only failure and
 * mirror-cap fallbacks remain here.
 */
export async function loadSessionMessages(opts: {
  client: Pick<TuiApi["client"]["session"], "messages">
  sessionId: string
  fallback: readonly AssistantMessage[]
  limit?: number
}): Promise<SessionMessageLoadResult> {
  const request = opts.client.messages
  if (!request) {
    return fallbackResult(opts.fallback, "missing-client")
  }
  try {
    const page = await request(opts.sessionId, opts.limit ?? SESSION_MESSAGE_LIMIT)
    return { messages: page.messages, status: page.complete ? "complete" : "capped", source: "direct" }
  } catch {
    return fallbackResult(opts.fallback, "request-failed")
  }
}
