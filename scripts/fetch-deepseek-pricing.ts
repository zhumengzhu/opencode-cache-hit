#!/usr/bin/env bun
/**
 * Fetch DeepSeek official peak/off-peak pricing and print a ready-to-paste
 * `dynamicPricing.providers` snippet for cache-hit.json.
 *
 *   bun scripts/fetch-deepseek-pricing.ts                 # CNY per 1M tokens
 *   bun scripts/fetch-deepseek-pricing.ts --usd           # USD (divide by --rate)
 *   bun scripts/fetch-deepseek-pricing.ts --usd --rate 6.77
 *   bun scripts/fetch-deepseek-pricing.ts --url <mirror>  # custom page URL
 *
 * Output is JSON you can merge into cache-hit.json under "dynamicPricing":
 *   "dynamicPricing": { ...existing..., <printed "schedule" and "providers" objects> }
 * The printed schedule is weekday-aware (peak Mon-Fri, offpeak catch-all fallback)
 * to match DeepSeek's official weekend-idle pricing.
 */

// Make this file a module for TS tooling (top-level await below).
export {}

const argv = process.argv
const url =
  argv.indexOf("--url") >= 0
    ? argv[argv.indexOf("--url") + 1]
    : "https://api-docs.deepseek.com/zh-cn/quick_start/pricing"
const useUsd = argv.includes("--usd")
const rateIdx = argv.indexOf("--rate")
const rate = rateIdx >= 0 ? Number(argv[rateIdx + 1]) : 6.77

type Group = { offpeak: number[]; peak: number[] }

function parsePriceGroups(html: string): Group[] {
  // Official table lists, in order: cache-hit input, cache-miss input, output.
  const offpeak = [...html.matchAll(/空闲时段<\/td><td>([\d.]+)元<\/td><td>([\d.]+)元<\/td>/g)].map(
    (m) => [Number(m[1]), Number(m[2])],
  )
  const peak = [...html.matchAll(/高峰时段<\/td><td>([\d.]+)元<\/td><td>([\d.]+)元<\/td>/g)].map(
    (m) => [Number(m[1]), Number(m[2])],
  )
  if (offpeak.length !== 3 || peak.length !== 3) {
    throw new Error(
      `table parse failed: found ${offpeak.length} offpeak / ${peak.length} peak rows (expected 3 each)`,
    )
  }
  return offpeak.map((o, i) => ({ offpeak: o, peak: peak[i] }))
}

function convert(v: number): number {
  if (!useUsd) return v
  if (!Number.isFinite(rate) || rate <= 0) throw new Error("--rate must be a positive number")
  return Math.round((v / rate) * 1e6) / 1e6
}

function modelLevels(groups: Group[], col: 0 | 1) {
  // groups[0] = cache-hit input (cacheRead), [1] = cache-miss input (input), [2] = output.
  // Each group holds [flash, pro]; `col` picks the model column.
  const pick = (g: Group, level: "offpeak" | "peak") => convert(g[level][col])
  return {
    offpeak: {
      input: pick(groups[1], "offpeak"),
      output: pick(groups[2], "offpeak"),
      cacheRead: pick(groups[0], "offpeak"),
      cacheWrite: 0,
    },
    peak: {
      input: pick(groups[1], "peak"),
      output: pick(groups[2], "peak"),
      cacheRead: pick(groups[0], "peak"),
      cacheWrite: 0,
    },
  }
}

try {
  console.error(`fetching ${url} ...`)
  const html = await (await fetch(url)).text()
  const groups = parsePriceGroups(html)
  const unit = useUsd ? `USD (÷${rate})` : "CNY"
  const snippet = {
    // DeepSeek 官方高峰：北京时间周一~周五 9:00-12:00 / 14:00-18:00；其余（含周末）为空闲。
    // 旧写法（peak 无 days）周末仍按高峰，请保留 days:[1,2,3,4,5]。
    schedule: [
      { level: "peak", windows: [
        { start: "09:00", end: "12:00", days: [1, 2, 3, 4, 5] },
        { start: "14:00", end: "18:00", days: [1, 2, 3, 4, 5] },
      ] },
      { level: "offpeak", windows: [] }, // 回退档：一切未覆盖时刻（含周末）为空闲
    ],
    providers: {
      "deepseek": {
        models: {
          "deepseek/deepseek-v4-flash": {
            currency: useUsd ? "USD" : "CNY",
            levels: modelLevels(groups, 0),
          },
          "deepseek/deepseek-v4-pro": {
            currency: useUsd ? "USD" : "CNY",
            levels: modelLevels(groups, 1),
          },
        },
      },
    },
  }
  console.error(`parsed ${groups.length} price groups, unit: ${unit} per 1M tokens`)
  console.error("paste the object below into cache-hit.json → \"dynamicPricing\" (merge with existing keys):")
  console.log(JSON.stringify(snippet, null, 2))
} catch (e) {
  console.error(`error: ${(e as Error).message}`)
  process.exit(1)
}
