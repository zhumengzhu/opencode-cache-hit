# TTFT Troubleshooting Guide

The **Speed** section shows **TTFT** (Time To First Token) for the most recent assistant turn with a valid first-part timestamp — the delay from request start (`msg.time.created`) to the first streamed `text` or `reasoning` token. TTFT is available during streaming once the first token arrives, not only after completion.

Example: `TTFT: 944ms` or `TTFT: 1.2s`. When no reliable first-token timestamp is available, the row shows `"—"`.

Sidebar TTFT works with default plugin config. It does **not** require `timeline.enabled`. Timeline JSONL (`ttftMs` field) is separate — see [Timeline](./timeline.md).

Design details: [TTFT Hybrid Implementation](./ttft-hybrid.md).

> **Event names**: this document uses the plugin's internal event contract (`TuiEvent` in `src/types.ts`): `part` / `message` / `delta` / `tick`. OpenCode 1 (`message.part.updated`, `message.part.delta`, …) and OpenCode 2 (`session.text.started`, `session.text.delta`, …) source events are mapped onto it in `v1-map.ts` / `v2/adapter.ts`; see [design.md § Event mapping](./design.md#event-mapping).

---

## When `"—"` is normal

| Situation | Why |
|-----------|-----|
| Turn still streaming | TTFT is available during streaming once the first token arrives (same as sidebar) |
| Speed section hidden | `display.showSpeed: false` in `cache-hit.json` |
| First turn after opening the panel | No assistant turn with a valid first-token timestamp yet |

---

## Checklist if TTFT stays `"—"` after a turn completes

### 1. Compare with **Now** (streaming speed)

| **Now** during streaming | Likely cause |
|--------------------------|--------------|
| Shows tok/s | Parts exist; TTFT should usually appear once the turn completes. If not, see §2–3 |
| Shows `·` | `api.state.part()` may be empty — common with some local backends |

### 2. Provider / OpenCode limitations

Some setups never expose stream parts or `part.time.start`:

- **Local models** (LM Studio, Ollama) may not populate the parts table ([#23673](https://github.com/anomalyco/opencode/issues/23673))
- **Missing `part.time.start`** on `part` events — plugin falls back to TUI deltas and a part-state scan; if both are empty, TTFT stays `"—"`
- **Stream deltas not delivered** on some OpenCode versions (V1 `message.part.delta`, [#27663](https://github.com/anomalyco/opencode/issues/27663))
- **Invalid timestamps** (`part.time.start <= msg.time.created`, e.g. SDK issue [#21544](https://github.com/anomalyco/opencode/issues/21544)) — value is omitted rather than showing 0 or negative TTFT

### 3. Timeline JSONL has no `ttftMs` but sidebar shows a value

Sidebar and JSONL share the same timing data. If the sidebar has TTFT but log lines do not:

```json
{
  "timeline": { "enabled": true }
}
```

Ensure `timeline.enabled` is `true` in `~/.config/opencode/cache-hit.json` (or legacy `cache-hit.config.json` beside the package). Restart OpenCode after editing config.

---

## Configuration

**Sidebar TTFT** — no extra config; enabled when `display.showSpeed` is true (default).

**JSONL `ttftMs`** — requires timeline logging:

```json
{
  "display": { "showSpeed": true },
  "timeline": { "enabled": true }
}
```

---

## Known upstream limitations

| Issue | Effect on TTFT |
|-------|----------------|
| [#23673](https://github.com/anomalyco/opencode/issues/23673) Local models, no parts | Often always `"—"` |
| [#27663](https://github.com/anomalyco/opencode/issues/27663) Lost V1 `message.part.delta` | TUI fallback may not run |
| [#26924](https://github.com/anomalyco/opencode/issues/26924) Part event ordering | Plugin uses multiple sources to compensate |
| [#21544](https://github.com/anomalyco/opencode/issues/21544) `time.start` overwritten | Invalid SDK timestamps are skipped |

Total turn duration (`time.completed - time.created`) is always available from message metadata but is **not** shown as TTFT — TTFT measures time-to-first-token only.

---

## Related documentation

- [TTFT Hybrid Implementation](./ttft-hybrid.md) — how timing is collected
- [Timeline](./timeline.md) — JSONL logging
- [Token Speed](./token-speed.md) — speed section layout
