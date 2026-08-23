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

  test("falls back to the mirror for malformed responses", async () => {
    const result = await loadSessionMessages({
      client: { messages: async () => ({ data: [{ bad: true }] }) },
      sessionId: "s1",
      directory: "/work",
      fallback,
    })
    expect(result.messages).toEqual(fallback)
    expect(result.status).toBe("unavailable")
    expect(result.source).toBe("mirror")
    expect(result.reason).toBe("malformed-response")
  })

  test("falls back when the direct client is unavailable", async () => {
    const result = await loadSessionMessages({
      client: {},
      sessionId: "s1",
      directory: "/work",
      fallback,
    })
    expect(result).toEqual({
      messages: fallback,
      status: "unavailable",
      source: "mirror",
      reason: "missing-client",
    })
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
