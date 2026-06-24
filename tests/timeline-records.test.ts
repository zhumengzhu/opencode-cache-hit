import { describe, test, expect } from "bun:test"
import { messageKeyFor, assistantMessageToRecord } from "../src/timeline/records.ts"

describe("messageKeyFor", () => {
  test("prefers id", () => {
    expect(
      messageKeyFor({ role: "assistant", id: "m1", time: { created: 1 } }, "s"),
    ).toBe("s:m1")
  })

  test("falls back to created and model", () => {
    expect(
      messageKeyFor(
        { role: "assistant", modelID: "gpt", time: { created: 1000 } },
        "s",
      ),
    ).toBe("s:1000:gpt")
  })
})

describe("assistantMessageToRecord", () => {
  test("calculates TTFT when firstPartTime provided", () => {
    const msg = {
      role: "assistant",
      id: "m1",
      modelID: "gpt-4",
      time: { created: 1000, completed: 3000 },
      tokens: { input: 10, output: 20 },
    }
    const rec = assistantMessageToRecord(msg, "s1", "root", "main", 5000, 1500)
    expect(rec).not.toBeNull()
    expect(rec!.ttftMs).toBe(500) // 1500 - 1000
    expect(rec!.tps).toBeCloseTo(13.33, 2) // 20 / (3000 - 1500) * 1000
  })

  test("TTFT undefined when firstPartTime not provided", () => {
    const msg = {
      role: "assistant",
      id: "m1",
      modelID: "gpt-4",
      time: { created: 1000, completed: 3000 },
      tokens: { input: 10, output: 20 },
    }
    const rec = assistantMessageToRecord(msg, "s1", "root", "main", 5000)
    expect(rec).not.toBeNull()
    expect(rec!.ttftMs).toBeUndefined()
  })

  test("TPS falls back to durationMs when firstPartTime unavailable", () => {
    const msg = {
      role: "assistant",
      id: "m1",
      modelID: "gpt-4",
      time: { created: 1000, completed: 3000 },
      tokens: { input: 10, output: 20 },
    }
    const rec = assistantMessageToRecord(msg, "s1", "root", "main", 5000)
    expect(rec).not.toBeNull()
    expect(rec!.tps).toBe(10) // 20 / 2000 * 1000
  })

  test("TPS undefined when output is 0", () => {
    const msg = {
      role: "assistant",
      id: "m1",
      modelID: "gpt-4",
      time: { created: 1000, completed: 3000 },
      tokens: { input: 10, output: 0 },
    }
    const rec = assistantMessageToRecord(msg, "s1", "root", "main", 5000, 1500)
    expect(rec).not.toBeNull()
    expect(rec!.tps).toBeUndefined()
  })

  test("preserves finish reason", () => {
    const msg = {
      role: "assistant",
      id: "m1",
      modelID: "gpt-4",
      finish: "stop",
      time: { created: 1000, completed: 3000 },
      tokens: { input: 10, output: 20 },
    }
    const rec = assistantMessageToRecord(msg, "s1", "root", "main", 5000)
    expect(rec).not.toBeNull()
    expect(rec!.finish).toBe("stop")
  })

  test("preserves ttftSource when provided", () => {
    const msg = {
      role: "assistant",
      id: "m1",
      modelID: "gpt-4",
      time: { created: 1000, completed: 3000 },
      tokens: { input: 10, output: 20 },
    }
    const rec = assistantMessageToRecord(msg, "s1", "root", "main", 5000, 1500, "sdk")
    expect(rec).not.toBeNull()
    expect(rec!.ttftSource).toBe("sdk")
  })

  test("ttftSource undefined when not provided", () => {
    const msg = {
      role: "assistant",
      id: "m1",
      modelID: "gpt-4",
      time: { created: 1000, completed: 3000 },
      tokens: { input: 10, output: 20 },
    }
    const rec = assistantMessageToRecord(msg, "s1", "root", "main", 5000, 1500)
    expect(rec).not.toBeNull()
    expect(rec!.ttftSource).toBeUndefined()
  })

  test("TTFT undefined when firstPartTime is before created (clock skew)", () => {
    const msg = {
      role: "assistant",
      id: "m1",
      modelID: "gpt-4",
      time: { created: 1000, completed: 3000 },
      tokens: { input: 10, output: 20 },
    }
    const rec = assistantMessageToRecord(msg, "s1", "root", "main", 5000, 500)
    expect(rec).not.toBeNull()
    expect(rec!.ttftMs).toBeUndefined()
    expect(rec!.tps).toBe(10)
  })

  test("includes toolDurations when provided", () => {
    const msg = {
      role: "assistant",
      id: "m1",
      modelID: "gpt-4",
      time: { created: 1000, completed: 3000 },
      tokens: { input: 10, output: 20 },
    }
    const toolDurations = [
      { tool: "bash", summary: "list files", durationMs: 150 },
      { tool: "read", summary: "/home/user/app.ts", durationMs: 12 },
    ]
    const rec = assistantMessageToRecord(msg, "s1", "root", "main", 5000, undefined, undefined, toolDurations)
    expect(rec).not.toBeNull()
    expect(rec!.toolDurations).toEqual(toolDurations)
  })

  test("toolDurations undefined when not provided", () => {
    const msg = {
      role: "assistant",
      id: "m1",
      modelID: "gpt-4",
      time: { created: 1000, completed: 3000 },
      tokens: { input: 10, output: 20 },
    }
    const rec = assistantMessageToRecord(msg, "s1", "root", "main", 5000)
    expect(rec).not.toBeNull()
    expect(rec!.toolDurations).toBeUndefined()
  })

  test("TPOT calculated when tokens > 1 and genTime >= 500ms", () => {
    const msg = {
      role: "assistant",
      id: "m1",
      modelID: "gpt-4",
      time: { created: 1000, completed: 3000 },
      tokens: { input: 10, output: 20, reasoning: 30 },
    }
    const rec = assistantMessageToRecord(msg, "s1", "root", "main", 5000, 1500)
    expect(rec).not.toBeNull()
    expect(rec!.tpot).toBeCloseTo(30.612, 2)
  })

  test("TPOT includes reasoning in token count", () => {
    const msg = {
      role: "assistant",
      id: "m1",
      modelID: "gpt-4",
      time: { created: 1000, completed: 2000 },
      tokens: { input: 10, output: 10, reasoning: 10 },
    }
    const rec = assistantMessageToRecord(msg, "s1", "root", "main", 5000)
    expect(rec).not.toBeNull()
    expect(rec!.tpot).toBeCloseTo(52.632, 2)
  })

  test("TPOT undefined when tokens <= 1", () => {
    const msg = {
      role: "assistant",
      id: "m1",
      modelID: "gpt-4",
      time: { created: 1000, completed: 3000 },
      tokens: { input: 10, output: 1 },
    }
    const rec = assistantMessageToRecord(msg, "s1", "root", "main", 5000, 1500)
    expect(rec).not.toBeNull()
    expect(rec!.tpot).toBeUndefined()
  })

  test("TPOT undefined when genTime < 500ms", () => {
    const msg = {
      role: "assistant",
      id: "m1",
      modelID: "gpt-4",
      time: { created: 1000, completed: 1300 },
      tokens: { input: 10, output: 20 },
    }
    const rec = assistantMessageToRecord(msg, "s1", "root", "main", 5000)
    expect(rec).not.toBeNull()
    expect(rec!.tpot).toBeUndefined()
  })

  test("TPS includes reasoning tokens", () => {
    const msg = {
      role: "assistant",
      id: "m1",
      modelID: "gpt-4",
      time: { created: 1000, completed: 3000 },
      tokens: { input: 10, output: 20, reasoning: 30 },
    }
    const rec = assistantMessageToRecord(msg, "s1", "root", "main", 5000, 1500)
    expect(rec).not.toBeNull()
    expect(rec!.tps).toBeCloseTo(33.33, 1)
  })

  test("TPOT and TPS both undefined when output and reasoning are 0", () => {
    const msg = {
      role: "assistant",
      id: "m1",
      modelID: "gpt-4",
      time: { created: 1000, completed: 3000 },
      tokens: { input: 10, output: 0, reasoning: 0 },
    }
    const rec = assistantMessageToRecord(msg, "s1", "root", "main", 5000, 1500)
    expect(rec).not.toBeNull()
    expect(rec!.tpot).toBeUndefined()
    expect(rec!.tps).toBeUndefined()
  })

  test("includes processId when provided", () => {
    const msg = {
      role: "assistant",
      id: "m1",
      modelID: "gpt-4",
      time: { created: 1000, completed: 3000 },
      tokens: { input: 10, output: 20 },
    }
    // (msg, sessionId, rootSessionId, scope, recordedAt, firstPartTime?, ttftSource?, toolDurations?, itlP50?, itlP90?, itlCount?, processId?)
    const rec = assistantMessageToRecord(msg, "s1", "root", "main", 5000, undefined, undefined, undefined, undefined, undefined, undefined, 4242)
    expect(rec).not.toBeNull()
    expect(rec!.processId).toBe(4242)
  })

  test("processId undefined when not provided", () => {
    const msg = {
      role: "assistant",
      id: "m1",
      modelID: "gpt-4",
      time: { created: 1000, completed: 3000 },
      tokens: { input: 10, output: 20 },
    }
    const rec = assistantMessageToRecord(msg, "s1", "root", "main", 5000)
    expect(rec).not.toBeNull()
    expect(rec!.processId).toBeUndefined()
  })
})
