# Timeline analysis scripts

Optional tools; not part of the OpenCode plugin runtime.

## One-liners

Quick stats (no extra deps):

```bash
# Python
python3 -c "import json,sys; r=[json.loads(x) for x in open(sys.argv[1]) if x.strip()]; h=[x['hitPercent'] for x in r if x.get('hitPercent') is not None]; print(f\"{len(r)} calls, avg hit {sum(h)/len(h):.1f}%\")" logs/timeline-2026-05-31.jsonl

# Bun
bun -e "const t=await Bun.file(process.argv[1]).text();const rows=t.trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));const h=rows.map(r=>r.hitPercent).filter((p):p is number=>p!=null);console.log(rows.length+' calls, avg hit '+(h.reduce((a,b)=>a+b,0)/h.length).toFixed(1)+'%')" logs/timeline-2026-05-31.jsonl
```

Export TSV for spreadsheets (time fields are ISO 8601 strings):

```bash
jq -r 'select(.hitPercent!=null) | [.completedAt,.scope,.hitPercent,.cost]|@tsv' logs/timeline-2026-05-31.jsonl
```

## `timeline-dashboard.ts` (Bun, no install)

Interactive HTML dashboard with charts, filters, and data tables:

```bash
bun scripts/timeline-dashboard.ts                                                  # auto-detect logs/ (no browser)
bun scripts/timeline-dashboard.ts --open                                           # write HTML, then open browser
bun scripts/timeline-dashboard.ts -o /tmp/report.html                              # custom output path
bun scripts/timeline-dashboard.ts ~/logs/timeline-*.jsonl                          # globs expanded by script
bun scripts/timeline-dashboard.ts --output /tmp/report.html --open                 # combined
```

Default output: `/tmp/timeline-dashboard-YYYY-MM-DD-HHmmss.html` (timestamp suffix to avoid overwrites).

**Browser:** not opened by default; pass `--open` (macOS `open`, Linux `xdg-open`, Windows `start`).

**Features:**
- Summary cards follow active filters (records, tokens, cost, avg hit rate)
- Time / session / scope / model / text search filters
- 3 Chart.js charts: token volume (stacked bar), hit rate + cost (dual axis), duration (bar)
- Session summary table (mixed main+child scope shown as `main+child`), with `Avg TTFT` and `Avg TPS` columns
- Per-call detail table: expandable rows (all JSONL fields), sortable columns (click a header; default is newest first), `TTFT` / `TPS` / `TPOT` columns; shows the first N rows in the current order
- `Reset` button restores the full date range and clears every filter
- Embedded data — no server needed, just open the HTML file

**How it works:**

1. Reads `timeline-*.jsonl` and rotation backups `timeline-*.jsonl.N` from the default log dir (`~/.local/share/opencode/logs/cache-hit/`) or user-supplied paths/globs
2. Parses each JSONL line (`schema: 1` validation), sorts by `completedAt` / `created`; repeated `messageKey` lines collapse to the latest record that is not incomplete, and invalid/unparseable lines are counted on stderr
3. Aggregates per-session statistics in the browser when filters change
4. Generates a self-contained HTML file with:
   - All data embedded as JSON in a `<script>` tag (`<` escaped for safety)
   - Chart.js 4.4.7 from CDN (`cdn.jsdelivr.net`)
   - Vanilla JS for interactivity (no framework dependency)
5. Optional `--open` opens the output file in the default browser

**Avg hit rate:** excludes `skippedForHit` rows (same rule as `plot-hit-rate.ts`); null `hitPercent` still appear in tables/charts.

**Cost display:** reads `currency` / `costUnit` / `rate` from `~/.config/opencode/cache-hit.json` when present (same as the TUI sidebar). **No config file** → defaults (`CNY` display, `USD` JSONL unit, rate `6.77`). Invalid or partial cost fields are normalized; corrupt config falls back without failing the script. JSONL always stores raw `cost` in `costUnit` (usually USD).

**Note:** The generated HTML is self-contained except Chart.js CDN. Re-run the script to refresh data (static snapshot).

### Design approaches

**Option A (current — static HTML):**
Data is embedded into the HTML at build time by Bun. The browser just renders.

```
bun scripts/timeline-dashboard.ts  →  /tmp/timeline-dashboard-YYYY-MM-DD-HHmmss.html (self-contained)
```

- Pros: No server needed, zero runtime deps, can email/share the file
- Cons: Snapshot only — re-run to refresh data

**Option B (live server):**
Starts an HTTP server; the browser fetches JSONL via `fetch("/api/logs")`.

```
bun scripts/timeline-dashboard.ts serve  →  http://localhost:PORT
```

- Pros: Live reload — refresh the page to see new logs
- Cons: Must keep a process running, cannot send the page as a file

## `plot-hit-rate.ts` (Bun, no install)

Terminal ASCII chart; optional SVG (`open /tmp/hit.svg`):

```bash
bun scripts/plot-hit-rate.ts logs/timeline-2026-05-31.jsonl
bun scripts/plot-hit-rate.ts logs/timeline-2026-05-31.jsonl --root YOUR_ROOT_SESSION_ID -o /tmp/hit.svg
# one SVG, one colored line per rootSessionId (time-aligned)
bun scripts/plot-hit-rate.ts logs/timeline-2026-05-31.jsonl --by-root -o /tmp/hit.svg
```

Use a real path, not `$LOG`, unless you exported it first:

```bash
set -x LOG logs/timeline-(date +%Y-%m-%d).jsonl   # fish: set log ...
bun scripts/plot-hit-rate.ts $LOG -o /tmp/hit.svg
```

## `fetch-deepseek-pricing.ts` (Bun, no install)

Fetch DeepSeek official peak/off-peak pricing and print a ready-to-paste `dynamicPricing.providers` snippet for cache-hit.json:

```bash
bun scripts/fetch-deepseek-pricing.ts                  # CNY per 1M tokens, includes "currency": "CNY"
bun scripts/fetch-deepseek-pricing.ts --usd --rate 6.77 # USD (divided by rate)
```

Output is JSON to merge under `"dynamicPricing"`; non-USD `levels` are converted to internal USD at config load using `cost.rate`.
