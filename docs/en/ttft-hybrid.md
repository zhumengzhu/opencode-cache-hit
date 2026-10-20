# TTFT Hybrid Implementation

This document describes how opencode-cache-hit measures **Time To First Token (TTFT)** and **generation-speed denominators** in the sidebar **Speed** section (and in optional timeline JSONL when `timeline.enabled` is true).

> **Event names**: this document uses the plugin's internal event contract (`TuiEvent` in `src/types.ts`): `part` / `message` / `delta` / `tick`. OpenCode 1 (`message.part.updated`, `message.updated`, …) and OpenCode 2 (`session.text.started`, `session.step.ended`, …) source events are mapped onto it in `v1-map.ts` / `v2/adapter.ts`; see [design.md § Event mapping](./design.md#event-mapping).

## Background

OpenCode exposes optional per-part timing:

```typescript
type TextPart = {
  time?: { start: number; end?: number }  // optional
}
```

`part.time.start` is often missing because of SDK design, provider differences, proxies, event ordering, or upstream bugs (e.g. [#21544](https://github.com/anomalyco/opencode/issues/21544)). The plugin therefore combines several data sources.

> **Terminology**: In this document, **"sdk"** refers to the OpenCode SDK processor layer — where `part.time.start = Date.now()` is recorded when the first streaming chunk arrives. It is **not** the LLM provider API. **"tui"** refers to the TUI plugin's JavaScript event handler (`Date.now()` in the `delta` event callback). Both are local measurements; neither comes from the LLM provider.

**Sidebar TTFT is always collected** via `src/first-part-time.ts`. **`timeline.enabled` only controls JSONL disk writes** — not the sidebar row.

## Data sources (priority order)

### 1. SDK-side timing (preferred)

| | |
|--|--|
| **Trigger** | `part` event |
| **Fields** | `part.time.start` on `text` or `reasoning` parts |
| **Formula** | `ttftMs = part.time.start - msg.time.created` |
| **Accuracy** | Best — earliest available timestamp (SDK-local, before IPC/event-loop delay to TUI plugin) |

### 2. TUI-side timing (fallback)

| | |
|--|--|
| **Trigger** | First `delta` event with `field` = `text` or `reasoning` |
| **Fields** | `Date.now()` at receive time |
| **Formula** | `ttftMs = Date.now() - msg.time.created` |
| **Accuracy** | Includes all latency (provider processing + internet + SDK internal + local IPC + JS event-loop); depends on the host delivering stream deltas |

### 3. Part-state scan (fallback)

| | |
|--|--|
| **Trigger** | `message` event for an assistant message when no timestamp is stored yet; also each 1s streaming poll on the in-flight message while **Now** is active |
| **Fields** | Earliest `part.time.start` among `text` / `reasoning` parts from `api.state.part()` |
| **Formula** | Same as source 1 |
| **Accuracy** | Same as SDK-side when persisted parts include `time.start` |

**Role of `api.state.part()`**: V1 exposes OpenCode's per-message part store. V2 has no such host API: the adapter keeps a bounded cache (200 messages, fed by `part` events, dropped on restart), so the scan only covers messages still in that cache. In both cases, when part events are missing or arrive late, the `message` event can scan this view for the earliest valid `time.start`. This works when parts carry timing data; some backends (e.g. local models without a parts table) still have no usable `time.start` — see [ttft-troubleshooting.md](./ttft-troubleshooting.md).

### 4. Store replay (fallback after a reload)

| | |
|--|--|
| **Trigger** | V2 `session.step.ended` / `step.failed`: the timed parts of the message are re-emitted from its store row before the `message` event |
| **Fields** | `content[*].time.created` (reasoning/tool; tool `time.completed` becomes the end) |
| **Formula** | Same as source 1 |
| **Accuracy** | Equivalent to source 1 (same SDK stamps), only reported one step later |

Why it is needed: a plugin hot reload (the local-directory dev loop rebuilds `dist/tui.js`, and a plugin update can land mid-turn) tears down the sidebar host and the adapter, so the in-flight message's part events reach a destroyed tracker while `step.ended` lands in a fresh, empty one. The store row still carries the timed parts, so they are replayed.

Both consumers are idempotent (`firstPartTime` keeps an existing SDK value, `toolTiming` dedupes by callID), so this is a no-op for healthy messages and only fills the gaps.

**Limits**: only the first content part may seed TTFT, and text parts in the store carry no `time` — a reply that opens with text cannot recover TTFT (the next timed part starts later, so using it would report an inflated value). An unclosed tool (no `time.completed`, e.g. an interrupted turn) is replayed as still running, so it never gets a fabricated duration. `delta` is live-only, so ITL is unrecoverable. These stay empty.

## Priority rules

SDK timestamps win over TUI timestamps for the same message. Once an SDK value is stored, later TUI events are ignored. TUI values can be upgraded when a valid SDK `time.start` arrives later.

Timestamps with `start <= msg.time.created` are discarded (clock skew / bad SDK data). The store replay in source 4 applies the same filter before emitting, because `recordPart` itself does not reject a stray stamp.

Logic lives in `createFirstPartTimeTracker()` (`src/first-part-time.ts`).

## Data flow

`sidebar-host` receives internal events: V1's `message.part.updated` / V2's `session.text.started` are already mapped by `v1-map.ts` / `v2/adapter.ts`.

```mermaid
sequenceDiagram
    participant OC as OpenCode
    participant Host as sidebar-host
    participant Tracker as first-part-time
    participant UI as Speed section
    participant Timeline as timeline JSONL

    Note over OC: Streaming starts
    OC->>Host: part event
    Host->>Tracker: store sdk time.start

    Note over OC: No time.start on event
    OC->>Host: delta event
    Host->>Tracker: store tui Date.now()

    Note over OC: Streaming poll (1s)
    Host->>Tracker: scan api.state.part on in-flight if still empty

    Note over OC: Turn completes
    OC->>Host: message event
    Host->>Tracker: scan api.state.part if still empty
    Host->>UI: TTFT row + Last/Avg/Now speed denominators
    Host->>Timeline: append record if timeline.enabled
```

## Modules

| Module | Role |
|--------|------|
| `src/first-part-time.ts` | Per-message first-part timestamps |
| `src/sidebar-host.tsx` | Subscribes to part / message events |
| `src/use-cache-hit-metrics.ts` | `lastTtft`, **Last** / **Avg** / sparkline speed (gen time when tracked) |
| `src/streaming-state.ts` | Streaming **Now** speed denominator (via `advanceStreamingNow`) |
| `src/timeline/collector.ts` | Writes `ttftMs` / `ttftSource` when timeline is enabled |

## Sidebar display

Shows the most recent non-summary assistant turn with a valid first-part timestamp — available during streaming once the first token arrives (`944ms`, `1.2s`, or `"—"`). The same tracker drives **Now** / **Last** / **Avg** generation-speed denominators when timestamps exist. Display rules and troubleshooting: [ttft-troubleshooting.md](./ttft-troubleshooting.md).

## Timeline JSONL

When `timeline.enabled: true`, each completed assistant record may include:

```typescript
{
  ttftMs?: number
  ttftSource?: "sdk" | "tui"
}
```

Same tracker as the sidebar; see [timeline.md](./timeline.md).

## Comparison with other plugins

| Plugin | Approach |
|--------|----------|
| opencode-throughput | `part.time.start` only |
| opencode-hud | TUI `performance.now()` only |
| oc-tps | text/reasoning delta + tool.pending fallback |
| opencode-cache-hit | SDK + TUI + part-state scan + tool.pending fallback |

## Tests

| Area | File |
|------|------|
| Tracker | `tests/first-part-time.test.ts` |
| Record fields | `tests/timeline-records.test.ts` |
| Timeline integration | `tests/timeline-collector.test.ts` |

## References

- [TTFT Troubleshooting](./ttft-troubleshooting.md)
- [OpenCode Issue #21544](https://github.com/anomalyco/opencode/issues/21544)
- [OpenCode Issue #26924](https://github.com/anomalyco/opencode/issues/26924)
- [OpenCode Issue #27663](https://github.com/anomalyco/opencode/issues/27663)
- [OpenCode Issue #23673](https://github.com/anomalyco/opencode/issues/23673)
