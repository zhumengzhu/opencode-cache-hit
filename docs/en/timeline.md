# Timeline / per-call JSONL

For developers. Sidebar aggregation: [design.md](./design.md). User guide: [README.md](../../README.md).

**Phase 1 (JSONL on disk) is implemented**; default `timeline.enabled: false`. Phase 2 sidebar Timeline section and Phase 3 metric modes are not done.

## Goals and non-goals

| Goals | Non-goals |
|-------|-----------|
| Inspect each assistant call’s tokens / cache / cost / hit % over time | Replace OpenCode platform logs (`~/.local/share/opencode/log`) |
| Distinguish main vs child sessions | Spam the TUI with `console.log` |
| Local JSONL for `jq` / scripts | Cloud upload or team sharing |
| Same rules as `stats.ts` (including summary and compaction skips) | SQLite, charts, or recursive sub-agents in v1 |

## Core concept

**One timeline event = one assistant turn**, with `skippedForMetrics` marking summary or compaction rows. Interactive rows use the same source as the sidebar **Hit** row. The timeline does not record tool parts or user messages.

```mermaid
flowchart LR
  MSG[AssistantMessage] --> REC[LlmCallRecord]
  REC --> MEM[in-memory ring last N]
  REC --> JSONL[JSONL append]
  MEM --> UI[sidebar Timeline section optional]
```

| Field | Source |
|-------|--------|
| Sort key | `time.completed ?? time.created` (`timingFromAssistantMessage`) |
| Hit trend eligibility | `summary !== true`, `agent !== "compaction"`, and `input + cache.read > 0` |
| Session totals | `aggregateSessionFromMessages` with the interactive-message predicate |

## Data model

```typescript
export type LlmCallRecord = {
  schema: 1
  recordedAt: string       // ISO 8601 with local timezone offset
  sessionId: string
  rootSessionId: string    // main session; differs for child scope
  scope: "main" | "child"
  messageKey: string
  modelId: string
  providerId?: string      // provider id at record time (older logs may lack it)
  created: string
  completedAt?: string
  durationMs?: number
  isComplete: boolean
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  cost: number
  hitPercent: number | null
  skippedForHit: boolean   // compaction / summary
  skippedForMetrics: boolean // compaction / summary; raw row remains available
  ttftMs?: number          // Time To First Token (firstPartTime - created)
  ttftSource?: "sdk" | "tui"  // TTFT data source
  tps?: number             // Tokens Per Second ((output + reasoning) / genTime * 1000)
  tpot?: number            // Time Per Output Token in ms (genTime / (output + reasoning - 1))
  itlP50?: number          // Inter-Token Latency P50 (ms)
  itlP90?: number          // Inter-Token Latency P90 (ms)
  itlCount?: number        // Number of inter-chunk intervals sampled
  finish?: string          // Finish reason (e.g., "stop", "tool-calls", "error")
  toolDurations?: ToolDurationRecord[]  // from src/tool-timing.ts
}
```

**`toolDurations` (per-tool execution time)**

Optional array of completed tool calls within the assistant turn. Each tool call is associated with the assistant message that triggered it (matched by `messageID`). A single assistant message may trigger multiple tool calls (parallel or sequential); all appear in the same `toolDurations` array.

Captured from `message.part.updated` when a tool part transitions `running → completed` or `running → error`. Omitted when timeline is disabled, no tool parts ran, or part events were missed (no `api.state.part()` backfill, unlike TTFT). The `summary` field is controlled by `timeline.toolSummary`.

| Field | Description |
|-------|-------------|
| `tool` | Tool name (e.g. `bash`, `read`, `grep`) |
| `summary?` | Privacy-safe hint from tool input (see below) |
| `durationMs` | Wall time from part `state.time.start` to `state.time.end` (SDK timestamps preferred) |

**`summary` extraction rules** (truncated for privacy; full data in OpenCode sessions DB):

| Tool | Source | Example |
|------|--------|---------|
| `bash` | `command` (max 60 chars) | `git add scripts/... && git commit --ame...` |
| `read`/`write`/`edit` | `filePath` basename only | `timeline-dashboard.ts` |
| `grep`/`glob` | `pattern` (max 60 chars) | `TODO.*fix` |
| `webfetch` | hostname + pathname (no query, max 80 chars) | `example.com/api/data` |
| `task` | `description` (max 60 chars) | `Find auth implementations` |
| `websearch` | `query` (max 60 chars) | `OpenCode plugin API` |
| `lsp_*` | `filePath` basename only (`lsp_diagnostics`, `lsp_symbols`, …) | `main.ts` |
| `question` | first item `header`, else `question` (max 60 chars) | `Choose color` |

Other tools: `tool` name only; no `summary`.

**Privacy note**: `bash` commands may contain credentials, tokens, or sensitive file paths. The summary is only truncated to 60 chars, not sanitized. Use `toolSummary.bash: false` to exclude command content from logs while keeping other tool summaries.

Only tools that reached `completed` or `error` are included; still-running tools are excluded. If the `running` event was missed, `state.time.start` on the terminal event is used as the start time. If no valid start time can be determined, that tool is omitted from `toolDurations` (no bogus duration).

**In-memory tracker (`toolTiming`)**

`src/tool-timing.ts` keeps a `Map<messageID, ToolTimingEntry[]>` for the current main session. Entries are **not** evicted after JSONL write (same pattern as `firstPartTime`). Memory grows with assistant turns × tools per turn — typically KB to low MB for very long sessions, not a GC leak. Cleared on main session switch (`toolTiming.reset()` in `sidebar-host`) or plugin dispose. v1 does not cap or prune within a session.

**`ttftMs` null handling**

`ttftMs` may be absent when no first-part timestamp was captured for that message. Sidebar **TTFT** uses the same tracker and works **without** `timeline.enabled`; JSONL only includes `ttftMs` when timeline logging is on.

Capture order (see [ttft-hybrid.md](./ttft-hybrid.md)):

1. `message.part.updated` — `part.time.start` on `text` / `reasoning` (sdk)
2. `message.part.delta` — `Date.now()` on first `text` / `reasoning` delta (tui)
3. `message.updated` — scan `api.state.part()` for the earliest valid `time.start` if still missing

When all sources fail (e.g. local models with no parts), `ttftMs` is omitted — expected for some providers.

**`ttftSource` (TTFT data source)**

| Source | Description | Reliability |
|--------|-------------|-------------|
| `"sdk"` | `part.time.start` — SDK's `Date.now()` when first stream chunk arrives (via `message.part.updated` or `api.state.part()` scan) | ✅ Most accurate (excludes local IPC/event-loop latency) |
| `"tui"` | `Date.now()` on first `message.part.delta` | ✅ When BusEvents are delivered |

**Priority logic**: SDK timing is preferred; once an SDK value is set, later TUI events are ignored. TUI values can be upgraded when a valid SDK `time.start` arrives later. Invalid timestamps (`start <= created`) are dropped.

**`messageKey` (dedupe)**

1. Prefer `message.id` / `messageID`.
2. Fallback: `${sessionId}:${created}:${modelID ?? ""}`.

**Streaming**

- **Memory**: `collector.memoryRecords()` appends on each `handleMessage` (capped by `maxMemoryRows`).
- **Disk**: append when `isComplete === true` unless `flushIncomplete: true`.

## Building records

Event-driven path in `sidebar-host.tsx` → `timeline/collector.ts`:

1. `message.updated` delivers one assistant `Message`.
2. `handleMessage(sessionID, msg)` resolves scope (`main` if `sessionID === root`, else `child` if in `childIds`).
3. `assistantMessageToRecord()` in `src/timeline/records.ts` builds one `LlmCallRecord` (reads TTFT from `firstPartTime`, tool durations from `toolTiming`).
4. When `timeline.enabled` and flush rules pass → append one JSONL line.

Record rules (`assistantMessageToRecord`):

- Only `role === assistant`.
- `skippedForHit = !isInteractiveAssistantMessage(msg)`.
- `skippedForMetrics = msg.summary === true || msg.agent === "compaction"`.
- `hitPercent` uses the same per-message logic as `computePerCallHitTrend`.
- Child sessions: same pipeline when `handleMessage` is called for a child `sessionID` in `childIds` (no batch merge in v1).

Timeline collection remains separate from sidebar filtering. With `logSummaryMessages: true`, summary and compaction rows stay in JSONL for diagnostics and carry `skippedForMetrics: true`. They do not change hit, token, speed, cost, savings, or TTL metrics.

## Storage

**Default layout**

```
~/.local/share/opencode/logs/cache-hit/
  timeline-2026-05-31.jsonl       # one active file per local calendar day
  timeline-2026-05-31.jsonl.1     # size rotation backup for that day
```

All main and child sessions for a day share one file; filter by `rootSessionId` / `sessionId` / `scope`. A new date gets a new filename at midnight.

Optional `dir` (e.g. `~/my-logs/`). Supports `~/` expansion to home directory.

**Legacy**: older builds used `<rootSessionId>.jsonl` per main session; not migrated automatically.

**Config** (`cache-hit.config.json` → `timeline`):

```json
{
  "timeline": {
    "enabled": false,
    "dir": "",
    "flushIncomplete": false,
    "logSummaryMessages": true,
    "maxMemoryRows": 50,
    "maxLinesPerFile": 100000,
    "rotateMaxBytes": 16777216,
    "retainRotated": 5,
    "maxAgeDays": 30,
    "maxLogFiles": 20,
    "toolSummary": {
      "allTools": true,
      "bash": false
    }
  }
}
```

Example values above; code defaults below (`enabled: false`, rotation `0` except `retainRotated: 5`).

| Field | Code default | Description |
|-------|--------------|-------------|
| `enabled` | `false` | No IO when off |
| `dir` | `""` | Empty → `~/.local/share/opencode/logs/cache-hit` |
| `flushIncomplete` | `false` | Write only completed turns |
| `logSummaryMessages` | `true` | Include summary rows (flagged) |
| `maxMemoryRows` | `50` | In-memory rows for future UI |
| `maxLinesPerFile` | `0` | Trim active file to last N lines (`0` = off) |
| `rotateMaxBytes` | `0` | Size roll to `.jsonl.1` (`0` = off) |
| `retainRotated` | `5` | Same-day backup files to keep (not counting active) |
| `maxAgeDays` | `0` | On collector start: delete files older than N days (mtime) |
| `maxLogFiles` | `0` | Cap total `timeline-*.jsonl*` files (each `.1` counts) |
| `toolSummary` | `{ allTools: true, bash: false }` | Controls per-tool summary recording (see below) |

**`toolSummary`** controls whether `toolDurations[].summary` is populated. Tool durations (`tool` + `durationMs`) are always recorded; only the privacy-sensitive `summary` field is gated.

| Value | Behavior |
|-------|----------|
| `true` | All tools record summaries |
| `false` | No summaries recorded; only `tool` + `durationMs` |
| `{ allTools, bash?, read?, ... }` | Per-tool control |

**Per-tool object keys**: `allTools` (default for unlisted tools), `bash`, `read`, `write`, `edit`, `grep`, `glob`, `webfetch`, `websearch`, `task`, `question`. Boolean values override `allTools` for that specific tool.

**Recommended**: Set `bash: false` to prevent command content (which may contain credentials or tokens) from being logged:

```json
{ "toolSummary": { "allTools": true, "bash": false } }
```

**Write pipeline** (`writer.ts` + `rotation.ts`)

1. Optional size roll **before** append.
2. `appendFile` one JSON line.
3. Optional line trim **after** append.
4. Event-driven: `message.updated` → `handleMessage()` → fire-and-forget `appendFile`. No polling, no dedup.

## Rotation and retention

### Same-day size rotation (`rotateMaxBytes` + `retainRotated`)

Before each append, if the active file ≥ threshold:

```
active (full)  →  rename  →  .1
old .1         →  rename  →  .2
old .N         →  delete when at retainRotated and rolling again
new empty active file, then append
```

| `retainRotated` | Approx. max per day |
|-----------------|---------------------|
| `5` (default / example) | active + `.1`…`.5` ≈ 6× `rotateMaxBytes` |
| `1` | active + `.1` ≈ 2× |
| `0` | delete active file on roll, no backup |

Oldest backup is **deleted** on further rolls; data is gone permanently.

### Line cap (`maxLinesPerFile`)

Rewrites the **active** file in place; dropped lines are **not** moved to `.1`. With ~500 B/line records, **16MB size roll usually happens before 100k lines**.

### Directory cleanup (once per collector start)

1. `maxAgeDays`: delete `timeline-*.jsonl*` with mtime older than N days.
2. `maxLogFiles`: if still over cap, delete **earliest logs first**: oldest **date in filename**, then highest backup index (`.5` before `.1` before active); mtime only as tie-breaker.

Does **not** match legacy `ses_*.jsonl` names.

### Cross-day

New filename after midnight; previous days remain until cleanup runs.

### Collection

- `message.updated` event carries the full `Message` object. The collector subscribes directly — no polling, no dedup.
- Switching main session: `resetForRootChange()` clears collector memory; `firstPartTime` and `toolTiming` trackers reset in `sidebar-host`; events for the new session arrive naturally. **`timeline` config** (including `enabled`, `toolSummary`, `dir`) is re-read from `cache-hit.json` on main session switch — same as `display` / `cacheTTL`; edits mid-session without switching sessions require a plugin reload.
- Restarts are safe: messages before startup were already written to JSONL in the previous session. No replay, no scan.

## Runtime wiring

```mermaid
sequenceDiagram
  participant E as message.updated
  participant H as sidebar-host
  participant C as timeline/collector
  participant W as timeline/writer

  E->>H: { sessionID, info: Message }
  H->>C: handleMessage(sessionID, info)
  alt assistant and complete
    C->>W: append JSONL (fire-and-forget)
  end
```

- Child ids from `child-session-sync` / `session.list`; timeline writes main and child sessions from events.
- No debounce, no polling. Scope: current TUI root session + its children.

## UI phases

### Phase 1 — disk only (current)

```bash
LOG=~/.local/share/opencode/logs/cache-hit/timeline-$(date +%Y-%m-%d).jsonl
tail -f "$LOG"
# time fields are ISO 8601 strings with local timezone (e.g. "2024-05-30T08:00:00.000+08:00")
jq -r 'select(.rootSessionId=="YOUR_ROOT") | [.created,.scope,.hitPercent,.cost]|@tsv' "$LOG"
```

**Charts (optional scripts)** — see [scripts/README.md](../../scripts/README.md):

```bash
# one-liner: call count + average hit %
python3 -c "import json,sys; r=[json.loads(x) for x in open(sys.argv[1]) if x.strip()]; h=[x['hitPercent'] for x in r if x.get('hitPercent') is not None]; print(f\"{len(r)} calls, avg hit {sum(h)/len(h):.1f}%\")" "$LOG"

bun scripts/plot-hit-rate.ts "$LOG" -o /tmp/hit.svg
bun scripts/plot-hit-rate.ts "$LOG" --by-root -o /tmp/hit-multi.svg

# interactive HTML dashboard (filters, Chart.js); add --open to launch browser
# reads ~/.config/opencode/opencode.json (JSONC-aware) and recomputes costs with
# dynamic pricing (time-of-day / context tiers) — injected as `dynCost`, shown
# with ≈ and counted in charts/totals when it differs from the original cost
bun scripts/timeline-dashboard.ts --open
```

Default log dir matches `timeline.dir` in plugin config (`~/.local/share/opencode/logs/cache-hit/`).

### Phase 2 — sidebar Timeline section (planned)

### Phase 3 — metric window linkage (planned)

## Module map

| Module | Role |
|--------|------|
| `message-timing.ts` | `created` / `completed` |
| `first-part-time.ts` | TTFT tracker (sidebar + JSONL input) |
| `itl-tracker.ts` | ITL chunk-interval tracker (sidebar events → JSONL quantiles) |
| `token-speed.ts` | Pure speed/TPOT calculations (`computeTokenSpeed`, `computeAvgTokenSpeed`, `computeTokenTpotMs`, `computeAvgTokenTpotMs`) |
| `streaming-state.ts` | Streaming phase state machine (`advanceStreamingNow`) |
| `stats.ts` | shared per-message hit % |
| `sidebar-host.tsx` | `createFirstPartTimeTracker`, `createTimelineCollector` |
| `plugin.tsx` | reads config |

## Tests

| Case | File |
|------|------|
| `assistantMessageToRecord` | `tests/timeline-records.test.ts` |
| first-part tracker | `tests/first-part-time.test.ts` |
| ITL tracker | `tests/itl-tracker.test.ts` |
| writer / rotation / purge | `tests/timeline-writer.test.ts`, `timeline-rotation.test.ts` |
| collector | `tests/timeline-collector.test.ts` |

## Risks

| Risk | Mitigation |
|------|------------|
| Too many writes while streaming | `isComplete` only by default (`flushIncomplete: false`) |
| No stable message id | synthetic `messageKey` |
| Nested sub-agents | flat `child` scope only in v1 |
| Disk growth | rotation + age + file count caps |
| SDK changes | `schema: 1` |

## Example line

```json
{"schema":1,"recordedAt":"2024-05-30T08:00:00.000+08:00","sessionId":"sess_main","rootSessionId":"sess_main","scope":"main","messageKey":"sess_main:m1","modelId":"deepseek/v4","created":"2024-05-30T07:59:50.000+08:00","completedAt":"2024-05-30T08:00:00.000+08:00","durationMs":10000,"isComplete":true,"input":1200,"output":80,"reasoning":0,"cacheRead":38000,"cacheWrite":0,"cost":0.012,"hitPercent":96.9,"skippedForHit":false,"skippedForMetrics":false,"ttftMs":944,"ttftSource":"sdk","tps":8.83,"tpot":114.63,"itlP50":12,"itlP90":15,"itlCount":5,"finish":"stop"}
```
