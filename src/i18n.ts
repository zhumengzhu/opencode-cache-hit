export type Lang = "en" | "zh"

export type UiStrings = {
  title: string
  hit: string
  totalHit: string
  historyIncomplete: string
  read: string
  write: string
  miss: string
  out: string
  reasoning: string
  cost: string
  saved: string
  readSavings: string
  writePremium: string
  netCacheValue: string
  rate: string
  rateIn: string
  rateOut: string
  rateCache: string
  hitFolded: string
  noData: string
  secDetail: string
  secModel: string
  secLineages: string
  model: string
  unknown: string
  secAgents: string
  /** Shown in Agents section header: totals are child sessions only, not the parent session. */
  agentsScopeHint: string
  secTTL: string
  tok: string
  secSpeed: string
  lastCall: string
  avg: string
  now: string
  trend: string
  switchState: string
  warmingState: string
  ttft: string
  /** Shown in Speed → Now when no stream is active (not a missing-data dash). */
  streamingIdle: string
  /** Prefix for session cost recomputed from dynamic pricing. */
  approx: string
  /** Time-of-day tier badges appended to the Rate label. */
  peakBadge: string
  offpeakBadge: string
  /** Context tier badge shown when over the context threshold. */
  over200kBadge: string
}

const EN: UiStrings = {
  title: "Cache Hit",
  hit: "Hit",
  totalHit: "Total Hit:",
  historyIncomplete: "* history truncated",
  read: "Read:",
  write: "Write:",
  miss: "Miss:",
  out: "Out:",
  reasoning: "Reason:",
  cost: "Cost:",
  saved: "Saved:",
  readSavings: "Read save:",
  writePremium: "Write cost:",
  netCacheValue: "Net cache:",
  rate: "Rate:",
  rateIn: "/M in",
  rateOut: "/M out",
  rateCache: "/M cache",
  hitFolded: "hit",
  noData: "Waiting for cache data...",
  secDetail: "Detail",
  secModel: "Model",
  secLineages: "Models",
  model: "Model:",
  unknown: "unknown",
  secAgents: "Agents",
  agentsScopeHint: " · sub-sessions",
  secTTL: "TTL:",
  tok: "tok",
  secSpeed: "Speed",
  lastCall: "Last:",
  avg: "Avg:",
  now: "Now:",
  trend: "Trend:",
  switchState: "switch",
  warmingState: "warming",
  ttft: "TTFT:",
  streamingIdle: "·",
  approx: "≈",
  peakBadge: "peak",
  offpeakBadge: "offpeak",
  over200kBadge: ">200k",
}

const ZH: UiStrings = {
  title: "缓存命中",
  hit: "命中率",
  totalHit: "总命中:",
  historyIncomplete: "* 历史记录可能已截断",
  read: "缓存读:",
  write: "缓存写:",
  miss: "未命中:",
  out: "输出:",
  reasoning: "推理:",
  cost: "费用:",
  saved: "节省:",
  readSavings: "读取节省:",
  writePremium: "写入成本:",
  netCacheValue: "缓存净值:",
  rate: "单价:",
  rateIn: "/M 输入",
  rateOut: "/M 输出",
  rateCache: "/M 缓存",
  hitFolded: "命中",
  noData: "等待缓存数据...",
  secDetail: "明细",
  secModel: "模型",
  secLineages: "模型",
  model: "模型:",
  unknown: "未知",
  secAgents: "子 Agent",
  agentsScopeHint: " · 仅子会话",
  secTTL: "存活:",
  tok: "tok",
  secSpeed: "速度",
  lastCall: "最近:",
  avg: "平均:",
  now: "实时:",
  trend: "趋势:",
  switchState: "切换",
  warmingState: "预热",
  ttft: "首Token:",
  streamingIdle: "·",
  approx: "≈",
  peakBadge: "高峰",
  offpeakBadge: "空闲",
  over200kBadge: ">200k",
}

export function resolveLang(raw: unknown): Lang {
  if (raw === "zh" || raw === "cn" || raw === "zh-CN") return "zh"
  if (raw === "en") return "en"
  if (raw === "auto") {
    try {
      return Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase().startsWith("zh") ? "zh" : "en"
    } catch {
      return "en"
    }
  }
  return "en"
}

export function getUiStrings(lang: Lang): UiStrings {
  return lang === "zh" ? ZH : EN
}
