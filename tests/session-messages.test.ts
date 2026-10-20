import { describe, expect, test } from "bun:test"
import { loadSessionMessages, SESSION_MESSAGE_LIMIT } from "../src/session-messages.ts"

const fallback = [{ role: "assistant", id: "mirror", tokens: { input: 1 } }]

describe("loadSessionMessages", () => {
  test("requests by session id and limit, and maps completeness to the status", async () => {
    let request: unknown[] = []
    const result = await loadSessionMessages({
      client: {
        messages: async (sessionId, limit) => {
          request = [sessionId, limit]
          return { messages: [{ role: "assistant", id: "a1", modelID: "gpt-5.6" }], complete: true }
        },
      },
      sessionId: "s1",
      fallback,
    })
    expect(request).toEqual(["s1", SESSION_MESSAGE_LIMIT])
    expect(result).toEqual({
      messages: [{ role: "assistant", id: "a1", modelID: "gpt-5.6" }],
      status: "complete",
      source: "direct",
    })
  })

  test("an incomplete page is capped", async () => {
    const result = await loadSessionMessages({
      client: { messages: async () => ({ messages: [], complete: false }) },
      sessionId: "s1",
      fallback,
    })
    expect(result.status).toBe("capped")
    expect(result.source).toBe("direct")
  })

  test("falls back to the mirror when the request fails (below mirror cap → complete)", async () => {
    const result = await loadSessionMessages({
      client: {
        messages: async () => {
          throw new Error("network")
        },
      },
      sessionId: "s1",
      fallback,
    })
    expect(result.messages).toEqual(fallback)
    expect(result.status).toBe("complete")
    expect(result.source).toBe("mirror")
  })

  test("falls back when the direct client is unavailable (below mirror cap → complete)", async () => {
    const result = await loadSessionMessages({
      client: {},
      sessionId: "s1",
      fallback,
    })
    expect(result).toEqual({
      messages: fallback,
      status: "complete",
      source: "mirror",
    })
  })

  test("marks a full mirror as unavailable (may be truncated)", async () => {
    const fullMirror = Array.from({ length: 100 }, (_, i) => ({
      role: "assistant" as const,
      id: `m${i}`,
      tokens: { input: 1 },
    }))
    const result = await loadSessionMessages({
      client: {},
      sessionId: "s1",
      fallback: fullMirror,
    })
    expect(result.status).toBe("unavailable")
    expect(result.source).toBe("mirror")
    expect(result.reason).toBe("missing-client")
  })
})
