import { describe, expect, test } from "bun:test"
import { loadSessionMessages, SESSION_MESSAGE_LIMIT } from "../src/session-messages.ts"

const fallback = [{ role: "assistant", id: "mirror", tokens: { input: 1 } }]

describe("loadSessionMessages", () => {
  test("loads assistant info from the direct session endpoint", async () => {
    let request: unknown
    const result = await loadSessionMessages({
      client: {
        messages: async (opts) => {
          request = opts
          return {
            data: [
              { info: { role: "user", id: "u1" }, parts: [] },
              { info: { role: "assistant", id: "a1", modelID: "gpt-5.6" }, parts: [] },
            ],
          }
        },
      },
      sessionId: "s1",
      directory: "/work",
      fallback,
    })
    expect(request).toEqual({
      path: { id: "s1" },
      query: { directory: "/work", limit: SESSION_MESSAGE_LIMIT },
    })
    expect(result).toEqual({
      messages: [{ role: "assistant", id: "a1", modelID: "gpt-5.6" }],
      status: "complete",
      source: "direct",
    })
  })

  test("accepts an empty complete response", async () => {
    const result = await loadSessionMessages({
      client: { messages: async () => [] },
      sessionId: "s1",
      directory: "/work",
      fallback,
    })
    expect(result).toEqual({ messages: [], status: "complete", source: "direct" })
  })

  test("falls back to the mirror for malformed responses (below mirror cap → complete)", async () => {
    const result = await loadSessionMessages({
      client: { messages: async () => ({ data: [{ bad: true }] }) },
      sessionId: "s1",
      directory: "/work",
      fallback,
    })
    expect(result.messages).toEqual(fallback)
    expect(result.status).toBe("complete")
    expect(result.source).toBe("mirror")
    expect(result.reason).toBeUndefined()
  })

  test("falls back when the direct client is unavailable (below mirror cap → complete)", async () => {
    const result = await loadSessionMessages({
      client: {},
      sessionId: "s1",
      directory: "/work",
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
      directory: "/work",
      fallback: fullMirror,
    })
    expect(result.status).toBe("unavailable")
    expect(result.source).toBe("mirror")
    expect(result.reason).toBe("missing-client")
  })

  test("marks an exact limit response as potentially capped", async () => {
    const result = await loadSessionMessages({
      client: { messages: async () => Array.from({ length: 2 }, (_, i) => ({ info: { role: "assistant", id: String(i) }, parts: [] })) },
      sessionId: "s1",
      directory: "/work",
      fallback,
      limit: 2,
    })
    expect(result.status).toBe("capped")
    expect(result.source).toBe("direct")
    expect(result.reason).toBe("limit-reached")
  })
})
