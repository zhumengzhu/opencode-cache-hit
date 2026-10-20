import { describe, test, expect } from "bun:test"
import { mapV1Event, parseV1MessagePage, toTuiApi } from "../src/v1-map.ts"
import type { TuiEvent } from "../src/types.ts"

describe("V1 event mapping", () => {
  test("parts pass through with message identity and tool state", () => {
    const part = {
      type: "tool",
      messageID: "msg_1",
      callID: "call_1",
      tool: "bash",
      state: { status: "pending", input: { command: "ls" } },
      time: { start: 1000 },
    }
    expect(mapV1Event("part", { properties: { part } })).toEqual({ type: "part", part })
  })

  test("malformed parts are dropped instead of reaching the host", () => {
    expect(mapV1Event("part", { properties: { part: { type: "text" } } })).toBeUndefined()
    expect(mapV1Event("part", { properties: { part: { messageID: "msg_1" } } })).toBeUndefined()
    expect(mapV1Event("part", { properties: { part: null } })).toBeUndefined()
    expect(mapV1Event("part", {})).toBeUndefined()
    expect(mapV1Event("part", undefined)).toBeUndefined()
  })

  test("deltas keep only known stream fields", () => {
    expect(mapV1Event("delta", { properties: { messageID: "msg_1", field: "text" } })).toEqual({
      type: "delta",
      messageID: "msg_1",
      field: "text",
    })
    expect(mapV1Event("delta", { properties: { messageID: "msg_1", field: "reasoning" } })).toEqual({
      type: "delta",
      messageID: "msg_1",
      field: "reasoning",
    })
    expect(mapV1Event("delta", { properties: { messageID: "msg_1", field: "tool" } })).toBeUndefined()
    expect(mapV1Event("delta", { properties: { field: "text" } })).toBeUndefined()
    expect(mapV1Event("delta", { properties: { messageID: "", field: "text" } })).toBeUndefined()
  })

  test("message.updated is a message when it carries one, otherwise only a tick", () => {
    const info = { id: "msg_1", role: "assistant", sessionID: "ses_1" }
    expect(mapV1Event("message", { properties: { info } })).toEqual({ type: "message", info })
    expect(mapV1Event("message", { properties: {} })).toBeUndefined()
    expect(mapV1Event("tick", { properties: { info } })).toBeUndefined()
    expect(mapV1Event("tick", { properties: {} })).toEqual({ type: "tick" })
    expect(mapV1Event("tick", {})).toEqual({ type: "tick" })
  })
})

describe("toTuiApi", () => {
  /** V1 allows several handlers per event name; `message.updated` has two. */
  function fakeV1Api() {
    const handlers = new Map<string, Set<(event: unknown) => void>>()
    return {
      api: {
        state: {
          path: { directory: "/tmp/project" },
          provider: [],
          session: { messages: () => [] },
          part: () => undefined,
        },
        client: { session: { list: async () => ({}) } },
        event: {
          on: (name: string, fn: (event: unknown) => void) => {
            const set = handlers.get(name) ?? new Set<(event: unknown) => void>()
            set.add(fn)
            handlers.set(name, set)
            return () => set.delete(fn)
          },
        },
      },
      fire: (name: string, event: unknown) => {
        for (const fn of handlers.get(name) ?? []) fn(event)
      },
    }
  }

  test("subscribes by V1 event name and delivers only the matching variant", () => {
    const { api, fire } = fakeV1Api()
    const tui = toTuiApi(api)
    const events: TuiEvent[] = []
    tui.event.on("part", (event) => events.push(event))
    tui.event.on("tick", (event) => events.push(event))

    fire("message.part.updated", { properties: { part: { type: "text", messageID: "msg_1" } } })
    expect(events).toEqual([{ type: "part", part: { type: "text", messageID: "msg_1" } }])

    // A full message reaches `message` subscribers, not the tick subscriber.
    fire("message.updated", { properties: { info: { id: "msg_1", role: "assistant" } } })
    expect(events).toHaveLength(1)
    fire("message.updated", { properties: {} })
    expect(events[1]).toEqual({ type: "tick" })
  })

  test("unsubscribe stops delivery", () => {
    const { api, fire } = fakeV1Api()
    const tui = toTuiApi(api)
    const deltas: TuiEvent[] = []
    const off = tui.event.on("delta", (event) => deltas.push(event))

    fire("message.part.delta", { properties: { messageID: "msg_1", field: "text" } })
    off()
    fire("message.part.delta", { properties: { messageID: "msg_1", field: "text" } })
    expect(deltas).toEqual([{ type: "delta", messageID: "msg_1", field: "text" }])
  })

  test("forks without provider/part get safe defaults", () => {
    const tui = toTuiApi({
      state: { path: { directory: "/tmp" }, session: { messages: () => [] } },
      client: { session: { list: async () => ({}) } },
      event: { on: () => () => {} },
    })
    expect(tui.state.provider).toEqual([])
    expect(tui.state.part("msg_1")).toBeUndefined()
  })

  test("state reads are forwarded unchanged", () => {
    const { api } = fakeV1Api()
    const tui = toTuiApi(api)
    // `state` is normalized into a copy, so the members are forwarded by reference.
    expect(tui.state.path).toBe(api.state.path)
    expect(tui.state.session).toBe(api.state.session)
    expect(tui.state.provider).toBe(api.state.provider)
    expect(tui.state.part).toBe(api.state.part)
  })

  test("client.list forwards the V1 directory query", async () => {
    const requests: unknown[] = []
    const tui = toTuiApi({
      state: { path: { directory: "/tmp/project" }, session: { messages: () => [] } },
      client: {
        session: {
          list: async (opts) => {
            requests.push(opts)
            return { data: [] }
          },
        },
      },
      event: { on: () => () => {} },
    })
    await tui.client.session.list()
    expect(requests).toEqual([{ query: { directory: "/tmp/project" } }])
  })

  test("client.messages wraps the V1 envelope into a typed page", async () => {
    const requests: unknown[] = []
    const tui = toTuiApi({
      state: { path: { directory: "/tmp/project" }, session: { messages: () => [] } },
      client: {
        session: {
          list: async () => ({ data: [] }),
          messages: async (opts) => {
            requests.push(opts)
            return {
              data: [
                { info: { role: "user", id: "u1" }, parts: [] },
                { info: { role: "assistant", id: "a1", modelID: "gpt-5.6" }, parts: [] },
              ],
            }
          },
        },
      },
      event: { on: () => () => {} },
    })
    const page = await tui.client.session.messages?.("s1", 10)
    expect(requests).toEqual([{ path: { id: "s1" }, query: { directory: "/tmp/project", limit: 10 } }])
    expect(page).toEqual({
      messages: [{ role: "assistant", id: "a1", modelID: "gpt-5.6" }],
      complete: true,
    })
  })

  test("client.messages is absent when the V1 client lacks it", () => {
    const tui = toTuiApi({
      state: { path: { directory: "/tmp" }, session: { messages: () => [] } },
      client: { session: { list: async () => ({ data: [] }) } },
      event: { on: () => () => {} },
    })
    expect(tui.client.session.messages).toBeUndefined()
  })
})

describe("parseV1MessagePage", () => {
  test("accepts the { data: [{ info }] } envelope and a bare array, keeping assistant rows only", () => {
    const envelope = { data: [{ info: { role: "user", id: "u1" } }, { info: { role: "assistant", id: "a1" } }] }
    expect(parseV1MessagePage(envelope, 10)).toEqual({
      messages: [{ role: "assistant", id: "a1" }],
      complete: true,
    })
    expect(parseV1MessagePage([envelope.data[1]], 10)).toEqual({
      messages: [{ role: "assistant", id: "a1" }],
      complete: true,
    })
  })

  test("an entry count at the limit means the history may be capped", () => {
    const entries = Array.from({ length: 2 }, (_, i) => ({ info: { role: "assistant", id: String(i) } }))
    expect(parseV1MessagePage({ data: entries }, 2).complete).toBe(false)
    expect(parseV1MessagePage({ data: entries }, 3).complete).toBe(true)
  })

  test("malformed shapes throw so the loader falls back to the mirror", () => {
    expect(() => parseV1MessagePage({ data: [{ bad: true }] }, 10)).toThrow()
    expect(() => parseV1MessagePage({ data: [{ info: { role: 1 } }] }, 10)).toThrow()
    expect(() => parseV1MessagePage(null, 10)).toThrow()
    expect(() => parseV1MessagePage({ data: "no" }, 10)).toThrow()
  })
})
