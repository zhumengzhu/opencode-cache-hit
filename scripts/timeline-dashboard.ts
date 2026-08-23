#!/usr/bin/env bun
/**
 * Timeline JSONL -> interactive HTML dashboard (Bun, no npm deps).
 *
 *   bun scripts/timeline-dashboard.ts                                     # auto-detect logs/
 *   bun scripts/timeline-dashboard.ts ~/logs/timeline-*.jsonl             # globs expanded by script
 *   bun scripts/timeline-dashboard.ts --open                              # open browser after write
 *   bun scripts/timeline-dashboard.ts -o /tmp/report.html                 # custom output
 *
 * Default output: /tmp/timeline-dashboard-YYYY-MM-DD-HHmmss.html
 * Browser is NOT opened unless you pass --open.
 */

import { execSync } from "child_process"
import { existsSync, readFileSync, readdirSync } from "fs"
import { homedir } from "os"
import { basename, dirname, resolve } from "path"
import { Glob } from "bun"
import {
  createCostFormatter,
  normalizeCostDisplay,
  normalizeCostDisplayEmbed,
  type CostDisplayEmbed,
} from "../src/format-cost.ts"
import { loadPluginConfig } from "../src/load-config.ts"
import { recomputeRecordCost } from "../src/dynamic-pricing/recompute.ts"
import type { LlmCallRecord } from "../src/timeline/types.ts"
import type { ProviderInfo } from "../src/types.ts"
import { parseJsonc } from "../src/jsonc.ts"

/**
 * Load static prices (incl. context_over_200k) from the `provider` section of
 * opencode.json for offline recompute. Missing file → empty array; parse failure
 * warns and returns an empty array.
 */
function loadOpencodeProviders(): ProviderInfo[] {
  const path = process.env.OPENCODE_CONFIG ?? `${homedir()}/.config/opencode/opencode.json`
  if (!existsSync(path)) return []
  try {
    const raw = parseJsonc<{
      provider?: Record<string, unknown>
    }>(readFileSync(path, "utf8"))
    const out: ProviderInfo[] = []
    for (const [pid, pv] of Object.entries(raw.provider ?? {})) {
      const po = pv as { models?: Record<string, unknown> } | undefined
      if (!po?.models) continue
      const models: ProviderInfo["models"] = {}
      for (const [mid, mv] of Object.entries(po.models)) {
        const mo = mv as { cost?: Record<string, unknown> } | undefined
        const c = mo?.cost
        if (!c || typeof c !== "object") continue
        const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0)
        const over = c.context_over_200k as Record<string, unknown> | undefined
        models[mid] = {
          cost: {
            input: num(c.input),
            output: num(c.output),
            cache: { read: num(c.cache_read), write: num(c.cache_write) },
            context_over_200k: over
              ? {
                  input: num(over.input),
                  output: num(over.output),
                  cache: { read: num(over.cache_read), write: num(over.cache_write) },
                }
              : undefined,
          },
        }
      }
      if (Object.keys(models).length > 0) out.push({ id: pid, models })
    }
    return out
  } catch {
    console.error(`warning: failed to read or parse ${path}; offline dynamic pricing is disabled`)
    return []
  }
}

function timestampSuffix(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

function parseArgs(argv: string[]) {
  const positional: string[] = []
  let output = `/tmp/timeline-dashboard-${timestampSuffix()}.html`
  let open = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "-o" || a === "--output") {
      const next = argv[++i]
      if (!next) {
        console.error("error: -o/--output requires a path")
        process.exit(1)
      }
      output = next
    } else if (a === "--open") {
      open = true
    } else if (a === "-h" || a === "--help") {
      console.error(
        "usage: bun scripts/timeline-dashboard.ts [files...] [-o path] [--open]\n" +
          "  --open   open the HTML file in the default browser (macOS/Linux/Windows)",
      )
      process.exit(0)
    } else if (a.startsWith("-")) {
      console.error(`error: unknown option ${a}`)
      process.exit(1)
    } else {
      positional.push(a)
    }
  }
  return { patterns: positional, output, open }
}

function expandUserPath(p: string): string {
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2))
  return p
}

function isTimelineLogFile(name: string): boolean {
  return name.startsWith("timeline-") && /\.jsonl(\.\d+)?$/.test(name)
}

async function expandPattern(pattern: string): Promise<string[]> {
  const p = expandUserPath(pattern)
  if (!/[?*[]]/.test(p)) {
    const abs = resolve(p)
    return existsSync(abs) ? [abs] : []
  }
  const dir = resolve(dirname(p))
  const base = basename(p)
  if (!existsSync(dir)) return []
  const glob = new Glob(base)
  const out: string[] = []
  for await (const file of glob.scan({ cwd: dir, onlyFiles: true, absolute: true })) {
    if (isTimelineLogFile(basename(file))) out.push(file)
  }
  return out.sort()
}

async function resolveInputPaths(patterns: string[]): Promise<string[]> {
  if (patterns.length > 0) {
    const paths: string[] = []
    for (const pat of patterns) {
      paths.push(...(await expandPattern(pat)))
    }
    return [...new Set(paths)].sort()
  }
  const logDir = resolve(homedir(), ".local/share/opencode/logs/cache-hit")
  if (!existsSync(logDir)) return []
  return readdirSync(logDir)
    .filter(isTimelineLogFile)
    .sort()
    .map((f) => resolve(logDir, f))
}

function isValidRecord(v: unknown): v is LlmCallRecord {
  if (!v || typeof v !== "object") return false
  const r = v as Record<string, unknown>
  if (r.schema !== 1) return false
  if (typeof r.created !== "string") return false
  if (new Date(r.created).getFullYear() < 2024) return false
  if (typeof r.sessionId !== "string" || typeof r.rootSessionId !== "string") return false
  if (r.scope !== "main" && r.scope !== "child") return false
  for (const k of ["input", "output", "reasoning", "cacheRead", "cacheWrite", "cost"] as const) {
    if (typeof r[k] !== "number" || !Number.isFinite(r[k])) return false
  }
  if (r.hitPercent != null && (typeof r.hitPercent !== "number" || !Number.isFinite(r.hitPercent))) {
    return false
  }
  return true
}

function sortKey(r: LlmCallRecord): number {
  const ts = r.completedAt ?? r.created
  return new Date(ts).getTime() || 0
}

async function loadRecords(paths: string[]): Promise<LlmCallRecord[]> {
  const records: LlmCallRecord[] = []
  const seenKeys = new Set<string>()
  for (const p of paths) {
    if (!existsSync(p)) continue
    const text = await Bun.file(p).text()
    for (const line of text.split("\n")) {
      const s = line.trim()
      if (!s) continue
      try {
        const parsed: unknown = JSON.parse(s)
        if (!isValidRecord(parsed)) continue
        // Deduplicate by messageKey — handles historical duplicates from pre-fix logs
        if (seenKeys.has(parsed.messageKey)) continue
        seenKeys.add(parsed.messageKey)
        records.push(parsed)
      } catch {
        /* skip malformed */
      }
    }
  }
  records.sort((a, b) => sortKey(a) - sortKey(b))
  return records
}

function summarizeStats(data: LlmCallRecord[]) {
  const sessionIds = new Set(data.map((r) => r.rootSessionId || "(unknown)"))
  return {
    totalCalls: data.length,
    totalSessions: sessionIds.size,
    totalCost: data.reduce((s, r) => s + r.cost, 0),
  }
}

/** Safe JSON inside <script> (prevents </script> breakout). */
function embedJson(json: string): string {
  return json.replace(/</g, "\\u003c")
}

function genHTML(data: LlmCallRecord[], cost: CostDisplayEmbed): string {
  const jsonData = embedJson(JSON.stringify(data))
  const jsonCost = embedJson(JSON.stringify(cost))

  const parts = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Timeline Dashboard</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7"></script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0d1117;color:#e6edf3;padding:20px;max-width:1400px;margin:auto}
h1{font-size:24px;margin-bottom:8px;color:#f0f6fc}
h2{font-size:16px;margin:24px 0 8px;color:#e6edf3;border-bottom:1px solid #30363d;padding-bottom:4px}
.sub{color:#8b949e;font-size:13px;margin-bottom:16px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:12px;margin-bottom:20px}
.card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:14px 16px}
.card .val{font-size:22px;font-weight:600;color:#f0f6fc;margin-top:4px}
.card .lbl{font-size:12px;color:#8b949e;text-transform:uppercase;letter-spacing:.05em}
.card .subval{font-size:13px;color:#8b949e;margin-top:2px}
.filters{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:16px;background:#161b22;border:1px solid #30363d;border-radius:8px;padding:12px 16px}
.filters label{font-size:13px;color:#8b949e;margin-right:4px}
.filters input,.filters select{background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:6px;padding:6px 10px;font-size:13px}
.filters select{min-width:120px}
.chart-wrap{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px;margin-bottom:16px}
.chart-wrap canvas{width:100%!important;max-height:320px}
.table-wrap{overflow-x:auto;background:#161b22;border:1px solid #30363d;border-radius:8px;margin-bottom:16px}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;padding:10px 12px;background:#0d1117;color:#8b949e;font-weight:500;border-bottom:1px solid #30363d;white-space:nowrap;cursor:pointer;user-select:none}
th:hover{color:#e6edf3}
td{padding:8px 12px;border-bottom:1px solid #21262d;white-space:nowrap;font-variant-numeric:tabular-nums}
tr:hover td{background:#1c2128}
.num{text-align:right;font-family:"SF Mono","Cascadia Code","Fira Code",monospace}
.ok{color:#3fb950}
.warn{color:#d29922}
.err{color:#f85149}
.muted{color:#8b949e}
.pill{display:inline-block;padding:1px 8px;border-radius:10px;font-size:11px;font-weight:500}
.pill-main{background:#1f6feb33;color:#58a6ff}
.pill-child{background:#3fb95033;color:#3fb950}
.pill-model{background:#8b949e22;color:#8b949e;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pill-mixed{background:#d2992233;color:#d29922}
.dr{display:none}
.dr td{padding:0}
.dr.open{display:table-row}
.detail-inner{padding:12px 16px;background:#0d1117}
.dr .detail-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px 16px}
.dg-item{display:flex;flex-direction:column;min-width:0}
.dg-label{font-size:11px;color:#8b949e;margin-bottom:2px}
.dg-value{font-size:13px;color:#e6edf3;font-family:"SF Mono",monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dg-value pre{white-space:pre-wrap;word-break:break-all;margin:0}
.tip-box{position:fixed;max-width:360px;padding:8px 12px;background:#1c2128;border:1px solid #30363d;border-radius:6px;font-size:12px;line-height:1.5;color:#e6edf3;pointer-events:none;z-index:999;display:none;box-shadow:0 4px 12px rgba(0,0,0,.4)}
</style>
</head>
<body>

<h1>Timeline Dashboard</h1>
<p class="sub" id="subtitle">Loading...</p>
<p class="sub" id="costNote" style="display:none;margin-top:-8px"></p>

<div class="grid" id="summaryGrid"></div>

<div class="filters">
  <label>Time</label>
  <input type="date" id="filterDateFrom">
  <span class="muted">--</span>
  <input type="date" id="filterDateTo">

  <label style="margin-left:8px">Session</label>
  <select id="filterSession"><option value="all">All</option></select>

  <label style="margin-left:8px">Scope</label>
  <select id="filterScope"><option value="all">All</option><option value="main">main</option><option value="child">child</option></select>

  <label style="margin-left:8px">Model</label>
  <select id="filterModel"><option value="all">All</option></select>

  <label style="margin-left:8px">Search</label>
  <input type="text" id="filterSearch" placeholder="session / model / messageKey..." style="width:220px">
</div>

<div class="chart-wrap">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
    <span style="font-size:14px;font-weight:500">Token Volume <span class="tip-trigger" data-tip="Input=cache miss tokens | Cache Read=cache hit tokens | Output=generated tokens | Cache Write=tokens written to cache" style="font-size:11px;color:#8b949e;cursor:help"><span style="display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border:1px solid #8b949e;border-radius:50%;font-size:10px;font-weight:700;line-height:1;color:#8b949e;font-style:normal;margin-right:1px">!</span></span></span>
    <label style="font-size:12px;color:#8b949e">
      <input type="checkbox" id="toggleStack" checked> Stacked
    </label>
  </div>
  <canvas id="chartTokens"></canvas>
</div>

<div class="chart-wrap">
  <span style="font-size:14px;font-weight:500;display:block;margin-bottom:8px">Cache Hit Rate &amp; Cost <span class="tip-trigger" data-tip="Per-call prompt cache hit rate (green) and message cost (red) | Hit % = cacheRead / (cacheRead + input) | Avg hit excludes skippedForHit rows (same as plot-hit-rate.ts)" style="font-size:11px;color:#8b949e;cursor:help"><span style="display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border:1px solid #8b949e;border-radius:50%;font-size:10px;font-weight:700;line-height:1;color:#8b949e;font-style:normal;margin-right:1px">!</span></span></span>
  <canvas id="chartHitCost"></canvas>
</div>

<div class="chart-wrap">
  <span style="font-size:14px;font-weight:500;display:block;margin-bottom:8px">Duration <span class="tip-trigger" data-tip="Assistant response generation time in milliseconds" style="font-size:11px;color:#8b949e;cursor:help"><span style="display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border:1px solid #8b949e;border-radius:50%;font-size:10px;font-weight:700;line-height:1;color:#8b949e;font-style:normal;margin-right:1px">!</span></span></span>
  <canvas id="chartDuration"></canvas>
</div>

<h2>Session Summary <span class="tip-trigger" data-tip="Aggregated stats grouped by rootSessionId (one row per unique session)" style="font-size:11px;color:#8b949e;cursor:help"><span style="display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border:1px solid #8b949e;border-radius:50%;font-size:10px;font-weight:700;line-height:1;color:#8b949e;font-style:normal;margin-right:1px">!</span></span></h2>
<div class="table-wrap">
  <table id="sessionTable">
    <thead><tr>
      <th>Session ID</th><th>Model</th><th>Scope</th><th class="num">Calls</th>
      <th class="num">Total Tokens</th><th class="num">Input</th><th class="num">Output</th>
      <th class="num">Cache Read</th><th class="num">Avg Hit</th><th class="num" id="thSessionCost">Cost</th>
      <th class="num">Avg TTFT</th><th class="num">Avg TPS</th><th class="num">Avg TPOT</th><th>Start</th>
    </tr></thead>
    <tbody id="sessionBody"></tbody>
  </table>
</div>

<h2>Per-Call Detail <span class="tip-trigger" data-tip="Each row is one assistant message. Click to expand all JSONL fields" style="font-size:11px;color:#8b949e;cursor:help"><span style="display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border:1px solid #8b949e;border-radius:50%;font-size:10px;font-weight:700;line-height:1;color:#8b949e;font-style:normal;margin-right:1px">!</span></span></h2> <span style="font-size:12px;color:#8b949e">(click row to expand; table shows latest N rows)</span>
<div class="filters" style="margin-bottom:4px">
  <label style="color:#8b949e">Rows</label>
  <select id="pageSize" style="width:70px">
    <option value="20">20</option><option value="50" selected>50</option>
    <option value="100">100</option><option value="500">500</option><option value="99999">All</option>
  </select>
</div>
<div class="table-wrap">
  <table id="detailTable">
    <thead><tr>
      <th style="width:0"></th><th class="num">Time</th><th>Scope</th><th>Session</th><th>Model</th>
      <th class="num">Input</th><th class="num">Output</th><th class="num">CacheR</th><th class="num">CacheW</th>
      <th class="num">Hit%</th><th class="num">Cost</th><th class="num">Dur</th>
      <th class="num">TTFT</th><th class="num">TPS</th><th class="num">TPOT</th>
    </tr></thead>
    <tbody id="detailBody"></tbody>
  </table>
</div>

<script>
var RAW_DATA = TMPL_DATA
var EXPAND_FIELDS = ["schema","recordedAt","sessionId","rootSessionId","scope","messageKey","modelId","created","completedAt","durationMs","isComplete","input","output","reasoning","cacheRead","cacheWrite","cost","hitPercent","skippedForHit","ttftMs","ttftSource","tps","tpot","itlP50","itlP90","itlCount","finish","toolDurations"]

function fmtTtft(ms) { if (ms == null) return "-"; return ms < 1000 ? ms + "ms" : (ms / 1000).toFixed(1) + "s" }
function fmtTps(v) { if (v == null) return "-"; return Math.round(v) + " tok/s" }
function fmtTpot(v) { if (v == null) return "-"; return v >= 1000 ? (v/1000).toFixed(1)+"s/tok" : Math.round(v)+" ms/tok" }
function fmtDur(ms) { if (ms == null) return "-"; return ms < 1000 ? ms + "ms" : (ms/1000).toFixed(1) + "s" }
function esc(s) { return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;") }

function ensureCostDisplay(raw) {
  var d = { currency:"CNY", costUnit:"USD", rate:6.77, symbol:"¥", decimals:3, minDisplay:0.01, chartLabel:"Cost (¥)", costNote:"JSONL cost is USD; displayed as CNY @ 6.77" }
  if (!raw || typeof raw !== "object") return d
  var rate = Number(raw.rate)
  if (!isFinite(rate) || rate <= 0) rate = d.rate
  return {
    currency: raw.currency || d.currency,
    costUnit: raw.costUnit || d.costUnit,
    rate: rate,
    symbol: raw.symbol || d.symbol,
    decimals: typeof raw.decimals === "number" && raw.decimals >= 0 ? raw.decimals : d.decimals,
    minDisplay: typeof raw.minDisplay === "number" && raw.minDisplay > 0 ? raw.minDisplay : d.minDisplay,
    chartLabel: raw.chartLabel || d.chartLabel,
    costNote: typeof raw.costNote === "string" ? raw.costNote : d.costNote
  }
}
var COST_DISPLAY = ensureCostDisplay(TMPL_COST)

function convertCost(amount) {
  if (!isFinite(amount) || amount <= 0) return 0
  return amount * COST_DISPLAY.rate
}

function fmtCost(amount) {
  if (!isFinite(amount) || amount <= 0) return "-"
  var v = convertCost(amount)
  if (!isFinite(v)) return "-"
  if (v < COST_DISPLAY.minDisplay) return "<" + COST_DISPLAY.symbol + COST_DISPLAY.minDisplay
  return "~" + COST_DISPLAY.symbol + v.toFixed(COST_DISPLAY.decimals)
}

/* Dynamic pricing: prefer recomputed dynCost when present. */
function costOf(r) {
  if (r && r.dynCost !== undefined && r.dynCost !== null) return r.dynCost
  return r ? r.cost : 0
}
function fmtCostOf(r) {
  if (!r) return "-"
  if (r.dynCost !== undefined && r.dynCost !== null && Math.abs(r.dynCost - r.cost) > 1e-12) {
    return "\u2248" + fmtCost(r.dynCost)
  }
  return fmtCost(r.cost)
}

function applyCostLabels() {
  var th = document.getElementById("thSessionCost")
  if (th) th.textContent = COST_DISPLAY.chartLabel
  var note = document.getElementById("costNote")
  if (!note) return
  if (COST_DISPLAY.costNote) {
    note.textContent = COST_DISPLAY.costNote
    note.style.display = "block"
  } else {
    note.textContent = ""
    note.style.display = "none"
  }
}

function hitValues(rows) {
  return rows.filter(function(r){ return !r.skippedForHit && r.hitPercent != null }).map(function(r){ return r.hitPercent })
}

function sessionScopeLabel(rows) {
  var scopes = [...new Set(rows.map(function(r){ return r.scope }).filter(Boolean))]
  if (scopes.length === 0) return "(unknown)"
  if (scopes.length === 1) return scopes[0]
  return scopes.join("+")
}

function scopePillClass(scope) {
  if (scope === "main") return "pill-main"
  if (scope === "child") return "pill-child"
  return "pill-mixed"
}

function renderSummary(data) {
  var ti = 0, to = 0, tcr = 0, tcw = 0, tc = 0, tt = 0, dyn = 0
  data.forEach(function(r){ ti+=r.input; to+=r.output; tcr+=r.cacheRead; tcw+=r.cacheWrite; tc+=costOf(r); if (r.dynCost != null) dyn++ })
  tt = ti+to+tcr+tcw
  var hits = hitValues(data)
  var avg = hits.length ? hits.reduce(function(s,h){return s+h},0)/hits.length : 0
  var sessions = [...new Set(data.map(function(r){return r.rootSessionId}).filter(Boolean))].length
  var models = [...new Set(data.map(function(r){return r.modelId}).filter(Boolean))].join(", ")
  var cls = avg>90 ? "ok" : avg>70 ? "warn" : "err"
  var cards = [
    {l:"Records", v:data.length, s:sessions+" sessions"},
    {l:"Total Tokens", v:(tt/1e6).toFixed(2)+"M", s:"In "+(ti/1e6).toFixed(2)+"M"},
    {l:"Total Input", v:ti.toLocaleString(), s:"Out "+to.toLocaleString()},
    {l:"Cache Read", v:tcr.toLocaleString(), s:"Write "+tcw.toLocaleString()},
    {l:"Avg Hit Rate", v:avg.toFixed(1)+"%", s:hits.length+" plottable calls", c:cls},
    {l:"Total Cost", v:(dyn>0?"\u2248":"")+fmtCost(tc), s:COST_DISPLAY.costUnit !== COST_DISPLAY.currency ? "raw "+COST_DISPLAY.costUnit+" in JSONL" : ""},
    {l:"Models", v:models||"(none)", s:""},
    {l:"Date Range", v:data.length?data[0].created.slice(0,10):"-", s:data.length?"~ "+data[data.length-1].created.slice(0,10):""}
  ]
  document.getElementById("summaryGrid").innerHTML = cards.map(function(c){
    return '<div class="card"><div class="lbl">'+c.l+'</div><div class="val'+(c.c?" "+c.c:"")+'">'+c.v+'</div>'+(c.s?'<div class="subval">'+c.s+'</div>':"")+'</div>'
  }).join("")
}

function updateSubtitle(data) {
  var sessions = [...new Set(data.map(function(r){return r.rootSessionId}).filter(Boolean))]
  var models = [...new Set(data.map(function(r){return r.modelId}).filter(Boolean))]
  document.getElementById("subtitle").textContent = data.length + " records (filtered), " + sessions.length + " sessions" + (models.length?", "+models.join(", "):"")
}

function populateFilters() {
  var sessions = [...new Set(RAW_DATA.filter(function(r){return r.rootSessionId}).map(function(r){return r.rootSessionId}))].sort()
  var models = [...new Set(RAW_DATA.filter(function(r){return r.modelId}).map(function(r){return r.modelId}))].sort()
  var selS = document.getElementById("filterSession")
  sessions.forEach(function(s){ var o=document.createElement("option"); o.value=s; o.textContent=s.slice(-16); selS.appendChild(o) })
  var selM = document.getElementById("filterModel")
  models.forEach(function(m){ var o=document.createElement("option"); o.value=m; o.textContent=m; selM.appendChild(o) })
  if (RAW_DATA.length > 0) {
    var dates = RAW_DATA.map(function(r){return r.created.slice(0,10)}).filter(function(d,i,a){return a.indexOf(d)===i}).sort()
    document.getElementById("filterDateFrom").value = dates[0]
    document.getElementById("filterDateTo").value = dates[dates.length-1]
  }
  updateSubtitle(RAW_DATA)
}

function getFilteredData() {
  var df = document.getElementById("filterDateFrom").value
  var dt = document.getElementById("filterDateTo").value
  var sess = document.getElementById("filterSession").value
  var sc = document.getElementById("filterScope").value
  var mdl = document.getElementById("filterModel").value
  var q = document.getElementById("filterSearch").value.toLowerCase()
  return RAW_DATA.filter(function(r){
    var d = r.created.slice(0,10)
    if (df && d<df) return false
    if (dt && d>dt) return false
    if (sess!=="all" && r.rootSessionId!==sess) return false
    if (sc!=="all" && r.scope!==sc) return false
    if (mdl!=="all" && r.modelId!==mdl) return false
    if (q) {
      var mk = (r.messageKey || "").toLowerCase()
      var rs = (r.rootSessionId || "").toLowerCase()
      var sid = (r.sessionId || "").toLowerCase()
      var mid = (r.modelId || "").toLowerCase()
      if (mk.indexOf(q)===-1 && rs.indexOf(q)===-1 && sid.indexOf(q)===-1 && mid.indexOf(q)===-1) return false
    }
    return true
  })
}

var chartTokens = null, chartHitCost = null, chartDuration = null

function chartAvailable() { return typeof Chart !== "undefined" }

function chartCtx(id) { try { return document.getElementById(id).getContext("2d") } catch(e){ return null } }

function buildTokenChart(data) {
  if (!chartAvailable()) return
  var ctx = chartCtx("chartTokens")
  if (!ctx) return
  var stacked = document.getElementById("toggleStack").checked
  if (chartTokens) chartTokens.destroy()
  chartTokens = new Chart(ctx, {
    type: "bar",
    data: {
      labels: data.map(function(r){return r.created.slice(0,19).replace("T"," ")}),
      datasets: [
        { label:"Input", data:data.map(function(r){return r.input}), backgroundColor:"#58a6ff80", borderColor:"#58a6ff", borderWidth:1 },
        { label:"Output", data:data.map(function(r){return r.output}), backgroundColor:"#3fb95080", borderColor:"#3fb950", borderWidth:1 },
        { label:"Cache Read", data:data.map(function(r){return r.cacheRead}), backgroundColor:"#d2992280", borderColor:"#d29922", borderWidth:1 },
        { label:"Cache Write", data:data.map(function(r){return r.cacheWrite}), backgroundColor:"#a371f780", borderColor:"#a371f7", borderWidth:1 }
      ]
    },
    options: {
      responsive:true, maintainAspectRatio:false, animation:false,
      scales: {
        x: { ticks:{color:"#8b949e",maxRotation:45,maxTicksLimit:20}, grid:{color:"#21262d"} },
        y: { stacked:stacked, beginAtZero:true, ticks:{color:"#8b949e"}, grid:{color:"#21262d"} }
      },
      plugins: { legend:{ labels:{color:"#e6edf3",boxWidth:12,padding:12} } }
    }
  })
}

function buildHitCostChart(data) {
  if (!chartAvailable()) return
  var ctx = chartCtx("chartHitCost")
  if (!ctx) return
  if (chartHitCost) chartHitCost.destroy()
  chartHitCost = new Chart(ctx, {
    type: "line",
    data: {
      labels: data.map(function(r){return r.created.slice(0,19).replace("T"," ")}),
      datasets: [
        { label:"Hit %", data:data.map(function(r){return r.hitPercent}), yAxisID:"y",
          borderColor:"#3fb950", backgroundColor:"#3fb95022", fill:true, tension:0.2,
          pointRadius:2, pointBackgroundColor:"#3fb950" },
        { label:COST_DISPLAY.chartLabel, data:data.map(function(r){return convertCost(costOf(r))}), yAxisID:"y1",
          borderColor:"#f85149", backgroundColor:"#f8514922", fill:true, tension:0.2,
          pointRadius:2, pointBackgroundColor:"#f85149" }
      ]
    },
    options: {
      responsive:true, maintainAspectRatio:false, animation:false,
      scales: {
        x: { ticks:{color:"#8b949e",maxRotation:45,maxTicksLimit:20}, grid:{color:"#21262d"} },
        y: { type:"linear", position:"left", min:0, max:100, ticks:{color:"#3fb950"}, grid:{color:"#21262d"}, title:{display:true, text:"Hit %", color:"#3fb950"} },
        y1: { type:"linear", position:"right", min:0, ticks:{color:"#f85149"}, grid:{display:false}, title:{display:true, text:COST_DISPLAY.chartLabel, color:"#f85149"} }
      },
      plugins: { legend:{ labels:{color:"#e6edf3",boxWidth:12,padding:12} } }
    }
  })
}

function buildDurationChart(data) {
  if (!chartAvailable()) return
  var ctx = chartCtx("chartDuration")
  if (!ctx) return
  if (chartDuration) chartDuration.destroy()
  chartDuration = new Chart(ctx, {
    type: "bar",
    data: {
      labels: data.map(function(r){return r.created.slice(0,19).replace("T"," ")}),
      datasets: [
        { label:"Duration (ms)", data:data.map(function(r){return r.durationMs||0}), backgroundColor:"#58a6ff80", borderColor:"#58a6ff", borderWidth:1 }
      ]
    },
    options: {
      responsive:true, maintainAspectRatio:false, animation:false,
      scales: {
        x: { ticks:{color:"#8b949e",maxRotation:45,maxTicksLimit:20}, grid:{color:"#21262d"} },
        y: { beginAtZero:true, ticks:{color:"#8b949e"}, grid:{color:"#21262d"} }
      },
      plugins: { legend:{ labels:{color:"#e6edf3",boxWidth:12,padding:12} } }
    }
  })
}

function renderSessionTable(data) {
  var map = {}
  data.forEach(function(r){
    var id = r.rootSessionId || "(unknown)"
    if (!map[id]) map[id] = []
    map[id].push(r)
  })
  var rows = []
  Object.keys(map).forEach(function(id){
    var rd = map[id]
    var hits = hitValues(rd)
    var models = [...new Set(rd.map(function(r){return r.modelId}).filter(Boolean))]
    var scope = sessionScopeLabel(rd)
    var avg = hits.length ? hits.reduce(function(s,h){return s+h},0)/hits.length : 0
    var totalT = rd.reduce(function(s,r){return s+r.input+r.output+r.cacheRead+r.cacheWrite},0)
    var ttfts = rd.filter(function(r){return r.ttftMs != null && r.ttftMs > 0}).map(function(r){return r.ttftMs})
    var ttps = rd.filter(function(r){return r.tps != null && r.tps > 0}).map(function(r){return r.tps})
    var tpots = rd.filter(function(r){return r.tpot != null && r.tpot > 0}).map(function(r){return r.tpot})
    rows.push({
      id:id, model:models.join(" | ")||"(unknown)", scope:scope,
      calls:rd.length, totalT:totalT,
      ti:rd.reduce(function(s,r){return s+r.input},0),
      to:rd.reduce(function(s,r){return s+r.output},0),
      tcr:rd.reduce(function(s,r){return s+r.cacheRead},0),
      avg:avg, cost:rd.reduce(function(s,r){return s+costOf(r)},0), dynUsed:rd.some(function(r){return r.dynCost != null}),
      avgTtft: ttfts.length ? ttfts.reduce(function(s,v){return s+v},0)/ttfts.length : null,
      avgTps: ttps.length ? ttps.reduce(function(s,v){return s+v},0)/ttps.length : null,
      avgTpot: tpots.length ? tpots.reduce(function(s,v){return s+v},0)/tpots.length : null,
      start:rd[0].created||""
    })
  })
  rows.sort(function(a,b){return a.start.localeCompare(b.start)})
  var cls = function(p){return p>90?"ok":p>70?"warn":"err"}
  document.getElementById("sessionBody").innerHTML = rows.map(function(r){
    return '<tr><td style="max-width:180px;overflow:hidden;text-overflow:ellipsis" title="'+esc(r.id)+'">'+esc(r.id.slice(-16))+
      '</td><td><span class="pill pill-model">'+esc(r.model)+'</span></td><td><span class="pill '+scopePillClass(r.scope)+'">'+esc(r.scope)+
      '</span></td><td class="num">'+r.calls+'</td><td class="num">'+(r.totalT/1e6).toFixed(2)+'M</td><td class="num">'+r.ti.toLocaleString()+
      '</td><td class="num">'+r.to.toLocaleString()+'</td><td class="num">'+r.tcr.toLocaleString()+
      '</td><td class="num '+cls(r.avg)+'">'+r.avg.toFixed(1)+'%</td><td class="num">'+(r.dynUsed?"\u2248":"")+fmtCost(r.cost)+
      '</td><td class="num">'+fmtTtft(r.avgTtft)+'</td><td class="num">'+fmtTps(r.avgTps)+
      '</td><td class="num">'+fmtTpot(r.avgTpot)+
      '</td><td>'+r.start.slice(0,19)+'</td></tr>'
  }).join("")
}

function expandDetailGrid(r) {
  return EXPAND_FIELDS.map(function(f){
    var v = r[f]
    if (v == null) v = "-"
    else if (f === "cost") {
      var rawCost = v
      v = String(rawCost) + " " + COST_DISPLAY.costUnit
      if (COST_DISPLAY.rate !== 1) v += " (" + fmtCost(rawCost) + ")"
      if (r.dynCost != null && Math.abs(r.dynCost - r.cost) > 1e-12) v += " | dyn " + fmtCost(r.dynCost)
    }
    else if (typeof v === "boolean") v = v ? "true" : "false"
    else if (Array.isArray(v)) {
      var json = JSON.stringify(v, null, 2)
      return '<div class="dg-item"><span class="dg-label">'+f+'</span><span class="dg-value"><pre>'+esc(json)+'</pre></span></div>'
    }
    else v = String(v)
    return '<div class="dg-item"><span class="dg-label">'+f+'</span><span class="dg-value" title="'+esc(v)+'">'+esc(v)+'</span></div>'
  }).join("")
}

function renderDetailTable(data) {
  var ps = parseInt(document.getElementById("pageSize").value)
  var disp = ps >= data.length ? data : data.slice(data.length - ps)
  var cls = function(p){return p!=null?(p>90?"ok":p>70?"warn":"err"):""}
  document.getElementById("detailBody").innerHTML = disp.map(function(r, i){
    var shortId = r.rootSessionId ? r.rootSessionId.slice(-12) : "-"
    var hitPct = r.hitPercent != null ? r.hitPercent.toFixed(1)+"%" : "-"
    return '<tr class="dp" data-idx="'+i+'">'+
      '<td style="cursor:pointer;color:#8b949e;text-align:center;font-size:16px;user-select:none">&#9654;</td>'+
      '<td class="num">'+r.created.slice(0,19).replace("T"," ")+'</td>'+
      '<td><span class="pill '+scopePillClass(r.scope)+'">'+esc(r.scope)+'</span></td>'+
      '<td style="max-width:120px;overflow:hidden;text-overflow:ellipsis" title="'+esc(r.rootSessionId||"")+'">'+esc(shortId)+'</td>'+
      '<td><span class="pill pill-model">'+esc(r.modelId||"-")+'</span></td>'+
      '<td class="num">'+r.input.toLocaleString()+'</td>'+
      '<td class="num">'+r.output.toLocaleString()+'</td>'+
      '<td class="num">'+r.cacheRead.toLocaleString()+'</td>'+
      '<td class="num">'+r.cacheWrite.toLocaleString()+'</td>'+
      '<td class="num '+cls(r.hitPercent)+'">'+hitPct+'</td>'+
      '<td class="num">'+fmtCostOf(r)+'</td>'+
      '<td class="num">'+fmtDur(r.durationMs)+'</td>'+
      '<td class="num">'+fmtTtft(r.ttftMs)+'</td>'+
      '<td class="num">'+fmtTps(r.tps)+'</td>'+
      '<td class="num">'+fmtTpot(r.tpot)+'</td>'+
    '</tr>'+
    '<tr class="dr" data-idx="'+i+'"><td colspan="15"><div class="detail-inner"><div class="detail-grid">'+expandDetailGrid(r)+'</div></div></td></tr>'
  }).join("")
}

document.getElementById("detailBody").addEventListener("click", function(e){
  var row = e.target.closest(".dp")
  if (!row) return
  var idx = row.dataset["idx"]
  var detail = document.querySelector('.dr[data-idx="'+idx+'"]')
  if (detail) {
    detail.classList.toggle("open")
    row.querySelector("td:first-child").innerHTML = detail.classList.contains("open") ? "&#9660;" : "&#9654;"
  }
})

function refresh() {
  var data = getFilteredData()
  renderSummary(data)
  updateSubtitle(data)
  buildTokenChart(data)
  buildHitCostChart(data)
  buildDurationChart(data)
  renderSessionTable(data)
  renderDetailTable(data)
}

var searchTimer = null
document.getElementById("toggleStack").addEventListener("change", refresh)
document.getElementById("filterDateFrom").addEventListener("change", refresh)
document.getElementById("filterDateTo").addEventListener("change", refresh)
document.getElementById("filterSession").addEventListener("change", refresh)
document.getElementById("filterScope").addEventListener("change", refresh)
document.getElementById("filterModel").addEventListener("change", refresh)
document.getElementById("filterSearch").addEventListener("input", function(){
  clearTimeout(searchTimer)
  searchTimer = setTimeout(refresh, 200)
})
document.getElementById("pageSize").addEventListener("change", refresh)

var tipEl = document.createElement("div")
tipEl.className = "tip-box"
document.body.appendChild(tipEl)
document.querySelectorAll(".tip-trigger").forEach(function(el){
  el.addEventListener("mouseenter", function(e){
    tipEl.textContent = el.getAttribute("data-tip")
    tipEl.style.display = "block"
    tipEl.style.left = e.clientX + "px"
    tipEl.style.top = (e.clientY + 14) + "px"
  })
  el.addEventListener("mousemove", function(e){
    tipEl.style.left = e.clientX + "px"
    tipEl.style.top = (e.clientY + 14) + "px"
  })
  el.addEventListener("mouseleave", function(){
    tipEl.style.display = "none"
  })
})

applyCostLabels()
populateFilters()
refresh()
</script>
</body>
</html>`.split("TMPL_DATA")
  if (parts.length !== 2) throw new Error("TMPL_DATA placeholder count mismatch")
  const costParts = parts[1].split("TMPL_COST")
  if (costParts.length !== 2) throw new Error("TMPL_COST placeholder count mismatch")
  return parts[0] + jsonData + costParts[0] + jsonCost + costParts[1]
}

function openInBrowser(filePath: string): void {
  const quoted = JSON.stringify(filePath)
  if (process.platform === "darwin") execSync(`open ${quoted}`)
  else if (process.platform === "win32") execSync(`cmd /c start "" ${quoted}`)
  else execSync(`xdg-open ${quoted}`)
}

const { patterns, output, open } = parseArgs(process.argv.slice(2))
const paths = await resolveInputPaths(patterns)
if (paths.length === 0) {
  console.error(
    "No timeline JSONL files found.\n" +
      "Pass paths/globs or ensure ~/.local/share/opencode/logs/cache-hit/ exists.",
  )
  process.exit(1)
}

console.error("Reading " + paths.length + " file(s):")
for (const p of paths) {
  const stats = await Bun.file(p).stat()
  console.error("  " + p + " (" + (stats.size / 1024).toFixed(1) + " KB)")
}

const records = await loadRecords(paths)
if (records.length === 0) {
  console.error("No valid records found.")
  process.exit(1)
}

// Offline dynamic-pricing recompute: inject dynCost per record (time + context tier); the UI prefers it when present.
{
  const providers = loadOpencodeProviders()
  const rules = loadPluginConfig().dynamicPricing
  if (providers.length > 0) {
    let injected = 0
    for (const r of records) {
      const dc = recomputeRecordCost(r, providers, rules)
      if (dc !== null) {
        r.dynCost = dc
        injected++
      }
    }
    if (injected > 0) {
      console.error(`dynamic pricing: recomputed cost for ${injected}/${records.length} records`)
    }
  }
}

function loadCostContext(): { embed: CostDisplayEmbed; format: (n: number) => string } {
  try {
    const cost = normalizeCostDisplay(loadPluginConfig().cost)
    return {
      embed: normalizeCostDisplayEmbed(cost),
      format: createCostFormatter(cost),
    }
  } catch {
    const cost = normalizeCostDisplay(null)
    return { embed: normalizeCostDisplayEmbed(cost), format: createCostFormatter(cost) }
  }
}

const { embed: costEmbed, format: fmtCostCli } = loadCostContext()
const stats = summarizeStats(records)
console.error(
  records.length +
    " records, " +
    stats.totalSessions +
    " sessions, " +
    (fmtCostCli(stats.totalCost) || stats.totalCost.toFixed(6) + " " + costEmbed.costUnit) +
    " total cost",
)
if (costEmbed.costNote) console.error("  " + costEmbed.costNote)

const html = genHTML(records, costEmbed)
await Bun.write(output, html)
console.error("Written: " + output + " (" + (Buffer.byteLength(html) / 1024).toFixed(0) + " KB)")

if (open) {
  openInBrowser(resolve(output))
  console.error("Opened in browser")
}
