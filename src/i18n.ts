export type Lang = "en" | "zh"

export type UiStrings = {
  title: string
  hit: string
  totalHit: string
  read: string
  write: string
  miss: string
  out: string
  reasoning: string
  cost: string
  saved: string
  rate: string
  rateIn: string
  rateOut: string
  rateCache: string
  hitFolded: string
  noData: string
  secDetail: string
  secModel: string
  model: string
  secAgents: string
  /** Shown in Agents section header: totals are child sessions only, not the parent session. */
  agentsScopeHint: string
  secTTL: string
  ctx: string
  tok: string
}

const EN: UiStrings = {
  title: "Cache Hit",
  hit: "Hit",
  totalHit: "Total Hit:",
  read: "Read:",
  write: "Write:",
  miss: "Miss:",
  out: "Out:",
  reasoning: "Reason:",
  cost: "Cost:",
  saved: "Saved:",
  rate: "Rate:",
  rateIn: "/M in",
  rateOut: "/M out",
  rateCache: "/M cache",
  hitFolded: "hit",
  noData: "Waiting for cache data...",
  secDetail: "Detail",
  secModel: "Model",
  model: "Model:",
  secAgents: "Agents",
  agentsScopeHint: " · sub-sessions",
  secTTL: "TTL:",
  ctx: "Context",
  tok: "tok",
}

const ZH: UiStrings = {
  title: "缓存命中",
  hit: "命中率",
  totalHit: "总命中:",
  read: "缓存读:",
  write: "缓存写:",
  miss: "未命中:",
  out: "输出:",
  reasoning: "推理:",
  cost: "费用:",
  saved: "节省:",
  rate: "单价:",
  rateIn: "/M 输入",
  rateOut: "/M 输出",
  rateCache: "/M 缓存",
  hitFolded: "命中",
  noData: "等待缓存数据...",
  secDetail: "明细",
  secModel: "模型",
  model: "模型:",
  secAgents: "子 Agent",
  agentsScopeHint: " · 仅子会话",
  secTTL: "存活:",
  ctx: "上下文",
  tok: "tok",
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
