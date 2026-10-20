# Timeline Duplicate Writes: Analysis and Fix

> **Historical record.** Written when the plugin consumed V1 `message.updated` directly. Current event names and the V1/V2 mapping: [design.md § Event mapping](./design.md#event-mapping).

## Overview

Restarting OpenCode used to cause previously-written timeline records to be re-appended to JSONL log files, creating duplicates. **Impact**: 2,727 duplicate records found across 1,218 unique message keys in production logs.

The fix eliminates polling entirely — using `message.updated` events as the data source instead of `api.state.session.messages()`.

## Root Cause

The OpenCode TUI plugin API has two data access patterns:

| API | Behavior |
|-----|----------|
| `api.state.session.messages(sessionId)` | Returns up to 100 messages (capped by TUI sync); no cursor, `since`, or limit parameter on the plugin side |
| `api.event.on("message.updated", handler)` | Fires per-message, carries the **full `Message` object** (cost, tokens, time, modelID, providerID) — see [`types.gen.ts` L1064](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/v2/gen/types.gen.ts#L1064) |

The original collector used the **polling path**: subscribe to `message.updated` → call `schedule()` (500ms debounce) → `collectNow()` → `getMessages()` (TUI-synced window, up to 100 messages) → `buildCallRecords()` (all returned messages) → `shouldFlushToDisk()` (dedup filter). This required a `flushedKeys` Set to skip already-written records.

On restart, `flushedKeys` was lost (it lived in memory only). Every message in the session would be re-flushed to JSONL. A startup scan of all JSONL files was proposed to rebuild the set, adding complexity without addressing the core issue: **polling is the wrong pattern for a write-only log**.

## Solution: Event-Driven Collection

The `message.updated` event fires once per message with the complete `Message` object. The collector subscribes to events directly — no polling, no dedup, no startup scan.

```
message.updated({ sessionID, info: Message })
       ↓
handleMessage(sessionID, info)
       ↓
if (assistant && complete) → assistantMessageToRecord → appendFile
```

### Implementation

**`collector.ts`** — `handleMessage(sessionID, msg)`:

- Determines scope (`main` / `child`) by comparing `sessionID` against root and child IDs
- Skips non-assistant, incomplete (unless `flushIncomplete`), and summary messages (per config)
- Converts to `LlmCallRecord` via `assistantMessageToRecord`
- Writes immediately via `appendTimelineRecord` (fire-and-forget)
- Maintains a bounded in-memory cache (`memoryRecords`)

**`sidebar-host.tsx`** — event wiring:

```typescript
const timeline = createTimelineCollector({
  config: props.timeline,
  getRootSessionId: () => props.sessionId,
  getChildIds: childIds,
})

props.api.event.on("message.updated", (event) => {
  const sid = event.properties?.info?.sessionID
  if (sid && event.properties?.info) {
    timeline.handleMessage(sid, event.properties.info as AssistantMessage)
  }
})
```

### Key Properties

- **No polling**: Zero calls to `getMessages()`. Events drive all writes.
- **No dedup**: Each `message.updated` fires once per message. No `flushedKeys` Set, no JSONL scanning.
- **No startup scan**: The collector is stateless between restarts. Messages written before startup were already logged.
- **Concurrent-safe by design**: Each event is an independent append. `appendFile` uses `O_APPEND` — records (~300 bytes) are well under the 4KB `PIPE_BUF` atomic threshold.
- **Purge unchanged**: `maxAgeDays` / `maxLogFiles` / `maxLinesPerFile` / `rotateMaxBytes` still run as before on collector construction and per-write.

### What #27663 means (and doesn't mean)

[Issue #27663](https://github.com/anomalyco/opencode/issues/27663) reports that `message.part.delta` (a **BusEvent**) is lost on the second `prompt_async` call. This does **not** affect the collector — `message.updated` is a **SyncEvent**, which the issue explicitly confirms is delivered correctly.

## Performance

No startup cost. No memory overhead beyond the in-memory record cache (`maxMemoryRows`, default 50). No per-message IO beyond the JSONL append itself.

## Limitations

Events are forward-only: messages existing before plugin load are not replayed. This is intentional — they were already written to JSONL during the previous session.

When `flushIncomplete` is enabled, a record written before completion will not be updated later. This is the same behavior as before and is documented in the config schema.

## Upstream Context (as of 2026-06-02)

| Issue/PR | Relevance |
|----------|-----------|
| [PR #8535](https://github.com/anomalyco/opencode/pull/8535) — TUI paginated message loading | Open (conflicts). Adds cursor-based pagination to TUI internals. Does not expose pagination to plugin API. |
| [Issue #6548](https://github.com/anomalyco/opencode/issues/6548) — Paginated message loading feature request | Open. Discussion spawned PR #8535. Plugin API not mentioned. |
| [Issue #27663](https://github.com/anomalyco/opencode/issues/27663) — `message.part.delta` lost on second `prompt_async` | Open (v1.15.6). Affects BusEvents only; SyncEvents (`message.updated`) confirmed working. |
| [Issue #26097](https://github.com/anomalyco/opencode/issues/26097) — Plugin API: session projection adapters | Open. Session-level extensions, not message-level. |

No issue or PR proposes `messages(since)` for the plugin API. The `message.updated` event already carries full message data — this capability was underutilized by plugins.

### Ecosystem Patterns

| Plugin | Strategy | Dedup? |
|--------|----------|--------|
| [opencode-visual-cache](https://github.com/Hotakus/opencode-visual-cache) | SolidJS `createEffect` — reactive full recompute | None |
| [opencode-usage](https://github.com/cosmiclasagnadev/opencode-usage) | Per-session reconciliation — clear and rebuild | None |
| **opencode-cache-hit** (this plugin) | Memory stats: `createMemo` full recompute | None |
| | Timeline writes: event-driven via `handleMessage` | None needed |

### Reference Implementations

| Project | Pattern |
|---------|---------|
| OpenCode TUI `sync.tsx` | `message.updated` → `reconcile(info)` → update store |
| [DanWahlin/agent-sdk-core](https://github.com/DanWahlin/agent-sdk-core) | SSE `client.event.subscribe()` → per-event handler |
| [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent) | `client.event.subscribe()` + `client.session.messages()` hybrid |

## Alternatives Considered

| Approach | Verdict |
|----------|---------|
| **Poll + `flushedKeys` Set (memory only)** | Original approach. Restart loses state → duplicates. |
| **Poll + JSONL startup scan** | Implemented on `fix/timeline-dedup-scan-jsonl`. Works correctly but adds scan logic for a problem that shouldn't exist. |
| **Separate `.flushed-keys` file** | Extra state file, extra IO per write, must sync with purge. |
| **Event-driven (current)** | `message.updated` carries full message. No polling, no dedup, no scan. ✅ |

## References

- Linux `open(2)` man page — `O_APPEND` semantics
- Node.js `fs.appendFile` — uses `O_APPEND` internally
- `PIPE_BUF` — POSIX guarantee for atomic writes (4096 bytes on Linux)
- [OpenCode SDK types: `message.updated` event](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/v2/gen/types.gen.ts#L1064)
