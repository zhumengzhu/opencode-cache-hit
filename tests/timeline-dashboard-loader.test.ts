import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { expandPattern, loadRecords, injectDynamicCosts, loadOpencodeProviders } from "../scripts/timeline-dashboard.ts"
import { DEFAULT_SCHEDULE } from "../src/dynamic-pricing/types.ts"

const dirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cache-hit-dash-"))
  dirs.push(dir)
  return dir
}

afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })))
})

/** A line that passes `isValidRecord`, with per-test overrides. */
function rec(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema: 1,
    recordedAt: "2026-01-01T10:00:00.000+08:00",
    sessionId: "ses_a",
    rootSessionId: "ses_root",
    scope: "main",
    messageKey: "ses_a:msg_1",
    modelId: "m1",
    created: "2026-01-01T10:00:00.000+08:00",
    isComplete: true,
    input: 1,
    output: 1,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0.1,
    hitPercent: 0,
    skippedForHit: false,
    ...over,
  })
}

async function writeLines(dir: string, name: string, lines: string[]): Promise<string> {
  const path = join(dir, name)
  await writeFile(path, lines.map((l) => l + "\n").join(""))
  return path
}

describe("expandPattern", () => {
  test("expands globs and keeps timeline logs plus rotation backups", async () => {
    const dir = await tempDir()
    await writeLines(dir, "timeline-2026-01-01.jsonl", [rec()])
    await writeLines(dir, "timeline-2026-01-01.jsonl.1", [rec()])
    await writeLines(dir, "notes.txt", ["not a log"])

    const found = await expandPattern(join(dir, "*"))
    expect(found.map((p) => basename(p))).toEqual([
      "timeline-2026-01-01.jsonl",
      "timeline-2026-01-01.jsonl.1",
    ])
  })

  test("returns an absolute path for an existing literal, [] otherwise", async () => {
    const dir = await tempDir()
    const path = await writeLines(dir, "timeline-2026-01-01.jsonl", [rec()])
    expect(await expandPattern(path)).toEqual([path])
    expect(await expandPattern(join(dir, "timeline-2026-01-02.jsonl"))).toEqual([])
  })

  test("glob in a missing directory returns []", async () => {
    expect(await expandPattern(join(tmpdir(), "cache-hit-missing-dir", "*.jsonl"))).toEqual([])
  })

  test("a directory is not returned as a log file", async () => {
    const dir = await tempDir()
    expect(await expandPattern(dir)).toEqual([])
  })
})

describe("loadRecords", () => {
  test("keeps the newest record per messageKey", async () => {
    const dir = await tempDir()
    const path = await writeLines(dir, "timeline-2026-01-01.jsonl", [
      rec({ recordedAt: "2026-01-01T10:00:00.000+08:00", input: 5, isComplete: false }),
      rec({ recordedAt: "2026-01-01T10:05:00.000+08:00", input: 1000 }),
    ])
    const records = await loadRecords([path])
    expect(records.map((r) => r.input)).toEqual([1000])
  })

  test("an incomplete record never replaces a complete one", async () => {
    const dir = await tempDir()
    const path = await writeLines(dir, "timeline-2026-01-01.jsonl", [
      rec({ recordedAt: "2026-01-01T10:00:00.000+08:00", input: 1000 }),
      rec({ recordedAt: "2026-01-01T10:05:00.000+08:00", input: 5, isComplete: false }),
    ])
    const records = await loadRecords([path])
    expect(records.map((r) => r.input)).toEqual([1000])
  })

  test("an older rotation backup read later does not overwrite the active file", async () => {
    const dir = await tempDir()
    // resolveInputPaths sorts ascending, so the backup file is read after the active one.
    const active = await writeLines(dir, "timeline-2026-01-01.jsonl", [
      rec({ recordedAt: "2026-01-01T10:05:00.000+08:00", input: 1000 }),
    ])
    const backup = await writeLines(dir, "timeline-2026-01-01.jsonl.1", [
      rec({ recordedAt: "2026-01-01T10:00:00.000+08:00", input: 5 }),
    ])
    const records = await loadRecords([active, backup])
    expect(records.map((r) => r.input)).toEqual([1000])
  })

  test("records without a messageKey are kept, not collapsed onto one undefined key", async () => {
    const dir = await tempDir()
    const path = await writeLines(dir, "timeline-2026-01-01.jsonl", [
      rec({ messageKey: undefined, input: 1 }),
      rec({ messageKey: undefined, input: 2 }),
    ])
    const records = await loadRecords([path])
    expect(records.map((r) => r.input).sort()).toEqual([1, 2])
  })

  test("drops lines that fail validation", async () => {
    const dir = await tempDir()
    const path = await writeLines(dir, "timeline-2026-01-01.jsonl", [
      rec(),
      JSON.stringify({ schema: 2, created: "2026-01-01T10:00:00.000+08:00" }),
    ])
    expect(await loadRecords([path])).toHaveLength(1)
  })
})

describe("injectDynamicCosts & loadOpencodeProviders", () => {
  test("injects dynCost from cache-hit.json rules even when opencode providers is empty (e.g. acp)", () => {
    const records = [
      JSON.parse(
        rec({
          providerId: "acp",
          modelId: "gemini-4-hydrogen",
          input: 1_000_000,
          output: 100_000,
          cacheRead: 500_000,
          cacheWrite: 0,
          cost: 0,
        }),
      ),
    ]
    const rules = {
      enabled: true,
      timezone: "Asia/Shanghai",
      schedule: DEFAULT_SCHEDULE,
      contextThreshold: 200_000,
      providers: {
        acp: {
          models: {
            "gemini-4-*": {
              cost: { input: 1.5, output: 7.5, cache: { read: 0.075, write: 0 } },
            },
          },
        },
      },
    }
    const injected = injectDynamicCosts(records, [], rules)
    expect(injected).toBe(1)
    expect(records[0].dynCost).toBeCloseTo(1.5 + 0.75 + 0.0375, 6)
  })

  test("loadOpencodeProviders reads opencode.jsonc and V2 providers shape", async () => {
    const dir = await tempDir()
    const path = join(dir, "opencode.jsonc")
    await writeFile(
      path,
      `// jsonc comment
      {
        "providers": {
          "gateway-custom": {
            "models": {
              "gemini-4-hydrogen-xhigh": {
                "cost": { "input": 1.5, "output": 7.5, "cache": { "read": 0.075, "write": 0 } }
              }
            }
          }
        }
      }`,
    )
    const providers = loadOpencodeProviders(path)
    expect(providers).toHaveLength(1)
    expect(providers[0].id).toBe("gateway-custom")
    expect(providers[0].models["gemini-4-hydrogen-xhigh"].cost.input).toBe(1.5)
    expect(providers[0].models["gemini-4-hydrogen-xhigh"].cost.cache.read).toBe(0.075)
  })
})
