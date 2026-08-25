import { describe, test, expect } from "bun:test"
import { createFirstPartTimeTracker } from "../src/first-part-time.ts"
import { createToolTimingTracker } from "../src/tool-timing.ts"
import { createTimelineCollector } from "../src/timeline/collector.ts"
import { DEFAULT_TIMELINE, type TimelineConfig } from "../src/plugin-config.ts"
import type { AssistantMessage } from "../src/types.ts"
import type { LlmCallRecord } from "../src/timeline/types.ts"

function msg(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    id: "a1",
    time: { created: 1700000000000, completed: 1700000002000 },
    tokens: { input: 10 },
    ...overrides,
  } as AssistantMessage
}

function collector(
  opts: Omit<Parameters<typeof createTimelineCollector>[0], "firstPartTime" | "toolTiming" | "getConfig"> & {
    config?: TimelineConfig
    getConfig?: () => TimelineConfig
    firstPartTime?: ReturnType<typeof createFirstPartTimeTracker>
    toolTiming?: ReturnType<typeof createToolTimingTracker>
  },
) {
  const firstPartTime = opts.firstPartTime ?? createFirstPartTimeTracker()
  const toolTiming = opts.toolTiming ?? createToolTimingTracker()
  const getConfig = opts.getConfig ?? (() => opts.config ?? DEFAULT_TIMELINE)
  const { config: _config, getConfig: _getConfig, ...rest } = opts
  return createTimelineCollector({ ...rest, getConfig, firstPartTime, toolTiming })
}

describe("createTimelineCollector (event-driven)", () => {
  test("writes toolDurations when toolTiming tracker has entries", async () => {
    const toolTiming = createToolTimingTracker()
    toolTiming.handleToolPart("a1", {
      type: "tool",
      tool: "bash",
      callID: "call_1",
      state: { status: "running", input: { command: "ls -la" }, time: { start: 1000 } },
    })
    toolTiming.handleToolPart("a1", {
      type: "tool",
      tool: "bash",
      callID: "call_1",
      state: { status: "completed", time: { start: 1000, end: 1150 } },
    })
    const appended: LlmCallRecord[] = []
    const c = collector({
      config: { ...DEFAULT_TIMELINE, enabled: true },
      getRootSessionId: () => "root1",
      getChildIds: () => [],
      toolTiming,
      append: async (_p, rec) => {
        appended.push(rec)
      },
    })
    c.handleMessage("root1", msg({ id: "a1", time: { created: 1700000000000, completed: 1700000003000 } }))
    await new Promise((r) => setTimeout(r, 50))
    expect(appended).toHaveLength(1)
    expect(appended[0].toolDurations).toEqual([
      { tool: "bash", summary: "ls -la", durationMs: 150 },
    ])
  })

  test("omits summary when config.toolSummary is false", async () => {
    const toolTiming = createToolTimingTracker({
      isSummaryEnabled: () => false,
    })
    toolTiming.handleToolPart("a1", {
      type: "tool",
      tool: "bash",
      callID: "call_1",
      state: { status: "running", input: { command: "ls -la" }, time: { start: 1000 } },
    })
    toolTiming.handleToolPart("a1", {
      type: "tool",
      tool: "bash",
      callID: "call_1",
      state: { status: "completed", time: { start: 1000, end: 1150 } },
    })
    const appended: LlmCallRecord[] = []
    const c = collector({
      config: { ...DEFAULT_TIMELINE, enabled: true, toolSummary: false },
      getRootSessionId: () => "root1",
      getChildIds: () => [],
      toolTiming,
      append: async (_p, rec) => {
        appended.push(rec)
      },
    })
    c.handleMessage("root1", msg({ id: "a1", time: { created: 1700000000000, completed: 1700000003000 } }))
    await new Promise((r) => setTimeout(r, 50))
    expect(appended).toHaveLength(1)
    expect(appended[0].toolDurations).toEqual([
      { tool: "bash", durationMs: 150 },
    ])
  })

  test("writes ttftMs when firstPartTime tracker has entry", async () => {
    const ttft = createFirstPartTimeTracker()
    ttft.handlePart("a1", "text", 1700000000500, "sdk")
    const appended: LlmCallRecord[] = []
    const c = collector({
      config: { ...DEFAULT_TIMELINE, enabled: true },
      getRootSessionId: () => "root1",
      getChildIds: () => [],
      firstPartTime: ttft,
      append: async (_p, rec) => {
        appended.push(rec)
      },
    })
    c.handleMessage("root1", msg({ id: "a1", time: { created: 1700000000000, completed: 1700000003000 } }))
    await new Promise((r) => setTimeout(r, 50))
    expect(appended).toHaveLength(1)
    expect(appended[0].ttftMs).toBe(500)
    expect(appended[0].ttftSource).toBe("sdk")
  })

  test("disabled is no-op", () => {
    const c = collector({
      config: { ...DEFAULT_TIMELINE, enabled: false },
      getRootSessionId: () => "r",
      getChildIds: () => [],
    })
    c.handleMessage("r", msg())
    expect(c.memoryRecords()).toEqual([])
  })

  test("writes complete message on handleMessage call", async () => {
    const appended: LlmCallRecord[] = []
    const c = collector({
      config: { ...DEFAULT_TIMELINE, enabled: true },
      getRootSessionId: () => "root1",
      getChildIds: () => [],
      append: async (_p, rec) => {
        appended.push(rec)
      },
    })
    c.handleMessage("root1", msg({ id: "a1", cost: 0.1 }))
    await new Promise((r) => setTimeout(r, 50))
    expect(appended).toHaveLength(1)
    expect(appended[0].messageKey).toBe("root1:a1")
    expect(appended[0].isComplete).toBe(true)
  })

  test("skips messages for unrelated sessions", () => {
    const appended: LlmCallRecord[] = []
    const c = collector({
      config: { ...DEFAULT_TIMELINE, enabled: true },
      getRootSessionId: () => "root1",
      getChildIds: () => ["child1"],
      append: async (_p, rec) => {
        appended.push(rec)
      },
    })
    c.handleMessage("unrelated-session", msg({ id: "x" }))
    expect(appended).toHaveLength(0)
  })

  test("skips incomplete messages when flushIncomplete is false", () => {
    const appended: LlmCallRecord[] = []
    const c = collector({
      config: { ...DEFAULT_TIMELINE, enabled: true },
      getRootSessionId: () => "r",
      getChildIds: () => [],
      append: async (_p, rec) => {
        appended.push(rec)
      },
    })
    c.handleMessage("r", msg({ id: "inc", time: { created: 1700000000000 } }))
    expect(appended).toHaveLength(0)
  })

  test("writes child session message with correct scope", async () => {
    const appended: LlmCallRecord[] = []
    const c = collector({
      config: { ...DEFAULT_TIMELINE, enabled: true },
      getRootSessionId: () => "root1",
      getChildIds: () => ["child1"],
      append: async (_p, rec) => {
        appended.push(rec)
      },
    })
    c.handleMessage("child1", msg({ id: "c1", cost: 0.05 }))
    await new Promise((r) => setTimeout(r, 50))
    expect(appended).toHaveLength(1)
    expect(appended[0].scope).toBe("child")
    expect(appended[0].rootSessionId).toBe("root1")
  })

  test("does not deduplicate — event-driven contract", () => {
    const appended: LlmCallRecord[] = []
    const c = collector({
      config: { ...DEFAULT_TIMELINE, enabled: true },
      getRootSessionId: () => "r",
      getChildIds: () => [],
      append: async (_p, rec) => {
        appended.push(rec)
      },
    })
    const m = msg({ id: "m1" })
    c.handleMessage("r", m)
    c.handleMessage("r", m)
    c.handleMessage("r", m)
    // Event-driven: no dedup. Each call writes independently.
    // In practice, message.updated fires once per message, so this is safe.
    expect(appended).toHaveLength(3)
  })

  test("resetForRootChange clears memory but not write behavior", () => {
    const c = collector({
      config: { ...DEFAULT_TIMELINE, enabled: true },
      getRootSessionId: () => "r",
      getChildIds: () => [],
      append: async () => {},
    })
    c.handleMessage("r", msg({ id: "m1" }))
    expect(c.memoryRecords()).toHaveLength(1)
    c.resetForRootChange()
    expect(c.memoryRecords()).toEqual([])
    // Can still handle messages after reset
    c.handleMessage("r", msg({ id: "m2" }))
    expect(c.memoryRecords()).toHaveLength(1)
  })

  test("disposed collector ignores messages", () => {
    const appended: LlmCallRecord[] = []
    const c = collector({
      config: { ...DEFAULT_TIMELINE, enabled: true },
      getRootSessionId: () => "r",
      getChildIds: () => [],
      append: async (_p, rec) => {
        appended.push(rec)
      },
    })
    c.dispose()
    c.handleMessage("r", msg())
    expect(appended).toHaveLength(0)
    expect(c.memoryRecords()).toEqual([])
  })

  test("respects logSummaryMessages config", () => {
    const appended: LlmCallRecord[] = []
    const c = collector({
      config: { ...DEFAULT_TIMELINE, enabled: true, logSummaryMessages: false },
      getRootSessionId: () => "r",
      getChildIds: () => [],
      append: async (_p, rec) => {
        appended.push(rec)
      },
    })
    c.handleMessage("r", msg({ id: "sum", summary: true }))
    expect(appended).toHaveLength(0)
    c.handleMessage("r", msg({ id: "normal" }))
    expect(appended).toHaveLength(1)
  })

  test("keeps compaction rows with an explicit metrics skip marker", async () => {
    const appended: LlmCallRecord[] = []
    const c = collector({
      config: { ...DEFAULT_TIMELINE, enabled: true, logSummaryMessages: true },
      getRootSessionId: () => "r",
      getChildIds: () => [],
      append: async (_p, rec) => appended.push(rec),
    })
    c.handleMessage("r", msg({ id: "compact", agent: "compaction" }))
    await new Promise((r) => setTimeout(r, 50))
    expect(appended).toHaveLength(1)
    expect(appended[0].skippedForMetrics).toBe(true)
    expect(appended[0].hitPercent).toBeNull()
  })

  test("sets scope to main for root session messages", async () => {
    const appended: LlmCallRecord[] = []
    const c = collector({
      config: { ...DEFAULT_TIMELINE, enabled: true },
      getRootSessionId: () => "root1",
      getChildIds: () => [],
      append: async (_p, rec) => {
        appended.push(rec)
      },
    })
    c.handleMessage("root1", msg({ id: "m1" }))
    await new Promise((r) => setTimeout(r, 50))
    expect(appended).toHaveLength(1)
    expect(appended[0].scope).toBe("main")
  })

  test("skips user messages", () => {
    const appended: LlmCallRecord[] = []
    const c = collector({
      config: { ...DEFAULT_TIMELINE, enabled: true },
      getRootSessionId: () => "r",
      getChildIds: () => [],
      append: async (_p, rec) => {
        appended.push(rec)
      },
    })
    c.handleMessage("r", msg({ role: "user" }))
    expect(appended).toHaveLength(0)
  })

  test("writes incomplete messages when flushIncomplete is true", () => {
    const appended: LlmCallRecord[] = []
    const c = collector({
      config: { ...DEFAULT_TIMELINE, enabled: true, flushIncomplete: true },
      getRootSessionId: () => "r",
      getChildIds: () => [],
      append: async (_p, rec) => {
        appended.push(rec)
      },
    })
    c.handleMessage("r", msg({ id: "inc", time: { created: 1700000000000 } }))
    expect(appended).toHaveLength(1)
    expect(appended[0].isComplete).toBe(false)
  })

  test("append failure does not crash collector", () => {
    let called = false
    const c = collector({
      config: { ...DEFAULT_TIMELINE, enabled: true },
      getRootSessionId: () => "r",
      getChildIds: () => [],
      append: async () => {
        called = true
        throw new Error("disk full")
      },
    })
    // Should not throw
    c.handleMessage("r", msg({ id: "m1" }))
    // Append was attempted, record added to memory before async write
    expect(called).toBe(true)
    expect(c.memoryRecords()).toHaveLength(1)
  })

  test("memoryRecords respects maxMemoryRows", () => {
    const c = collector({
      config: { ...DEFAULT_TIMELINE, enabled: true, maxMemoryRows: 2 },
      getRootSessionId: () => "r",
      getChildIds: () => [],
      append: async () => {},
    })
    c.handleMessage("r", msg({ id: "a" }))
    c.handleMessage("r", msg({ id: "b" }))
    c.handleMessage("r", msg({ id: "c" }))
    const records = c.memoryRecords()
    expect(records).toHaveLength(2)
    expect(records[0].messageKey).toContain("b")
    expect(records[1].messageKey).toContain("c")
  })
})
