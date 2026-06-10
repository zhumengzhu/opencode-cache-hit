import { createMemo, type Accessor } from "solid-js"
import type { DisplayConfig } from "./plugin-config.ts"
import { getUiStrings, resolveLang } from "./i18n.ts"
import {
  formatHitBar,
  formatPercentOneDecimal,
  formatRatioAsPercent,
  formatTrendLabel,
} from "./format-cache-ui.ts"
import { computeHitBarWidth, visualWidth } from "./tui-panel/layout.ts"
import { buildPanelPalette, type PanelPalette } from "./tui-panel/palette.ts"
import type { PanelLayout } from "./tui-panel/use-panel-layout.ts"
import type { AssistantMessage, ProviderInfo, SessionSnapshot, SubAgentSummary } from "./types.ts"
import {
  cacheHitRatio,
  computePerCallHitTrend,
  contextUsage,
  mainSessionHasStats,
  shortModelName,
} from "./stats.ts"
import type { ContextUsage } from "./stats.ts"
import { computePricing, type PricingInfo } from "./pricing.ts"

function activeLang(display: DisplayConfig) {
  return display.lang === "auto" ? resolveLang("auto") : display.lang
}

function hitRateColor(pct: number, pal: PanelPalette): string {
  if (pct >= 85) return pal.success
  if (pct >= 70) return pal.warning
  return pal.muted
}

export function useCacheHitMetrics(props: {
  theme: Accessor<Record<string, unknown>>
  display: DisplayConfig
  messages: Accessor<AssistantMessage[]>
  main: Accessor<SessionSnapshot>
  subAgents: Accessor<SubAgentSummary[]>
  providers: Accessor<ReadonlyArray<ProviderInfo>>
  layout: PanelLayout
}) {
  const pal = createMemo(() => buildPanelPalette(props.theme()))
  const t = createMemo(() => getUiStrings(activeLang(props.display)))
  const hitLabel = createMemo(() => props.display.mainHitLabel ?? t().hit)
  const subs = createMemo(() => props.subAgents())
  const main = createMemo(() => props.main())
  const perCall = createMemo(() => computePerCallHitTrend(props.messages()))
  const sessionRatio = createMemo(() => cacheHitRatio(main().cacheRead, main().input))

  const pricing = createMemo<PricingInfo>(() =>
    computePricing(props.providers(), main().providerID, main().model, main().cacheRead),
  )

  const mainHasStats = createMemo(() => mainSessionHasStats(main()))
  const hasData = createMemo(() => mainHasStats() || subs().length > 0)

  const trendLabel = createMemo(() =>
    perCall().hasTrend ? formatTrendLabel(perCall().trendPercent) : "",
  )
  const hitBarWidth = createMemo(() =>
    computeHitBarWidth(hitLabel(), props.layout.gauge(), trendLabel(), perCall().hasTrend),
  )

  const bar = createMemo(() =>
    formatHitBar(perCall().hitPercent / 100, hitBarWidth()),
  )
  const hitColor = createMemo(() => hitRateColor(perCall().hitPercent, pal()))
  const trendFg = createMemo(() => {
    const tr = perCall().trendPercent
    if (Math.abs(tr) < 0.05) return pal().text
    return tr > 0 ? pal().success : pal().error
  })

  const collapsedHitSummary = createMemo(() => {
    const right = perCall().hasTrend
      ? `${formatPercentOneDecimal(perCall().hitPercent)} ${t().hitFolded} ${trendLabel()}`
      : `${formatPercentOneDecimal(perCall().hitPercent)} ${t().hitFolded}`
    return { text: right, width: visualWidth(right) }
  })

  const modelCtxLimit = createMemo(() => {
    const m = main().model
    const pid = main().providerID
    if (!m || !pid) return undefined
    return props.providers().find((p) => p.id === pid)?.models[m]?.limit?.context
  })

  const ctx = createMemo(() => contextUsage(props.messages(), modelCtxLimit()))

  const ctxBar = createMemo(() => {
    const c = ctx()
    if (!c || c.percent === null) return ""
    return formatHitBar(c.percent / 100, hitBarWidth())
  })

  let ctxPrevTokens = 0
  const ctxTrend = createMemo(() => {
    const c = ctx()
    if (!c || c.percent === null) {
      ctxPrevTokens = 0
      return null
    }
    const prev = ctxPrevTokens
    ctxPrevTokens = c.tokens
    if (prev === 0) return null
    const d = c.tokens - prev
    if (d === 0) return null
    const sign = d > 0 ? "\u2191" : "\u2193"
    const abs = Math.abs(d)
    const text = abs >= 1000 ? `${(abs / 1000).toFixed(1)}K` : String(abs)
    return `${sign}${text}`
  })

  return {
    pal,
    t,
    hitLabel,
    subs,
    main,
    mainHasStats,
    perCall,
    pricing,
    sessionPct: createMemo(() => formatRatioAsPercent(sessionRatio())),

    hasData,
    trendLabel,
    bar,
    hitColor,
    trendFg,
    pctLabel: createMemo(() => formatPercentOneDecimal(perCall().hitPercent)),
    modelShort: createMemo(() => shortModelName(main().model)),
    totalSubCost: createMemo(() => subs().reduce((s, a) => s + a.cost, 0)),
    collapsedHitSummary,
    modelCtxLimit,
    ctx,
    ctxBar,
    ctxTrend,
  }
}

export type CacheHitMetrics = ReturnType<typeof useCacheHitMetrics>
