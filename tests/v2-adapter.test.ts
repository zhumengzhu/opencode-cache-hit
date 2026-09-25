import { describe, test, expect } from "bun:test"
import {
  streamPartsFromContent,
  toAssistantMessage,
  toModelCost,
  toProviderInfos,
  toSessionObject,
  toThemeRecord,
} from "../src/v2/map.ts"
import { createV2Api } from "../src/v2/adapter.ts"
import type { V2Context, V2Event, V2Message, V2Session } from "../src/v2/types.ts"

const assistant = (over: Partial<V2Message> = {}): V2Message => ({
  id: "msg_1",
  type: "assistant",
  agent: "build",
  model: { id: "deepseek-v4", providerID: "deepseek" },
  cost: 0.5,
  finish: "stop",
  time: { created: 1000, completed: 2000 },
  tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 900, write: 25 } },
  content: [],
  ...over,
})

describe("V2 → V1 shape mapping", () => {
  test("assistant message: type→role, model→modelID/providerID, cache tokens", () => {
    const message = toAssistantMessage(assistant(), "ses_1")
    expect(message.role).toBe("assistant")
    expect(message.modelID).toBe("deepseek-v4")
    expect(message.providerID).toBe("deepseek")
    expect(message.tokens?.cache).toEqual({ read: 900, write: 25 })
    expect(message.sessionID).toBe("ses_1")
    expect(message.summary).toBeUndefined()
  })

  test("compaction messages carry the V1 summary flag so they stay unpriced", () => {
    expect(toAssistantMessage(assistant({ type: "compaction" })).summary).toBe(true)
    expect(toAssistantMessage(assistant({ type: "user" })).role).toBe("user")
  })

  test("session object maps model/cost/tokens/parentID", () => {
    const session: V2Session = {
      id: "ses_1",
      parentID: "ses_0",
      model: { id: "m", providerID: "p" },
      cost: 1.25,
      tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } },
    }
    expect(toSessionObject(session)).toEqual({
      model: { id: "m", providerID: "p" },
      cost: 1.25,
      tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } },
      parentID: "ses_0",
    })
    expect(toSessionObject(undefined)).toBeUndefined()
  })

  test("model cost tiers normalize to the V1 context_over_200k shape", () => {
    const cost = toModelCost([
      { input: 1, output: 2, cache: { read: 0.1, write: 0.2 } },
      { tier: { type: "context", size: 300_000 }, input: 3, output: 4, cache: { read: 0.3, write: 0.4 } },
    ])
    expect(cost?.input).toBe(1)
    expect(cost?.context_over_200k?.output).toBe(4)
    expect(cost?.contextThreshold).toBe(300_000)
    expect(toModelCost([])).toBeNull()
    expect(toModelCost(undefined)).toBeNull()
  })

  test("providers nest their models, as V1 lookupModelCost expects", () => {
    const providers = toProviderInfos(
      [{ id: "deepseek" }, { id: "empty" }],
      [
        { id: "deepseek-v4", providerID: "deepseek", cost: [{ input: 1, output: 2, cache: { read: 0, write: 0 } }] },
        { id: "no-cost", providerID: "deepseek" },
      ],
    )
    expect(providers.map((p) => p.id)).toEqual(["deepseek", "empty"])
    expect(providers[0]?.models["deepseek-v4"]?.cost.input).toBe(1)
    expect(providers[0]?.models["no-cost"]).toBeUndefined()
    expect(providers[1]?.models).toEqual({})
  })

  test("semantic theme tokens flatten to the V1 palette keys", () => {
    const flat = toThemeRecord({
      text: {
        base: { r: 1, g: 1, b: 1 },
        muted: { r: 0.5, g: 0.5, b: 0.5 },
        action: { primary: { base: "#8B9DAF" } },
        feedback: { success: { base: "#9CAF8B" }, warning: { base: "#C5B88D" }, error: { base: "#B08A8A" } },
      },
      border: { base: "#6B6B63" },
    })
    expect(flat.primary).toBe("#8B9DAF")
    expect(flat.textMuted).toEqual({ r: 0.5, g: 0.5, b: 0.5 })
    expect(flat.success).toBe("#9CAF8B")
    expect(flat.border).toBe("#6B6B63")
  })

  test("part times come from reasoning/tool content; text parts have none", () => {
    expect(
      streamPartsFromContent([
        { type: "text", text: "hi" },
        { type: "reasoning", time: { created: 5 } },
        { type: "tool", time: { created: 7, ran: 8 } },
      ]),
    ).toEqual([
      { type: "reasoning", time: { start: 5 } },
      { type: "tool", time: { start: 7 } },
    ])
  })
})

/** Minimal stand-in for the V2 context: only what the adapter touches. */
function fakeContext() {
  const messages = new Map<string, V2Message[]>()
  const sessions = new Map<string, V2Session>()
  const handlers = new Map<string, (event: unknown) => void>()
  const synced: string[] = []
  const syncedSessions: string[] = []
  let hasClient = true

  const ctx: V2Context = {
    location: { directory: "/tmp/project" },
    theme: { text: { base: "#fff" } },
    data: {
      session: {
        list: () => [...sessions.values()],
        get: (id) => sessions.get(id),
        sync: async () => {
          syncedSessions.push("all")
        },
        invalidate: () => {},
        message: {
          list: (id) => messages.get(id) ?? [],
          get: (id, messageID) => (messages.get(id) ?? []).find((m) => m.id === messageID),
          sync: async (id) => {
            synced.push(id)
          },
        },
      },
      location: {
        provider: { list: () => [{ id: "deepseek" }], sync: async () => {}, invalidate: () => {} },
        model: {
          list: () => [
            { id: "deepseek-v4", providerID: "deepseek", cost: [{ input: 1, output: 2, cache: { read: 0, write: 0 } }] },
          ],
          sync: async () => {},
          invalidate: () => {},
        },
      },
      on: (type: string, handler: (event: unknown) => void) => {
        handlers.set(type, handler)
        return () => handlers.delete(type)
      },
    },
    ui: { slot: () => () => {} },
  }

  return {
    ctx,
    messages,
    sessions,
    synced,
    syncedSessions,
    emit: (event: V2Event) => handlers.get(event.type)?.(event),
    dropClient: () => {
      hasClient = false
      delete (ctx as { client?: unknown }).client
    },
    withClient: (client: V2Context["client"]) => {
      if (hasClient) ctx.client = client
    },
  }
}

describe("V2 adapter", () => {
  test("live stream events surface as V1 part events and part lookups", () => {
    const fake = fakeContext()
    const api = createV2Api(fake.ctx)
    const seen: Array<Record<string, unknown> | undefined> = []
    api.event.on("message.part.updated", (event) => seen.push(event.properties))

    fake.emit({ type: "session.text.started", created: 1234, data: { sessionID: "ses_1", assistantMessageID: "msg_1" } })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.part).toMatchObject({ type: "text", messageID: "msg_1", time: { start: 1234 } })
    expect(api.state.part("msg_1")).toEqual([{ type: "text", time: { start: 1234 } }])

    fake.emit({ type: "session.reasoning.delta", created: 1240, data: { sessionID: "ses_1", assistantMessageID: "msg_1" } })
    const deltas: Array<Record<string, unknown> | undefined> = []
    api.event.on("message.part.delta", (event) => deltas.push(event.properties))
    fake.emit({ type: "session.reasoning.delta", created: 1241, data: { sessionID: "ses_1", assistantMessageID: "msg_1" } })
    expect(deltas[0]).toEqual({ messageID: "msg_1", field: "reasoning" })
    api.dispose()
  })

  test("tool parts carry callID/name and close with a status", () => {
    const fake = fakeContext()
    const api = createV2Api(fake.ctx)
    const parts: Array<Record<string, unknown> | undefined> = []
    api.event.on("message.part.updated", (event) => parts.push(event.properties?.part as Record<string, unknown>))

    fake.emit({
      type: "session.tool.input.started",
      created: 500,
      data: { sessionID: "ses_1", assistantMessageID: "msg_1", id: "call_1", name: "bash" },
    })
    expect(parts[0]).toMatchObject({
      type: "tool",
      callID: "call_1",
      tool: "bash",
      state: { status: "running", time: { start: 500 } },
    })
    expect(api.state.part("msg_1")).toEqual([{ type: "tool", time: { start: 500 } }])

    fake.emit({ type: "session.tool.success", created: 900, data: { sessionID: "ses_1", id: "call_1" } })
    expect(parts[1]?.state).toMatchObject({ status: "completed", time: { start: 500, end: 900 } })
    api.dispose()
  })

  test("usage updates still tick a refresh; content updates carry the mapped message", () => {
    const fake = fakeContext()
    fake.messages.set("ses_1", [assistant()])
    const api = createV2Api(fake.ctx)
    const seen: Array<Record<string, unknown> | undefined> = []
    api.event.on("message.updated", (event) => seen.push(event.properties))

    fake.emit({ type: "session.usage.updated", created: 1, data: { sessionID: "ses_1" } })
    expect(seen[0]).toEqual({})

    fake.emit({
      type: "session.message.content.updated",
      created: 2,
      data: { sessionID: "ses_1", messageID: "msg_1", content: [{ type: "reasoning", time: { created: 9 } }] },
    })
    const info = seen[1]?.info as { id?: string; sessionID?: string; role?: string }
    expect(info.id).toBe("msg_1")
    expect(info.sessionID).toBe("ses_1")
    expect(info.role).toBe("assistant")
    expect(api.state.part("msg_1")).toEqual([{ type: "reasoning", time: { start: 9 } }])
    api.dispose()
  })

  test("state and client reads map to the V1 surface", async () => {
    const fake = fakeContext()
    fake.sessions.set("ses_1", { id: "ses_1", parentID: "ses_0", time: { created: 10 }, cost: 1, tokens: {} as never })
    fake.messages.set("ses_1", [assistant()])
    fake.withClient({
      message: {
        list: async () => ({ data: [assistant({ id: "msg_2" }), assistant({ id: "msg_1" })] }),
      },
    })
    const api = createV2Api(fake.ctx)

    expect(api.state.path.directory).toBe("/tmp/project")
    expect(api.state.session.get?.("ses_1")?.parentID).toBe("ses_0")
    expect(api.state.session.messages("ses_1").map((m) => m.id)).toEqual(["msg_1"])
    expect(api.state.provider?.[0]?.models["deepseek-v4"]?.cost.input).toBe(1)

    const listed = (await api.client.session.list({ query: { directory: "/tmp/project" } })) as { id: string }[]
    expect(listed.map((s) => s.id)).toEqual(["ses_1"])

    const history = (await api.client.session.messages?.({
      path: { id: "ses_1" },
      query: { directory: "/tmp/project", limit: 10_000 },
    })) as { data: Array<{ info: { id: string } }> }
    expect(history.data.map((entry) => entry.info.id)).toEqual(["msg_1", "msg_2"])
    api.dispose()
  })

  test("an empty message cache triggers one sync and the client is optional", async () => {
    const fake = fakeContext()
    fake.messages.set("ses_2", [])
    const api = createV2Api(fake.ctx)
    api.state.session.messages("ses_2")
    api.state.session.messages("ses_2")
    expect(fake.synced).toEqual(["ses_2"])

    fake.dropClient()
    const history = (await api.client.session.messages?.({
      path: { id: "ses_2" },
      query: { directory: "/", limit: 5 },
    })) as { data: unknown[] }
    expect(history.data).toEqual([])
    api.dispose()
  })
})

describe("dual entrypoint contract", () => {
  test("the default export satisfies both loaders", async () => {
    const mod = (await import("../index.tsx")) as { default: Record<string, unknown> }
    const value = mod.default
    // V2 CLI loader: requires an id and a setup function.
    expect(typeof value.id).toBe("string")
    expect(typeof value.setup).toBe("function")
    // V1 TUI loader: requires tui() and must NOT also export server().
    expect(typeof value.tui).toBe("function")
    expect("server" in value).toBe(false)
  })
})
