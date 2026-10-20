import { describe, test, expect } from "bun:test"
import {
  partsFromContent,
  stepMessage,
  toAssistantMessage,
  toMessageTime,
  toModelCost,
  toProviderInfos,
  toSessionObject,
  toThemeRecord,
} from "../src/v2/map.ts"
import { createV2Api } from "../src/v2/adapter.ts"
import { advanceStreamingNow, initialStreamingTickState } from "../src/streaming-state.ts"
import { createFirstPartTimeTracker } from "../src/first-part-time.ts"
import { createToolTimingTracker } from "../src/tool-timing.ts"
import type { AssistantMessage, TuiEvent, TuiPart } from "../src/types.ts"
import type { V2Context, V2Event, V2Message, V2Session } from "../src/v2/types.ts"
import { V2_EVENT_CASES } from "./fixtures/v2-events.ts"

const assistant = (over: Partial<V2Message> = {}): V2Message => ({
  id: "msg_1",
  type: "assistant",
  agent: "build",
  model: { id: "deepseek-v4", providerID: "deepseek" },
  cost: 0.5,
  finish: "stop",
  time: { created: 1000, completed: 2000 },
  tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 900, write: 25 } },
  ...over,
})

describe("V2 → internal shape mapping", () => {
  test("assistant message: type→role, model→modelID/providerID, cache tokens", () => {
    const message = toAssistantMessage(assistant(), "ses_1")
    expect(message.role).toBe("assistant")
    expect(message.modelID).toBe("deepseek-v4")
    expect(message.providerID).toBe("deepseek")
    expect(message.tokens?.cache).toEqual({ read: 900, write: 25 })
    expect(message.sessionID).toBe("ses_1")
    expect(message.summary).toBeUndefined()
  })

  test("compaction messages stay assistant but flagged so they stay unpriced", () => {
    const compaction = toAssistantMessage(assistant({ type: "compaction" }))
    expect(compaction.summary).toBe(true)
    expect(compaction.role).toBe("assistant")
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

  test("model cost tiers normalize to the contract context_over_200k shape", () => {
    const cost = toModelCost([
      { input: 1, output: 2, cache: { read: 0.1, write: 0.2 } },
      { tier: { type: "context", size: 300_000 }, input: 3, output: 4, cache: { read: 0.3, write: 0.4 } },
    ])
    expect(cost?.input).toBe(1)
    expect(cost?.context_over_200k?.output).toBe(4)
    expect(cost?.contextThreshold).toBe(300_000)
    expect(toModelCost([])).toBeNull()
    expect(toModelCost(undefined)).toBeNull()
    // A tier-only list has no base entry: drop it instead of pricing the tier as base.
    expect(
      toModelCost([{ tier: { type: "context", size: 200_000 }, input: 1, output: 2, cache: { read: 0, write: 0 } }]),
    ).toBeNull()
  })

  test("providers nest their models, as lookupModelCost expects", () => {
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

  test("semantic theme tokens flatten to the panel palette keys", () => {
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

  test("a step message merges row, step meta, and event by field", () => {
    const message = stepMessage({
      row: assistant({
        id: "msg_9",
        agent: "build",
        model: { id: "deepseek/v4", providerID: "deepseek" },
        cost: undefined,
        tokens: undefined,
        finish: undefined,
        time: { created: 500 },
      }),
      meta: { agent: "meta-agent", model: { id: "meta/model", providerID: "meta" }, started: 990 },
      event: {
        type: "session.step.ended",
        created: 2000,
        data: {
          assistantMessageID: "msg_9",
          cost: 9,
          finish: "stop",
          tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 3, write: 0 } },
        },
      },
      sessionID: "ses_1",
    })

    expect(message).toMatchObject({
      id: "msg_9",
      role: "assistant",
      sessionID: "ses_1",
      agent: "build",
      modelID: "deepseek/v4",
      providerID: "deepseek",
      cost: 9,
      finish: "stop",
      time: { created: 500, completed: 2000 },
    })
    expect(message.tokens?.cache?.read).toBe(3)
  })

  test("a failed step defaults its finish to error", () => {
    const message = stepMessage({
      row: undefined,
      meta: undefined,
      event: { type: "session.step.failed", created: 5, data: { assistantMessageID: "msg_1" } },
      sessionID: "ses_1",
      defaultFinish: "error",
    })

    expect(message).toMatchObject({ id: "msg_1", role: "assistant", finish: "error", time: { completed: 5 } })
  })

  test("a row without a creation time maps to no creation time", () => {
    expect(toMessageTime(undefined)).toBeUndefined()
    // The row can carry other time fields; the contract's `created` is required,
    // so they are dropped rather than passed through with an absent `created`.
    expect(toMessageTime({ streamed: 5 })).toBeUndefined()
    expect(toMessageTime({ created: 10, streamed: 5, completed: 20 })).toEqual({ created: 10, completed: 20 })
    expect(toAssistantMessage(assistant({ time: { streamed: 5 } }), "ses_1").time).toBeUndefined()
  })

  test("stored content parts replay as timed parts, text excluded", () => {
    const content = [
      { type: "text", text: "hello" },
      { type: "reasoning", time: { created: 1100, completed: 1200 } },
      { type: "tool", id: "call_1", name: "shell", state: { status: "completed", input: { command: "ls" } }, time: { created: 1300, ran: 1350, completed: 1500 } },
      // `handleToolPart` drops a tool part without both id and name.
      { type: "tool", time: { created: 1400 } },
    ]
    // A leading text part has no stamp, so nothing may seed TTFT; the tool's
    // duration is still replayed from any position.
    expect(partsFromContent(content, 1000)).toEqual([
      {
        type: "tool",
        callID: "call_1",
        tool: "shell",
        state: { status: "completed", time: { start: 1300, end: 1500 }, input: { command: "ls" } },
      },
    ])
    // An unstamped message cannot bound the parts, so nothing is replayed.
    expect(partsFromContent(content, undefined)).toEqual([])
    // A start at or before the message creation is bad data, not a TTFT.
    expect(partsFromContent([{ type: "reasoning", time: { created: 1000 } }], 1000)).toEqual([])
  })

  test("only the first content part seeds TTFT from a stored row", () => {
    const tool = {
      type: "tool",
      id: "call_1",
      name: "shell",
      state: { status: "completed", input: { command: "ls" } },
      time: { created: 1300, ran: 1350, completed: 1500 },
    }
    expect(partsFromContent([{ type: "reasoning", time: { created: 1100 } }, tool], 1000)).toEqual([
      { type: "reasoning", time: { start: 1100 } },
      {
        type: "tool",
        callID: "call_1",
        tool: "shell",
        state: { status: "completed", time: { start: 1300, end: 1500 }, input: { command: "ls" } },
      },
    ])
    // A leading tool carries TTFT itself.
    expect(partsFromContent([tool], 1000)).toEqual([
      {
        type: "tool",
        callID: "call_1",
        tool: "shell",
        time: { start: 1300 },
        state: { status: "completed", time: { start: 1300, end: 1500 }, input: { command: "ls" } },
      },
    ])
  })

  test("an unclosed tool replays as running, never with a fabricated duration", () => {
    const parts = partsFromContent(
      [{ type: "tool", id: "call_1", name: "shell", state: { status: "running", input: { command: "sleep 99" } }, time: { created: 1300, ran: 1350 } }],
      1000,
    )
    expect(parts).toEqual([
      {
        type: "tool",
        callID: "call_1",
        tool: "shell",
        time: { start: 1300 },
        state: { status: "running", time: { start: 1300 }, input: { command: "sleep 99" } },
      },
    ])

    const toolTiming = createToolTimingTracker()
    toolTiming.handleToolPart("msg_1", parts[0]!)
    expect(toolTiming.getDurations("msg_1")).toBeUndefined()
  })

  test("replayed parts restore TTFT and tool durations for the real trackers", () => {
    const firstPart = createFirstPartTimeTracker()
    const toolTiming = createToolTimingTracker()
    const content = [
      { type: "reasoning", time: { created: 1400, completed: 1500 } },
      { type: "tool", id: "call_1", name: "bash", state: { status: "completed", input: { command: "ls" } }, time: { created: 1600, ran: 1700, completed: 1800 } },
    ]
    for (const part of partsFromContent(content, 1000)) {
      if (typeof part.time?.start === "number") firstPart.handlePart("msg_1", part.type, part.time.start, "sdk")
      toolTiming.handleToolPart("msg_1", part)
    }
    expect(firstPart.get().get("msg_1")).toBe(1400)
    expect(firstPart.getSource("msg_1")).toBe("sdk")
    expect(toolTiming.getDurations("msg_1")).toEqual([{ tool: "bash", summary: "ls", durationMs: 200 }])
  })
})

/** Minimal stand-in for the V2 context: only what the adapter touches. */
function fakeContext() {
  const messages = new Map<string, V2Message[]>()
  const sessions = new Map<string, V2Session>()
  /** Every registration, duplicates included: the adapter must subscribe each name once. */
  const registrations: Array<{ type: string; handler: (event: V2Event) => void }> = []
  const synced: string[] = []
  const syncedSessions: string[] = []
  let messageSyncCount = 0
  let messageSyncGate: Promise<void> | undefined
  let messageSyncFailure = false
  let providerSyncs = 0
  let providerSyncFailure = false

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
            messageSyncCount += 1
            if (messageSyncGate) await messageSyncGate
            if (messageSyncFailure) throw new Error("message sync failed")
          },
        },
      },
      location: {
        provider: {
          list: () => [{ id: "deepseek" }],
          sync: async () => {
            providerSyncs += 1
            if (providerSyncFailure) throw new Error("provider sync failed")
          },
          invalidate: () => {},
        },
        model: {
          list: () => [
            { id: "deepseek-v4", providerID: "deepseek", cost: [{ input: 1, output: 2, cache: { read: 0, write: 0 } }] },
          ],
          sync: async () => {},
          invalidate: () => {},
        },
      },
      on: (type: string, handler: (event: V2Event) => void) => {
        const registration = { type, handler }
        registrations.push(registration)
        return () => {
          const index = registrations.indexOf(registration)
          if (index >= 0) registrations.splice(index, 1)
        }
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
    emit: (event: V2Event) => {
      for (const { type, handler } of [...registrations]) if (type === event.type) handler(event)
    },
    subscribed: () => registrations.map((registration) => registration.type),
    setClient: (client?: V2Context["client"]) => {
      if (client) ctx.client = client
      else delete (ctx as { client?: unknown }).client
    },
    providerSyncs: () => providerSyncs,
    failProviderSync: (fail: boolean) => {
      providerSyncFailure = fail
    },
    messageSyncs: () => messageSyncCount,
    failMessageSync: (fail: boolean) => {
      messageSyncFailure = fail
    },
    /** Hold the next `message.sync` open until the returned releaser runs. */
    holdMessageSync: () => {
      let release!: () => void
      messageSyncGate = new Promise<void>((resolve) => {
        release = resolve
      })
      return () => {
        messageSyncGate = undefined
        release()
      }
    },
  }
}

describe("V2 adapter", () => {
  test("location resolved after setup is read lazily", () => {
    const fake = fakeContext()
    fake.ctx.location = undefined
    const api = createV2Api(fake.ctx)
    expect(api.state.path.directory).toBe("")
    fake.ctx.location = { directory: "/tmp/late" }
    expect(api.state.path.directory).toBe("/tmp/late")
    api.dispose()
  })

  test("a failed location sync retries on the next read", async () => {
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
    const fake = fakeContext()
    fake.failProviderSync(true)
    const api = createV2Api(fake.ctx)
    void api.state.provider
    await settle()
    expect(fake.providerSyncs()).toBe(1)

    fake.failProviderSync(false)
    void api.state.provider
    await settle()
    expect(fake.providerSyncs()).toBe(2)

    // A successful sync pins the directory again: no further requests.
    void api.state.provider
    expect(fake.providerSyncs()).toBe(2)
    api.dispose()
  })

  test("bounds cached stream parts to the most recent messages", () => {
    const fake = fakeContext()
    const api = createV2Api(fake.ctx)
    for (let i = 0; i <= 200; i++) {
      fake.emit({ type: "session.text.started", created: i, data: { sessionID: "ses_1", assistantMessageID: `msg_${i}` } })
    }
    expect(api.state.part("msg_0")).toBeUndefined()
    expect(api.state.part("msg_200")).toEqual([{ type: "text", time: { start: 200 } }])
    api.dispose()
  })

  test("bounds tracked tool calls to the most recent ones", () => {
    const fake = fakeContext()
    const api = createV2Api(fake.ctx)
    const parts: TuiPart[] = []
    api.event.on("part", (event) => parts.push(event.part))
    for (let i = 0; i <= 200; i++) {
      fake.emit({
        type: "session.tool.input.started",
        created: i,
        data: { sessionID: "ses_1", assistantMessageID: `msg_${i}`, id: `call_${i}`, name: "bash" },
      })
    }
    parts.length = 0
    // The evicted oldest call can no longer be closed (no message identity to
    // attach the part to); the newest still carries its merged start info.
    fake.emit({ type: "session.tool.success", created: 500, data: { id: "call_0" } })
    fake.emit({ type: "session.tool.success", created: 501, data: { id: "call_200" } })
    expect(parts).toHaveLength(1)
    expect(parts[0]).toMatchObject({ callID: "call_200", messageID: "msg_200", tool: "bash" })
    api.dispose()
  })

  test("messages falls back to the store when no client is available, without claiming completeness", async () => {
    const fake = fakeContext()
    fake.setClient()
    fake.messages.set("ses_1", [assistant()])
    const api = createV2Api(fake.ctx)
    const result = await api.client.session.messages!("ses_1", 10_000)
    expect(result.messages[0]?.id).toBe("msg_1")
    // The host window may hold only its first page, so rows alone prove nothing.
    expect(result.complete).toBe(false)
    api.dispose()
  })

  test("a first store read waits for the in-flight sync instead of guessing", async () => {
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
    const fake = fakeContext()
    fake.setClient()
    const release = fake.holdMessageSync()
    const api = createV2Api(fake.ctx)

    // Nothing re-reads the store once `message.sync` lands, so the first read
    // must wait for it: an empty window before that proves nothing.
    let settled = false
    const cold = api.client.session.messages!("ses_1", 10_000).then((page) => {
      settled = true
      return page
    })
    await settle()
    expect(settled).toBe(false)

    release()
    const landed = await cold
    expect(landed.messages).toEqual([])
    // Empty *and* landed: a real empty session, not a truncation.
    expect(landed.complete).toBe(true)
    expect(fake.messageSyncs()).toBe(1)
    api.dispose()
  })

  test("a failed store sync stays incomplete and is retried by the next read", async () => {
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
    const fake = fakeContext()
    fake.setClient()
    fake.failMessageSync(true)
    const api = createV2Api(fake.ctx)

    const failed = await api.client.session.messages!("ses_1", 10_000)
    expect(failed.messages).toEqual([])
    expect(failed.complete).toBe(false)
    await settle()

    fake.failMessageSync(false)
    const retried = await api.client.session.messages!("ses_1", 10_000)
    expect(retried.complete).toBe(true)
    expect(fake.messageSyncs()).toBe(2)
    api.dispose()
  })

  test("concurrent empty reads share one sync", async () => {
    const fake = fakeContext()
    fake.setClient()
    const release = fake.holdMessageSync()
    const api = createV2Api(fake.ctx)

    const first = api.client.session.messages!("ses_1", 10_000)
    const second = api.client.session.messages!("ses_1", 10_000)
    release()
    const [a, b] = await Promise.all([first, second])
    expect(a.complete).toBe(true)
    expect(b.complete).toBe(true)
    expect(fake.messageSyncs()).toBe(1)
    api.dispose()
  })

  test("a populated window does not wait for the sync", async () => {
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
    const fake = fakeContext()
    fake.setClient()
    const release = fake.holdMessageSync()
    const api = createV2Api(fake.ctx)

    // Start a sync on an empty window (it stays in flight), then let rows land.
    const pending = api.client.session.messages!("ses_1", 10_000)
    await settle()
    fake.messages.set("ses_1", [assistant(), assistant({ id: "msg_2" })])

    // A populated window is already evidence: no need to await the sync.
    const warm = await api.client.session.messages!("ses_1", 10_000)
    expect(warm.messages).toHaveLength(2)
    // Populated, but the fallback cannot prove older rows are absent.
    expect(warm.complete).toBe(false)

    release()
    await pending
    api.dispose()
  })

  test("a populated store window never claims complete history", async () => {
    const fake = fakeContext()
    fake.setClient()
    // The host's page size is internal (20 in current builds), so neither a
    // small nor a page-sized window proves the session is fully loaded.
    fake.messages.set("ses_small", Array.from({ length: 5 }, (_, i) => assistant({ id: `m${i}` })))
    fake.messages.set("ses_full", [
      ...Array.from({ length: 150 }, (_, i) => assistant({ id: `a${i}` })),
      ...Array.from({ length: 50 }, (_, i) => assistant({ id: `u${i}`, type: "user" })),
    ])
    const api = createV2Api(fake.ctx)
    const small = await api.client.session.messages!("ses_small", 10_000)
    expect(small.messages).toHaveLength(5)
    expect(small.complete).toBe(false)
    const full = await api.client.session.messages!("ses_full", 10_000)
    expect(full.messages).toHaveLength(150)
    expect(full.complete).toBe(false)
    api.dispose()
  })

  test("a failed first page falls back to the store", async () => {
    const fake = fakeContext()
    fake.messages.set("ses_1", [assistant()])
    fake.setClient({
      message: {
        list: async () => {
          throw new Error("network")
        },
      },
    })
    const api = createV2Api(fake.ctx)
    const history = await api.client.session.messages!("ses_1", 10_000)
    expect(history.messages.map((m) => m.id)).toEqual(["msg_1"])
    // Falling back is itself a reason to distrust completeness.
    expect(history.complete).toBe(false)
    api.dispose()
  })

  test("live stream events surface as parts and part lookups", () => {
    const fake = fakeContext()
    const api = createV2Api(fake.ctx)
    const seen: TuiPart[] = []
    api.event.on("part", (event) => seen.push(event.part))

    fake.emit({ type: "session.text.started", created: 1234, data: { sessionID: "ses_1", assistantMessageID: "msg_1" } })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ type: "text", messageID: "msg_1", time: { start: 1234 } })

    // Live fragments accumulate into the part; in-flight speed reads this text.
    fake.emit({ type: "session.text.delta", created: 1235, data: { sessionID: "ses_1", assistantMessageID: "msg_1", delta: "hel" } })
    fake.emit({ type: "session.text.delta", created: 1236, data: { sessionID: "ses_1", assistantMessageID: "msg_1", delta: "lo" } })
    expect(api.state.part("msg_1")).toEqual([{ type: "text", time: { start: 1234 }, text: "hello" }])

    // The durable ended event is the authoritative full value.
    fake.emit({ type: "session.text.ended", created: 1240, data: { sessionID: "ses_1", assistantMessageID: "msg_1", text: "hello world" } })
    expect(api.state.part("msg_1")).toEqual([{ type: "text", time: { start: 1234 }, text: "hello world" }])

    const deltas: TuiEvent[] = []
    api.event.on("delta", (event) => deltas.push(event))
    fake.emit({ type: "session.reasoning.started", created: 1241, data: { sessionID: "ses_1", assistantMessageID: "msg_1" } })
    fake.emit({ type: "session.reasoning.delta", created: 1242, data: { sessionID: "ses_1", assistantMessageID: "msg_1", delta: "why" } })
    expect(deltas[0]).toEqual({ type: "delta", messageID: "msg_1", field: "reasoning" })
    expect(api.state.part("msg_1")).toEqual([
      { type: "text", time: { start: 1234 }, text: "hello world" },
      { type: "reasoning", time: { start: 1241 }, text: "why" },
    ])
    api.dispose()
  })

  test("in-flight speed uses accumulated stream text, not just timestamps", () => {
    const fake = fakeContext()
    const api = createV2Api(fake.ctx)
    fake.emit({ type: "session.text.started", created: 1000, data: { sessionID: "ses_1", assistantMessageID: "msg_1" } })
    fake.emit({
      type: "session.text.delta",
      created: 1100,
      data: { sessionID: "ses_1", assistantMessageID: "msg_1", delta: "a".repeat(400) },
    })
    const message = toAssistantMessage(assistant({ time: { created: 1000 } }), "ses_1")
    const tick = advanceStreamingNow(initialStreamingTickState(), {
      messages: [message],
      part: api.state.part,
      now: 3000,
    })
    expect(tick.phase).toBe("active")
    expect(tick.speed).toBeGreaterThan(0)
    api.dispose()
  })

  test("tool parts carry callID/name and close with a status", () => {
    const fake = fakeContext()
    const api = createV2Api(fake.ctx)
    const parts: TuiPart[] = []
    api.event.on("part", (event) => parts.push(event.part))

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

  test("usage updates only tick", () => {
    const fake = fakeContext()
    fake.messages.set("ses_1", [assistant()])
    const api = createV2Api(fake.ctx)
    const infos: AssistantMessage[] = []
    let ticks = 0
    api.event.on("message", (event) => infos.push(event.info))
    api.event.on("tick", () => ticks++)

    fake.emit({ type: "session.usage.updated", created: 1, data: { sessionID: "ses_1" } })
    expect(ticks).toBe(1)
    expect(infos).toHaveLength(0)
    api.dispose()
  })

  test("step events surface as messages when no message-level event exists", () => {
    const fake = fakeContext()
    const api = createV2Api(fake.ctx)
    const infos: AssistantMessage[] = []
    api.event.on("message", (event) => infos.push(event.info))

    fake.emit({
      type: "session.step.started",
      created: 1000,
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_1",
        agent: "build",
        model: { id: "deepseek/flash", providerID: "LLM-DeepSeek" },
        started: 990,
      },
    })
    fake.emit({
      type: "session.step.ended",
      created: 2000,
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_1",
        finish: "stop",
        cost: 0.5,
        tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 100, write: 0 } },
      },
    })

    expect(infos).toHaveLength(1)
    expect(infos[0]).toMatchObject({
      id: "msg_1",
      role: "assistant",
      sessionID: "ses_1",
      agent: "build",
      modelID: "deepseek/flash",
      providerID: "LLM-DeepSeek",
      cost: 0.5,
      finish: "stop",
      time: { created: 990, completed: 2000 },
      tokens: { input: 10, cache: { read: 100 } },
    })
    api.dispose()
  })

  test("a hot reload mid-turn still reports TTFT and tool durations", () => {
    // A reload destroyed the adapter that saw the live part events; the step
    // ends in a fresh instance whose cache is empty. The store row is all that
    // is left, and its timed parts must go out before the message so the host
    // trackers see them.
    const fake = fakeContext()
    fake.messages.set("ses_1", [
      assistant({
        id: "msg_1",
        time: { created: 1000, completed: 2000 },
        content: [
          { type: "reasoning", time: { created: 1400, completed: 1500 } },
          { type: "tool", id: "call_1", name: "shell", state: { status: "completed" }, time: { created: 1600, ran: 1700, completed: 1800 } },
        ],
      }),
    ])
    const api = createV2Api(fake.ctx)
    const seen: TuiEvent[] = []
    for (const type of ["part", "message", "delta", "tick"] as const) {
      api.event.on(type, (event) => seen.push(event))
    }

    fake.emit({ type: "session.step.ended", created: 2000, data: { sessionID: "ses_1", assistantMessageID: "msg_1" } })

    expect(seen.map((event) => event.type)).toEqual(["part", "part", "message"])
    expect(seen[0]).toEqual({ type: "part", part: { type: "reasoning", messageID: "msg_1", time: { start: 1400 } } })
    expect(seen[1]).toMatchObject({
      type: "part",
      part: {
        type: "tool",
        messageID: "msg_1",
        callID: "call_1",
        tool: "shell",
        state: { status: "completed", time: { start: 1600, end: 1800 } },
      },
    })
    // Only the first part seeds TTFT; the reasoning part already did.
    expect((seen[1] as Extract<TuiEvent, { type: "part" }>).part.time).toBeUndefined()
    expect(seen[2]).toMatchObject({ type: "message", info: { id: "msg_1" } })
    api.dispose()
  })

  test("a projected store row wins over the step payload", () => {
    const fake = fakeContext()
    fake.messages.set("ses_1", [assistant({ id: "msg_9", time: { created: 500, completed: 900 } })])
    const api = createV2Api(fake.ctx)
    const infos: AssistantMessage[] = []
    api.event.on("message", (event) => infos.push(event.info))

    fake.emit({
      type: "session.step.ended",
      created: 2000,
      data: { sessionID: "ses_1", assistantMessageID: "msg_9", cost: 9 },
    })

    expect(infos[0]?.cost).toBe(0.5)
    expect(infos[0]?.time).toEqual({ created: 500, completed: 2000 })
    api.dispose()
  })

  test("a step end fills terminal fields the row has not projected yet", () => {
    const fake = fakeContext()
    // Projected at step.started: identity and created time only.
    fake.messages.set("ses_1", [
      assistant({ id: "msg_1", cost: undefined, tokens: undefined, finish: undefined, time: { created: 500 } }),
    ])
    const api = createV2Api(fake.ctx)
    const infos: AssistantMessage[] = []
    api.event.on("message", (event) => infos.push(event.info))

    fake.emit({
      type: "session.step.ended",
      created: 2000,
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_1",
        finish: "stop",
        cost: 0.5,
        tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 100, write: 0 } },
      },
    })

    expect(infos[0]).toMatchObject({ cost: 0.5, finish: "stop", time: { created: 500, completed: 2000 } })
    expect(infos[0]?.tokens?.cache?.read).toBe(100)
    api.dispose()
  })

  test("a failed step is a terminal message too", () => {
    const fake = fakeContext()
    const api = createV2Api(fake.ctx)
    const infos: AssistantMessage[] = []
    api.event.on("message", (event) => infos.push(event.info))

    fake.emit({
      type: "session.step.failed",
      created: 3000,
      data: { sessionID: "ses_1", assistantMessageID: "msg_1", error: { type: "aborted", message: "aborted" } },
    })

    expect(infos).toHaveLength(1)
    expect(infos[0]).toMatchObject({
      id: "msg_1",
      role: "assistant",
      sessionID: "ses_1",
      finish: "error",
      time: { completed: 3000 },
    })
    api.dispose()
  })

  test("state and client reads map to the internal contract", async () => {
    const fake = fakeContext()
    fake.sessions.set("ses_1", { id: "ses_1", parentID: "ses_0", time: { created: 10 }, cost: 1, tokens: {} as never })
    fake.messages.set("ses_1", [assistant()])
    const limits: Array<number | undefined> = []
    fake.setClient({
      message: {
        list: async (input) => {
          limits.push(input.limit)
          return { data: [assistant({ id: "msg_2" }), assistant({ id: "msg_1" })] }
        },
      },
    })
    const api = createV2Api(fake.ctx)

    expect(api.state.path.directory).toBe("/tmp/project")
    expect(api.state.session.get?.("ses_1")?.parentID).toBe("ses_0")
    expect(api.state.session.messages("ses_1")?.map((m) => m.id)).toEqual(["msg_1"])
    expect(api.state.provider?.[0]?.models["deepseek-v4"]?.cost.input).toBe(1)

    const listed = (await api.client.session.list()) as { id: string }[]
    expect(listed.map((s) => s.id)).toEqual(["ses_1"])

    const history = await api.client.session.messages!("ses_1", 10_000)
    expect(history.messages.map((m) => m.id)).toEqual(["msg_1", "msg_2"])
    expect(history.complete).toBe(true)
    // One request returns at most 200 rows; the page size is all the adapter asks for.
    expect(limits).toEqual([200])
    api.dispose()
  })

  test("walks cursor pages until the requested total and returns ascending history", async () => {
    const fake = fakeContext()
    const calls: Array<{ limit?: number; order?: string; cursor?: string }> = []
    fake.setClient({
      message: {
        list: async (input) => {
          calls.push({ limit: input.limit, order: input.order, cursor: input.cursor })
          if (input.cursor === undefined) {
            return { data: [assistant({ id: "msg_4" }), assistant({ id: "msg_3" })], cursor: { next: "c2" } }
          }
          return { data: [assistant({ id: "msg_2" }), assistant({ id: "msg_1" })], cursor: { next: null } }
        },
      },
    })
    const api = createV2Api(fake.ctx)
    const history = await api.client.session.messages!("ses_1", 10_000)

    expect(history.messages.map((m) => m.id)).toEqual(["msg_1", "msg_2", "msg_3", "msg_4"])
    expect(history.complete).toBe(true)
    expect(calls).toEqual([
      { limit: 200, order: "desc", cursor: undefined },
      { limit: 200, order: undefined, cursor: "c2" },
    ])
    api.dispose()
  })

  test("keeps the pages already read when a later page fails", async () => {
    const fake = fakeContext()
    let page = 0
    fake.setClient({
      message: {
        list: async () => {
          page += 1
          if (page === 1) {
            return { data: [assistant({ id: "msg_2" }), assistant({ id: "msg_1" })], cursor: { next: "c2" } }
          }
          throw new Error("network")
        },
      },
    })
    const api = createV2Api(fake.ctx)
    const history = await api.client.session.messages!("ses_1", 10_000)

    expect(history.messages.map((m) => m.id)).toEqual(["msg_1", "msg_2"])
    api.dispose()
  })

  test("an empty message cache triggers one sync and the client is optional", async () => {
    const fake = fakeContext()
    fake.messages.set("ses_2", [])
    const api = createV2Api(fake.ctx)
    api.state.session.messages("ses_2")
    api.state.session.messages("ses_2")
    expect(fake.synced).toEqual(["ses_2"])

    fake.setClient()
    const history = await api.client.session.messages!("ses_2", 5)
    expect(history.messages).toEqual([])
    api.dispose()
  })
})

describe("V2 event contract", () => {
  test("every subscription is covered by a recorded payload case", () => {
    const fake = fakeContext()
    const api = createV2Api(fake.ctx)
    const subscribed = fake.subscribed()
    // Registering a name twice would silently shadow the first handler in the host.
    expect(subscribed.length).toBe(new Set(subscribed).size)
    const covered = new Set(V2_EVENT_CASES.flatMap((testCase) => testCase.events.map((event) => event.type)))
    expect([...covered].sort()).toEqual([...subscribed].sort())
    api.dispose()
  })

  for (const [index, testCase] of V2_EVENT_CASES.entries()) {
    const names = [...new Set(testCase.events.map((event) => event.type))].join(" → ")
    test(`case ${index + 1}: ${names}`, () => {
      const fake = fakeContext()
      const api = createV2Api(fake.ctx)
      const seen: TuiEvent[] = []
      for (const type of ["part", "message", "delta", "tick"] as const) {
        api.event.on(type, (event) => seen.push(event))
      }
      for (const event of testCase.events) fake.emit(event)
      expect(seen).toEqual(testCase.emits)
      if (testCase.parts) {
        expect(api.state.part(testCase.parts.messageID)).toEqual(testCase.parts.expect)
      }
      api.dispose()
    })
  }
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
