# Token Speed Sidebar — Design

Feature: display **token generation speed** in the sidebar panel as **TPOT** (ms per output token), alongside existing cache hit rate / token / cost metrics.

> **Event names**: this document uses the plugin's internal event contract (`TuiEvent` in `src/types.ts`): `part` / `message` / `delta` / `tick`. OpenCode 1 and OpenCode 2 source events are mapped onto it in `v1-map.ts` / `v2/adapter.ts`; see [design.md § Event mapping](./design.md#event-mapping).

## 1. Reference: MiMo-Code sidebar

MiMo-Code's TUI sidebar displays speed using two modes:
- **Streaming**: char-based heuristic (4 chars ≈ 1 token), polled periodically; displayed as ms/tok via `1000 / speed` conversion
- **Completed**: real token counts from `StepFinishPart.tokens`, displayed as TPOT (ms/token)

---

## 2. Features

### Completed-call speed (TPOT)

Display **TPOT** (Time Per Output Token, ms/token) for finished LLM calls using real token counts. TPOT follows the industry-standard formula:

```
TPOT = generationMs / (output_tokens + reasoning_tokens - 1)
```

The `-1` excludes the first token (captured separately by TTFT). When `firstPartTime` is tracked, `generationMs = completedAt - firstPartTime` (excludes TTFT); otherwise it falls back to full turn duration (`completed - created`).

**Edge cases:**
- `output + reasoning <= 1`: TPOT is undefined (industry standard — single token has no inter-token interval)
- `generationMs < 500ms`: TPOT is undefined (noise floor)

**Numerator includes reasoning tokens** — reasoning is model decode output, so it counts toward generation speed.

### Real-time streaming speed

Live speed estimation during streaming using char/4 heuristic. Internally computed as tok/s, then converted to ms/tok (`1000 / speed`) for display. Requires `api.state.part(id)` to access streaming text content.

**Now** row states:

| State | Display | Color |
|-------|---------|-------|
| Idle (no stream) | `·` | muted |
| Warmup (TTFT wait, &lt;500ms since start, or no text yet) | `—` | success |
| Active | `~N ms/tok` | success |
| Hold (2s after stream ends) | last `~N ms/tok` | muted |

`~` marks **Now** as a streaming estimate (char/4 heuristic). **Last** and **Avg** use real token counts and are displayed without `~`.

### Speed sparkline

Mini inline chart showing TPOT trend across last N calls. Rendered as block-char sparkline (e.g., `▁▃▅▇▆▄▂`).

### Per-sub-agent speed

Extend "Agents" section with per-child TPOT rows. Uses full turn duration only (child sessions do not run the main-session TTFT tracker).

### Related modules

| File | Role |
|------|------|
| `src/token-speed.ts` | Pure speed/TPOT calculations (`computeTokenTpotMs`, `computeAvgTokenTpotMs`, `formatTokenTpot`, etc.) |
| `src/streaming-state.ts` | Streaming phase state machine (`advanceStreamingNow`) |
| `src/sparkline.ts` | Sparkline rendering + `collectTpotValues` |
| `src/first-part-time.ts` | TTFT tracker (sidebar + timeline) |
| `src/itl-tracker.ts` | ITL chunk-interval tracker (sidebar events → JSONL) |
| `src/use-cache-hit-metrics.ts` | Last / Avg TPOT memos |
| `src/main-session-view.tsx` | Speed section UI |
| `src/sidebar-host.tsx` | Event-driven streaming wake-up, adaptive polling, sub-agent TPOT |
| `src/agents-view.tsx` | Per sub-agent TPOT row |
| `src/stats.ts` | `toSubAgentSummary()` tpot field |
| `src/types.ts` | `StreamPart`, `SubAgentSummary.speed` |
| `src/i18n.ts` | Speed strings incl. `streamingIdle` |
| `src/plugin-config.ts` | `display.showSpeed` |

---

## 3. Configuration

```json
{
  "display": {
    "showSpeed": true,
    "speedUnit": "tps"
  }
}
```

| Field | Default | Meaning |
|-------|---------|---------|
| `showSpeed` | `true` | Show/hide speed section |
| `speedUnit` | `"tps"` | `"tps"` (tok/s) or `"tpot"` (ms/tok) |

---

## 4. UI layout

Placement: between **Detail** and **Model** sections.

```
┌─ Cache Hit ─────────────────────────────┐
│ ▼ Hit [████████░░] 82.5% ↑5.2          │
│ Total Hit: 82.2%                         │
│ TTL: 3m 12s                              │
│                                          │
│ ▼ Detail                                 │
│   Read:  125.0K tok                      │
│   Write: 8.2K tok                        │
│   ...                                    │
│                                          │
│ ▼ Speed                                  │
│   Now: ~19 ms/tok                         │  ← streaming (idle: ·)
│   Last: 21 ms/tok                        │
│   Avg:  24 ms/tok                        │
│   Trend: ▁▃▅▇▆▄▂                        │
│   TTFT: 944ms                            │  ← last call with valid first-token timestamp (or "—")
│                                          │
│ ▼ Model                                  │
│   Cost: $0.20                            │
│   Model: claude-sonnet-4-20250514        │
│   ...                                    │
│                                          │
│ ▼ Agents (2) · sub-sessions              │
│   deepseek-v4-f… …cgy1  $0.092          │
│                      10 ms/tok           │
│   deepseek-v4-f… …auBU  $0.044          │
│                      11 ms/tok           │
└──────────────────────────────────────────┘
```

---

## 5. Risks & dependencies

| Risk | Impact | Mitigation |
|------|--------|------------|
| `api.state.part()` unavailable | **Now** cannot estimate (warmup / `·`) | **Last** / **Avg** still use real tokens; see [TTFT troubleshooting](./ttft-troubleshooting.md) |
| Missing plugin SDK fields | Some metrics empty | Optional chaining; missing rows show `"—"` (not **Now** idle) |
| Very short completed turns | **Last** / **Avg** show `—` | `computeTokenTpotMs` returns undefined when `generationMs < 500` |
| Single-token output | TPOT undefined | Returns `undefined` → displays `—` |

> **Polling strategy:** Adaptive `setTimeout` (1s active / 3s idle), complemented by `part` / `delta` event-driven wake-up. Very lightweight — idle ticks only update the phase indicator (`·`).

**`—` usage (aligned with §2):** **Now** idle is `·`; `—` is for metrics without reliable data (e.g. TTFT, single-token TPOT), not streaming idle.

---

## 6. Streaming **Now** algorithm

### Current: cumulative average since first token (shipped)

`estimateStreamingSpeed()` in `src/token-speed.ts`:

```
start = firstPartTime (> created) ?? msg.time.created
speed ≈ (text.length / 4) / ((now - start) / 1000)   // tok/s
display = 1000 / speed                                 // → ms/tok
```

**Denominator choice:** When `firstPartTime` is tracked (same hybrid TTFT tracker as timeline / **TTFT** row), the denominator starts at first token — **Now** reflects generation speed, excluding TTFT wait. Falls back to `msg.time.created` until the first stream part is recorded.

**Semantics:** This is a **turn-average since first output**, not an instantaneous rate. Displayed as ms/tok for consistency with TPOT.

**Why this default**

- Simple — no per-message sample buffer
- Stable numbers in a TUI sidebar (little flicker)
- Complements **Last** / **Avg** (real token counts after completion)
- Same char/4 pattern as MiMo-Code reference; TTFT excluded like opencode-hud / throughput plugins

**Trade-offs**

- Until first token is tracked, denominator still uses `created` (warmup / TTFT phase)
- Pauses mid-stream (tool calls, thinking gaps) pull the average down slowly rather than dropping sharply
- char/4 error on mixed CN/EN, code, reasoning (shared with any text-based estimate)

### Alternative: sliding window (not implemented)

Measure speed over a recent window Δt (e.g. 1–3s):

```
speed ≈ (Δchars / 4) / Δt
```

Samples from periodic polls or `delta` events (ring buffer of `(timestamp, charCount)` per in-flight message).

| | Cumulative (current) | Sliding window |
|--|---------------------|----------------|
| Meaning | Average since first token (TTFT excluded when tracked) | Near-instantaneous rate |
| Stability | High | Lower; may need EMA smoothing |
| Stalls | Slow decay | Fast drop when output stops |
| Bursts | Diluted by history | Visible in short windows |
| State | Minimal | Per-message last sample or buffer |
| Tool / think gaps | Average keeps falling | Window may show ~0 unless handled |

**When to reconsider sliding window:** if users need stall/burst visibility or **Now** should track **Last** more closely during streaming. Not required for the current observability sidebar scope.
