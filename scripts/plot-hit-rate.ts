#!/usr/bin/env bun
/**
 * Plot cache hit % from timeline JSONL (Bun, no npm deps).
 *
 *   bun scripts/plot-hit-rate.ts logs/timeline-2026-05-31.jsonl
 *   bun scripts/plot-hit-rate.ts logs/timeline-2026-05-31.jsonl --root ses_xxx -o hit.svg
 *   bun scripts/plot-hit-rate.ts logs/timeline-2026-05-31.jsonl --by-root -o hit.svg
 */

type Row = {
  rootSessionId?: string
  scope?: string
  created?: string
  completedAt?: string
  hitPercent?: number | null
  skippedForHit?: boolean
}

type Point = { t: number; y: number }

const COLORS = ["#3fb950", "#58a6ff", "#d29922", "#f85149", "#a371f7", "#79c0ff"]

function parseArgs(argv: string[]) {
  const positional: string[] = []
  let root: string | undefined
  let output: string | undefined
  let byRoot = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--root") root = argv[++i]
    else if (a === "--by-root") byRoot = true
    else if (a === "-o" || a === "--output") output = argv[++i]
    else if (!a.startsWith("-")) positional.push(a)
  }
  if (!positional[0]) {
    console.error(
      "usage: bun scripts/plot-hit-rate.ts <file.jsonl> [--root ID | --by-root] [-o out.svg]",
    )
    process.exit(1)
  }
  return { file: positional[0], root, byRoot, output }
}

async function loadRecords(path: string, root?: string): Promise<Row[]> {
  const text = await Bun.file(path).text()
  const rows: Row[] = []
  for (const line of text.split("\n")) {
    const s = line.trim()
    if (!s) continue
    const rec = JSON.parse(s) as Row
    if (root && rec.rootSessionId !== root) continue
    if (rec.skippedForHit) continue
    if (rec.hitPercent == null) continue
    rows.push(rec)
  }
  return rows
}

function timeOf(r: Row): number {
  const ts = r.completedAt ?? r.created
  return ts ? new Date(ts).getTime() : 0
}

function groupByRoot(rows: Row[]): Map<string, Row[]> {
  const map = new Map<string, Row[]>()
  for (const r of rows) {
    const id = r.rootSessionId ?? "(unknown)"
    const list = map.get(id) ?? []
    list.push(r)
    map.set(id, list)
  }
  for (const list of map.values()) {
    list.sort((a, b) => timeOf(a) - timeOf(b))
  }
  return new Map([...map.entries()].sort((a, b) => a[0].localeCompare(b[0])))
}

function shortId(id: string, max = 20): string {
  return id.length <= max ? id : `…${id.slice(-max)}`
}

function asciiChart(values: number[], width = 48, height = 8): string {
  const grid: string[][] = Array.from({ length: height }, () => Array(width).fill(" "))
  const row = (v: number) =>
    Math.min(height - 1, Math.max(0, Math.round((v / 100) * (height - 1))))
  for (let i = 0; i < values.length; i++) {
    const x = Math.round((i / Math.max(1, values.length - 1)) * (width - 1))
    grid[height - 1 - row(values[i])][x] = "●"
  }
  const yLabels = ["100", " 50", "  0"]
  return grid.map((line, i) => `${yLabels[i] ?? "    "} │${line.join("")}`).join("\n")
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;")
}

function svgChartSingle(values: number[], title: string, w = 640, h = 240): string {
  const pad = { l: 48, r: 16, t: 24, b: 32 }
  const innerW = w - pad.l - pad.r
  const innerH = h - pad.t - pad.b
  const pts = values.map((v, i) => {
    const x = pad.l + (i / Math.max(1, values.length - 1)) * innerW
    const y = pad.t + innerH - (v / 100) * innerH
    return { x, y, v }
  })
  const poly = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <rect width="100%" height="100%" fill="#0d1117"/>
  <text x="${pad.l}" y="16" fill="#e6edf3" font-family="system-ui,sans-serif" font-size="12">${esc(title)}</text>
  <line x1="${pad.l}" y1="${pad.t + innerH}" x2="${pad.l + innerW}" y2="${pad.t + innerH}" stroke="#30363d"/>
  <line x1="${pad.l}" y1="${pad.t}" x2="${pad.l}" y2="${pad.t + innerH}" stroke="#30363d"/>
  <text x="8" y="${pad.t + 4}" fill="#8b949e" font-size="10">100%</text>
  <text x="8" y="${pad.t + innerH}" fill="#8b949e" font-size="10">0%</text>
  <polyline fill="none" stroke="${COLORS[0]}" stroke-width="2" points="${poly}"/>
  ${pts.map((p) => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3" fill="${COLORS[0]}"/>`).join("\n  ")}
</svg>`
}

function svgChartByRoot(
  series: { id: string; points: Point[] }[],
  title: string,
  w = 720,
  h = 280,
): string {
  const pad = { l: 48, r: 16, t: 28, b: 56 }
  const innerW = w - pad.l - pad.r
  const innerH = h - pad.t - pad.b
  let tMin = Infinity
  let tMax = -Infinity
  for (const s of series) {
    for (const p of s.points) {
      if (p.t < tMin) tMin = p.t
      if (p.t > tMax) tMax = p.t
    }
  }
  const span = Math.max(1, tMax - tMin)
  const toXY = (p: Point) => ({
    x: pad.l + ((p.t - tMin) / span) * innerW,
    y: pad.t + innerH - (p.y / 100) * innerH,
  })

  const bodies: string[] = []
  const legend: string[] = []
  series.forEach((s, i) => {
    const color = COLORS[i % COLORS.length]
    const xy = s.points.map(toXY)
    const poly = xy.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")
    bodies.push(
      `<polyline fill="none" stroke="${color}" stroke-width="2" points="${poly}"/>`,
    )
    for (const p of xy) {
      bodies.push(`<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="2.5" fill="${color}"/>`)
    }
    const ly = pad.t + innerH + 18 + i * 14
    legend.push(
      `<line x1="${pad.l}" y1="${ly - 4}" x2="${pad.l + 20}" y2="${ly - 4}" stroke="${color}" stroke-width="2"/>`,
      `<text x="${pad.l + 26}" y="${ly}" fill="#e6edf3" font-size="11" font-family="ui-monospace,monospace">${esc(shortId(s.id))} (${s.points.length})</text>`,
    )
  })

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <rect width="100%" height="100%" fill="#0d1117"/>
  <text x="${pad.l}" y="18" fill="#e6edf3" font-family="system-ui,sans-serif" font-size="12">${esc(title)}</text>
  <line x1="${pad.l}" y1="${pad.t + innerH}" x2="${pad.l + innerW}" y2="${pad.t + innerH}" stroke="#30363d"/>
  <line x1="${pad.l}" y1="${pad.t}" x2="${pad.l}" y2="${pad.t + innerH}" stroke="#30363d"/>
  <text x="8" y="${pad.t + 4}" fill="#8b949e" font-size="10">100%</text>
  <text x="8" y="${pad.t + innerH}" fill="#8b949e" font-size="10">0%</text>
  ${bodies.join("\n  ")}
  ${legend.join("\n  ")}
</svg>`
}

const { file, root, byRoot, output } = parseArgs(process.argv.slice(2))
const allRows = await loadRecords(file, root)

if (allRows.length === 0) {
  console.error("no plottable rows (check --root or hitPercent)")
  process.exit(1)
}

const useByRoot = byRoot && !root

if (useByRoot) {
  const groups = groupByRoot(allRows)
  console.log(`${groups.size} root session(s), ${allRows.length} calls total`)
  for (const [id, list] of groups) {
    const hits = list.map((r) => r.hitPercent as number)
    const avg = hits.reduce((a, b) => a + b, 0) / hits.length
    console.log(`  ${shortId(id, 28)}: ${list.length} calls, avg hit ${avg.toFixed(1)}%`)
  }
  if (output) {
    const series = [...groups.entries()].map(([id, list]) => ({
      id,
      points: list.map((r) => ({ t: timeOf(r), y: r.hitPercent as number })),
    }))
    await Bun.write(output, svgChartByRoot(series, `${file} · by rootSessionId`))
    console.log("")
    console.log(`wrote ${output} (${groups.size} series)`)
  } else {
    console.log("")
    console.log("tip: add -o /tmp/hit.svg (time-aligned, one color per rootSessionId)")
  }
} else {
  const sorted = [...allRows].sort((a, b) => timeOf(a) - timeOf(b))
  const hits = sorted.map((r) => r.hitPercent as number)
  const avg = hits.reduce((a, b) => a + b, 0) / hits.length
  const label = root ? ` (${shortId(root)})` : " (all roots merged)"
  console.log(`${sorted.length} calls, avg hit ${avg.toFixed(1)}%${label}`)
  console.log("")
  console.log(asciiChart(hits))
  if (output) {
    const title = root ? `${file} · ${shortId(root)}` : `${file} · merged`
    await Bun.write(output, svgChartSingle(hits, title))
    console.log("")
    console.log(`wrote ${output}`)
  } else {
    console.log("")
    console.log("tip: -o /tmp/hit.svg | --by-root for multi-session chart")
  }
}

// Keeps this file a module so tsc accepts its top-level await (Bun runs it either way).
export {}
