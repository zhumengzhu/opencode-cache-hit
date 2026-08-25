import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  appendTimelineRecord,
  localDateKey,
  serializeRecord,
  timelineDailyLogPath,
} from "../src/timeline/writer.ts"
import type { LlmCallRecord } from "../src/timeline/types.ts"

const sample: LlmCallRecord = {
  schema: 1,
  recordedAt: 1,
  sessionId: "sess",
  rootSessionId: "sess",
  scope: "main",
  messageKey: "sess:k1",
  modelId: "m",
  created: 100,
  completedAt: 200,
  durationMs: 100,
  isComplete: true,
  input: 10,
  output: 5,
  reasoning: 0,
  cacheRead: 50,
  cacheWrite: 0,
  cost: 0.01,
  hitPercent: 83.33,
  skippedForHit: false,
  skippedForMetrics: false,
}

describe("timeline writer", () => {
  let dir = ""

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cache-hit-log-"))
  })

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  test("serializeRecord is one JSON line", () => {
    const line = serializeRecord(sample)
    expect(line.endsWith("\n")).toBe(true)
    expect(JSON.parse(line.trim()).messageKey).toBe("sess:k1")
  })

  test("localDateKey is YYYY-MM-DD", () => {
    expect(localDateKey(Date.UTC(2026, 4, 31, 12))).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  test("timelineDailyLogPath uses date prefix", () => {
    expect(timelineDailyLogPath(dir, "2026-05-31")).toBe(
      join(dir, "timeline-2026-05-31.jsonl"),
    )
  })

  test("appendTimelineRecord creates file", async () => {
    const path = timelineDailyLogPath(dir, "2026-05-31")
    await appendTimelineRecord(path, sample)
    const text = await readFile(path, "utf8")
    expect(text.split("\n").filter(Boolean)).toHaveLength(1)
  })
})
