import { createMemo, createSignal, onCleanup, type Accessor } from "solid-js"
import type { DisplayConfig, DynamicPricingConfig } from "./plugin-config.ts"
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
  emptySessionSnapshot,
  mainSessionHasStats,
  shortModelName,
} from "./stats.ts"
import { computePricing, computeSubsSaved, type PricingInfo } from "./pricing.ts"
import { recomputeSessionCost, recomputeSubAgentCost } from "./dynamic-pricing/recompute.ts"
import { nextBoundaryMs } from "./dynamic-pricing/schedule.ts"
import {
  computeAvgTokenTpotMs,
  computeTokenTpotMs,
  formatTokenTpot,
} from "./token-speed.ts"
import {
  computeAvgTokenSpeed,
  computeTokenSpeed,
  formatTokenSpeed,
} from "./token-speed.ts"
import { generationDurationMs, timingFromAssistantMessage } from "./message-timing.ts"
import { formatSparkline, collectTpotValues, collectSpeedValues } from "./sparkline.ts"

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
  dynamicPricing: DynamicPricingConfig
  layout: PanelLayout
  firstPartTime: Accessor<ReadonlyMap<string, number>>
}) {
  const pal = createMemo(() => buildPanelPalette(props.theme()))
  const t = createMemo(() => getUiStrings(activeLang(props.display)))
  const hitLabel = createMemo(() => props.display.mainHitLabel ?? t().hit)
  const subs = createMemo(() => props.subAgents())
  const main = createMemo(() => props.main() ?? emptySessionSnapshot())
  const perCall = createMemo(() => computePerCallHitTrend(props.messages()))
  const sessionRatio = createMemo(() => cacheHitRatio(main().cacheRead, main().input))

  // Dynamic pricing: precise refresh at schedule boundaries (no polling).
  // Single timer ref + component-owner onCleanup: recursively scheduled timers are
  // cleaned up on unmount (onCleanup inside the setTimeout callback would be outside
  // the Solid owner and never fire on unmount).
  const [now, setNow] = createSignal(Date.now())
  let boundaryTimer: ReturnType<typeof setTimeout> | undefined
  const scheduleBoundary = () => {
    const rules = props.dynamicPricing
    const ms =
      rules.schedule.length > 0 ? nextBoundaryMs(now(), rules.schedule, rules.timezone || "UTC") : 0
    if (ms <= 0) return
    boundaryTimer = setTimeout(() => {
      setNow(Date.now())
      scheduleBoundary()
    }, ms)
  }
  onCleanup(() => {
    if (boundaryTimer !== undefined) clearTimeout(boundaryTimer)
  })
  scheduleBoundary()

  const pricing = createMemo<PricingInfo>(() =>
    computePricing(props.providers(), main().providerID, main().model, main().cacheRead, {
      now: now(),
      contextTokens: main().input + main().cacheRead,
      rules: props.dynamicPricing,
    }),
  )

  // Sub-agent cache savings: level by current time-of-day + each child's total input (input + cacheRead).
  const subsSaved = createMemo(() =>
    computeSubsSaved(subs(), props.providers(), {
      now: now(),
      rules: props.dynamicPricing,
    }),
  )

  // Dynamic cost recompute (per-message request time + context tier); unpriced → null.
  const recomputedCost = createMemo(() =>
    recomputeSessionCost(props.messages(), props.providers(), props.dynamicPricing),
  )

  // Sub-agent dynamic cost (session creation time + aggregate tokens); no created / unpriced → null.
  const subAgentDynamicCosts = createMemo(() => {
    const rules = props.dynamicPricing
    const providers = props.providers()
    return new Map(
      subs().map((s) => [s.id, recomputeSubAgentCost(s, providers, rules)] as const),
    )
  })

  const mainHasStats = createMemo(() => mainSessionHasStats(main()))
  const hasData = createMemo(() => mainHasStats() || subs().length > 0)

  const trendLabel = createMemo(() =>
    perCall().hasTrend ? formatTrendLabel(perCall().trendPercent) : "",
  )
  const bar = createMemo(() =>
    formatHitBar(
      perCall().hitPercent / 100,
      computeHitBarWidth(hitLabel(), props.layout.gauge(), trendLabel(), perCall().hasTrend),
    ),
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

  const useTps = createMemo(() => props.display.speedUnit === "tps")

  const lastSpeed = createMemo(() => {
    const msgs = props.messages()
    const firstPartTime = props.firstPartTime()
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].summary) continue
      const timing = timingFromAssistantMessage(msgs[i])
      if (!timing?.isComplete) continue
      const output = msgs[i].tokens?.output ?? 0
      const reasoning = msgs[i].tokens?.reasoning ?? 0
      if (output + reasoning === 0) continue
      const msgID = msgs[i].id ?? msgs[i].messageID
      const firstTime = msgID ? firstPartTime.get(msgID) : undefined
      const durationMs = generationDurationMs(timing, firstTime)
      if (durationMs === undefined) continue
      const v = useTps()
        ? computeTokenSpeed(output, reasoning, durationMs)
        : computeTokenTpotMs(output, reasoning, durationMs)
      return v === 0 ? undefined : v
    }
    return undefined
  })

  const avgSpeed = createMemo(() => {
    if (useTps()) {
      const v = computeAvgTokenSpeed(props.messages(), props.firstPartTime())
      return v === 0 ? undefined : v
    }
    return computeAvgTokenTpotMs(props.messages(), props.firstPartTime())
  })

  const speedValues = createMemo(() => {
    const msgs = props.messages()
    const firstPartTime = props.firstPartTime()
    const records = msgs
      .filter((msg) => msg.role === "assistant" && !msg.summary && msg.time?.completed)
      .map((msg) => {
        const timing = timingFromAssistantMessage(msg)
        const msgID = msg.id ?? msg.messageID
        const firstTime = msgID ? firstPartTime.get(msgID) : undefined
        return {
          durationMs: timing ? generationDurationMs(timing, firstTime) : undefined,
          output: msg.tokens?.output ?? 0,
          reasoning: msg.tokens?.reasoning ?? 0,
        }
      })
    return useTps() ? collectSpeedValues(records) : collectTpotValues(records)
  })

  const lastSpeedLabel = createMemo(() =>
    useTps() ? formatTokenSpeed(lastSpeed() ?? 0) : formatTokenTpot(lastSpeed()),
  )

  const avgSpeedLabel = createMemo(() =>
    useTps() ? formatTokenSpeed(avgSpeed() ?? 0) : formatTokenTpot(avgSpeed()),
  )

  const sparkline = createMemo(() => formatSparkline(speedValues()))

  const lastTtft = createMemo(() => {
    const msgs = props.messages()
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].summary) continue
      const msgID = msgs[i].id ?? msgs[i].messageID
      if (!msgID) continue
      const firstTime = props.firstPartTime().get(msgID)
      if (firstTime === undefined) continue
      const timing = timingFromAssistantMessage(msgs[i])
      if (!timing) continue
      if (firstTime <= timing.created) continue
      return firstTime - timing.created
    }
    return undefined
  })

  const lastTtftLabel = createMemo(() => {
    const ttft = lastTtft()
    if (ttft === undefined) return "—"
    if (ttft < 1000) return `${ttft}ms`
    return `${(ttft / 1000).toFixed(1)}s`
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
    recomputedCost,
    subAgentDynamicCosts,
    subsSaved,
    collapsedHitSummary,
    useTps,
    lastSpeed,
    lastSpeedLabel,
    avgSpeed,
    avgSpeedLabel,
    sparkline,
    lastTtft,
    lastTtftLabel,
  }
}

export type CacheHitMetrics = ReturnType<typeof useCacheHitMetrics>
