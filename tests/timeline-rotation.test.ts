import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { readFile, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdtemp } from "node:fs/promises"
import { rotateFileBySize, trimFileToMaxLines } from "../src/timeline/rotation.ts"
import {
  appendTimelineRecord,
  compareTimelineLogsForPurge,
  parseTimelineLogBasename,
  purgeTimelineLogsOverCount,
} from "../src/timeline/writer.ts"
import type { LlmCallRecord } from "../src/timeline/types.ts"

const baseRecord = (): LlmCallRecord => ({
  schema: 1,
  recordedAt: 1,
  sessionId: "s",
  rootSessionId: "s",
  scope: "main",
  messageKey: "s:k",
  modelId: "",
  created: 1,
  isComplete: true,
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  hitPercent: null,
  skippedForHit: false,
  skippedForMetrics: false,
})

describe("trimFileToMaxLines", () => {
  let dir = ""

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ch-trim-"))
  })
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  test("keeps last N lines", async () => {
    const path = join(dir, "a.jsonl")
    await writeFile(path, "1\n2\n3\n4\n5\n", "utf8")
    await trimFileToMaxLines(path, 3)
    expect((await readFile(path, "utf8")).trim().split("\n")).toEqual(["3", "4", "5"])
  })
})

describe("rotateFileBySize", () => {
  let dir = ""

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ch-rot-"))
  })
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  test("rolls to .jsonl.1 when over limit", async () => {
    const path = join(dir, "s.jsonl")
    await writeFile(path, "x".repeat(100), "utf8")
    await rotateFileBySize(path, 50, 1)
    await expect(stat(path)).rejects.toThrow()
    expect((await readFile(`${path}.1`, "utf8")).length).toBe(100)
  })
})

describe("purgeTimelineLogsOverCount", () => {
  let dir = ""

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ch-cap-"))
  })
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  test("deletes earliest calendar day when over cap", async () => {
    const a = join(dir, "timeline-2026-01-01.jsonl")
    const b = join(dir, "timeline-2026-01-02.jsonl")
    const c = join(dir, "timeline-2026-01-03.jsonl")
    await writeFile(a, "1\n", "utf8")
    await new Promise((r) => setTimeout(r, 5))
    await writeFile(b, "2\n", "utf8")
    await new Promise((r) => setTimeout(r, 5))
    await writeFile(c, "3\n", "utf8")
    await purgeTimelineLogsOverCount(dir, 2)
    await expect(stat(a)).rejects.toThrow()
    expect(await stat(b)).toBeDefined()
    expect(await stat(c)).toBeDefined()
  })

  test("prefers earliest date over newer mtime", async () => {
    const old = join(dir, "timeline-2026-01-01.jsonl")
    const recent = join(dir, "timeline-2026-01-03.jsonl")
    await writeFile(old, "1\n", "utf8")
    await writeFile(recent, "3\n", "utf8")
    const now = Date.now()
    await writeFile(old, "1\n", "utf8")
    // bump mtime on Jan 3 so it is newest on disk
    const { utimes } = await import("node:fs/promises")
    await utimes(recent, now / 1000, now / 1000)
    await utimes(old, (now - 86_400_000) / 1000, (now - 86_400_000) / 1000)
    await purgeTimelineLogsOverCount(dir, 1)
    await expect(stat(old)).rejects.toThrow()
    expect(await stat(recent)).toBeDefined()
  })

  test("deletes higher backup roll before active on same day", async () => {
    const active = join(dir, "timeline-2026-05-31.jsonl")
    const bak2 = join(dir, "timeline-2026-05-31.jsonl.2")
    const bak1 = join(dir, "timeline-2026-05-31.jsonl.1")
    await writeFile(active, "a\n", "utf8")
    await writeFile(bak1, "b\n", "utf8")
    await writeFile(bak2, "c\n", "utf8")
    await purgeTimelineLogsOverCount(dir, 2)
    await expect(stat(bak2)).rejects.toThrow()
    expect(await stat(bak1)).toBeDefined()
    expect(await stat(active)).toBeDefined()
  })
})

describe("parseTimelineLogBasename", () => {
  test("active and rolls", () => {
    expect(parseTimelineLogBasename("timeline-2026-05-31.jsonl")).toEqual({
      dateKey: "2026-05-31",
      roll: 0,
    })
    expect(parseTimelineLogBasename("timeline-2026-05-31.jsonl.3")).toEqual({
      dateKey: "2026-05-31",
      roll: 3,
    })
  })

  test("compareTimelineLogsForPurge orders delete-first", () => {
    expect(
      compareTimelineLogsForPurge(
        "/l/timeline-2026-01-01.jsonl",
        "/l/timeline-2026-01-02.jsonl",
      ),
    ).toBeLessThan(0)
    expect(
      compareTimelineLogsForPurge(
        "/l/timeline-2026-05-31.jsonl.2",
        "/l/timeline-2026-05-31.jsonl",
      ),
    ).toBeLessThan(0)
  })
})

describe("appendTimelineRecord rotation", () => {
  let dir = ""

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ch-append-"))
  })
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  test("trims after append when maxLinesPerFile set", async () => {
    const path = join(dir, "t.jsonl")
    for (let i = 0; i < 5; i++) {
      await appendTimelineRecord(
        path,
        { ...baseRecord(), messageKey: `s:${i}` },
        { maxLinesPerFile: 3, rotateMaxBytes: 0, retainRotated: 1 },
      )
    }
    expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(3)
  })
})
