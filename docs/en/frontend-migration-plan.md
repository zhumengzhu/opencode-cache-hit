# Frontend Migration: session.get() Aggregates

> **Historical status:** The `session.get()` migration described here is no longer the primary source for main-session interactive metrics. The cache-lineage implementation now requests direct main-session messages with `limit: 10000`, filters summary and compaction calls, and uses `session.get()` as a fallback for snapshot and child-session data. See [design.md](./design.md).

## Overview

Cache-hit previously derived all cost/token statistics by iterating `api.state.session.messages()` and summing per-message fields. This path is capped at **100 messages** by the OpenCode TUI sync layer ([issue #31513]), silently truncating sessions with >100 messages.

**Impact**: For a session exceeding 100 messages, the cap causes significant data loss. In a real long-running session, the plugin showed only ~43% of actual cache-read tokens and ~39% of actual cost.

| Metric | Old (messages, 100-cap) | New (session.get, no cap) |
|--------|------------------------|--------------------------|
| Cache read | 59.6M tok | **139.0M tok** |
| Cache write | 89.8K tok | **1.4M tok** |
| Miss (input) | 118 tok | **329 tok** |
| Output | 32.7K tok | **91.9K tok** |
| Sub-agents visible | 3 | **10** |

The fix swaps the data source from per-message iteration to `api.state.session.get()`, which returns **database-level aggregates** computed from all messages by the session projector — not affected by the 100-message cap.

## Root Cause

OpenCode's TUI sync (`packages/opencode/src/cli/cmd/tui/context/sync.tsx`) hardcodes `limit: 100` when fetching session messages:

```typescript
// Line 559 — fetches at most 100 messages
sdk.client.session.messages({ sessionID, limit: 100 }),

// Lines 580-581 — TUI store also keeps only last 100
const visible = infos.slice(-100)
```

`api.state.session.messages(sid)` reads from `sync.data.message[sid]`, which holds at most 100 entries. For sessions exceeding this, plugins see incomplete data with no indication of truncation.

Meanwhile, the `session` table in OpenCode's SQLite database stores **pre-aggregated** columns (`cost`, `tokens_input`, `tokens_output`, `tokens_cache_read`, `tokens_cache_write`) updated via SQL increments by the session projector — every message, no cap.

`api.state.session.get(sid)` returns the full `Session` object (SDK type `Session`), which includes `cost` and `tokens` fields populated from these database aggregates.

## Solution

### Design

```
Before:
  api.state.session.messages(sid) → iterate 100 msgs → sum           ❌ capped

After:
  api.state.session.get(sid)      → read cost/tokens directly → done  ✅ full
  └─ session not available?       → fallback to messages             (compat)
```

### Changes

| File | Change |
|------|--------|
| `src/types.ts` | New `SessionObject` type (`model`, `cost`, `tokens`, `parentID`); updated `session.get` return type |
| `src/stats.ts` | New `aggregateFromSessionObject()` — O(1) extraction from `SessionObject` → `SessionSnapshot` |
| `src/sidebar-host.tsx` | `mainSnap` and `subAgentList` preferred `session.get()` with fallback to message iteration |
| `tests/stats.test.ts` | 3 test cases covering empty, full, and partial session objects |

### Data Flow

1. **`mainSnap`**: Calls `api.state.session.get(sid)` → `aggregateFromSessionObject()` → returns snapshot if stats present. If session unavailable or empty, falls back to `aggregateSessionFromMessages()`.

2. **`subAgentList`**: Same pattern per child session ID.

3. **Per-call trend** (`computePerCallHitTrend`): Still uses `api.state.session.messages()` — trend only needs the last few turns, so 100 messages is sufficient.

### Why session.get() works for resumed sessions

When resuming a session, OpenCode's TUI `sync()` immediately calls `sdk.client.session.get({ sessionID })` which returns the full `Session` object with database-level aggregates. This object is stored in the TUI state store, and `api.state.session.get(sid)` reads it. The plugin sees accurate totals from the moment the session loads.

### Fallback rationale

`session.get()` returns `undefined` for sessions that have never been synced to the TUI state (rare, but possible for child sessions loaded in a different context). The fallback to `api.state.session.messages()` preserves existing behavior as a safety net.

## Performance

| Metric | Old (message iteration) | New (session.get) |
|--------|------------------------|-------------------|
| Time complexity | O(n) where n ≤ 100 | O(1) |
| Memory | Reads entire message array | Reads one small object |
| Reactivity trigger | `message.updated` → recompute | Same event, same timing |
| Data completeness | ≤ 100 messages | All messages (DB aggregate) |

## Rollout

1. **No config changes required** — the plugin automatically uses `session.get()` when available.
2. **No migration step** for existing users — old config files and timeline logs are unaffected.
3. **Restart OpenCode** to pick up the updated plugin code.
4. **Verify**: Open a session with >100 messages; the sidebar should show totals matching database aggregates.

## Related

- [anomalyco/opencode#31513] — v1 TUI sync hardcodes limit:100
- [anomalyco/opencode#26861] — PR adding cursor-based pagination (pending)
- [anomalyco/opencode#6548] — Paginated message loading feature request

[issue #31513]: https://github.com/anomalyco/opencode/issues/31513
[anomalyco/opencode#31513]: https://github.com/anomalyco/opencode/issues/31513
[anomalyco/opencode#26861]: https://github.com/anomalyco/opencode/pull/26861
[anomalyco/opencode#6548]: https://github.com/anomalyco/opencode/issues/6548
