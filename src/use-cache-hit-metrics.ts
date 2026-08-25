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
import type { SessionMessageLoadStatus } from "./session-messages.ts"
import {
  aggregateSessionFromMessages,
  cacheHitRatio,
  computePerCallHitTrend,
  emptySessionSnapshot,
  isInteractiveAssistantMessage,
  mainSessionHasStats,
  shortModelName,
} from "./stats.ts"
import { activeLineageKey, aggregateLineages, recentLineages } from "./lineage-stats.ts"
import { computePricing, computeSessionPricing, computeSubsSaved, type PricingInfo } from "./pricing.ts"
import { recomputeSubAgentCost } from "./dynamic-pricing/recompute.ts"
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
  metricMessages?: Accessor<AssistantMessage[]>
  metricMessageStatus?: Accessor<SessionMessageLoadStatus>
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
  const metricInput = () => props.metricMessages?.() ?? props.messages()
  const lineages = createMemo(() => aggregateLineages(metricInput()))
  const activeKey = createMemo(() => activeLineageKey(metricInput()))
  const activeLineage = createMemo(() => lineages().find((lineage) => lineage.key === activeKey()))
  // DB-level session aggregate (session.get) when available; fall back to the loaded messages.
  const blendedMain = createMemo(() => {
    const base = props.main()
    return mainSessionHasStats(base) ? base : aggregateSessionFromMessages(metricInput())
  })
  const main = createMemo<SessionSnapshot>(() => {
    const base = props.main()
    const active = activeLineage()
    if (mainSessionHasStats(base)) {
      // DB-level session aggregate (session.get) is complete regardless of the
      // message-source cap; keep the active lineage as the Model row identity.
      return {
        ...base,
        lineageKey: active?.key ?? base.lineageKey,
        model: active?.modelID ?? base.model,
        providerID: active?.providerID ?? base.providerID,
      }
    }
    if (active) {
      return {
        lineageKey: active.key,
        model: active.modelID,
        providerID: active.providerID,
        input: active.input,
        output: active.output,
        reasoning: active.reasoning,
        cacheRead: active.cacheRead,
        cacheWrite: active.cacheWrite,
        cost: active.cost,
      }
    }
    return aggregateSessionFromMessages(metricInput())
  })
  const perCall = createMemo(() => computePerCallHitTrend(metricInput()))
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
  const sessionPricing = createMemo(() =>
    computeSessionPricing(metricInput(), props.providers(), props.dynamicPricing),
  )

  // Sub-agent cache savings: level by current time-of-day + each child's total input (input + cacheRead).
  const subsSaved = createMemo(() =>
    computeSubsSaved(subs(), props.providers(), {
      now: now(),
      rules: props.dynamicPricing,
    }),
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
  const hasData = createMemo(() => lineages().length > 0 || subs().length > 0)
  // No interactive messages in the main session: show an empty Hit row, not "0.0% warming".
  const noMainData = createMemo(() => lineages().length === 0)

  const trendLabel = createMemo(() => {
    if (noMainData()) return ""
    if (perCall().state === "switch") return t().switchState
    if (perCall().state === "warming") return t().warmingState
    return perCall().hasTrend ? formatTrendLabel(perCall().trendPercent) : ""
  })
  const bar = createMemo(() =>
    formatHitBar(
      perCall().hitPercent / 100,
      computeHitBarWidth(hitLabel(), props.layout.gauge(), trendLabel(), trendLabel().length > 0),
    ),
  )
  const hitColor = createMemo(() =>
    noMainData() ? pal().text : hitRateColor(perCall().hitPercent, pal()),
  )
  const trendFg = createMemo(() => {
    if (noMainData()) return pal().text
    if (perCall().state === "switch") return pal().warning
    if (perCall().state === "warming") return pal().muted
    const tr = perCall().trendPercent
    if (Math.abs(tr) < 0.05) return pal().text
    return tr > 0 ? pal().success : pal().error
  })

  const collapsedHitSummary = createMemo(() => {
    const left = noMainData() ? "-" : formatPercentOneDecimal(perCall().hitPercent)
    const right = trendLabel() ? `${left} ${t().hitFolded} ${trendLabel()}` : `${left} ${t().hitFolded}`
    return { text: right, width: visualWidth(right) }
  })

  const useTps = createMemo(() => props.display.speedUnit === "tps")

  const lastSpeed = createMemo(() => {
    const msgs = props.messages()
    const firstPartTime = props.firstPartTime()
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (!isInteractiveAssistantMessage(msgs[i])) continue
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
      .filter((msg) => isInteractiveAssistantMessage(msg) && msg.time?.completed)
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
      if (!isInteractiveAssistantMessage(msgs[i])) continue
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
    blendedMain,
    lineages,
    activeLineage,
    activeLineageKey: activeKey,
    metricMessages: metricInput,
    recentLineages: createMemo(() => recentLineages(lineages())),
    metricMessageStatus: () => props.metricMessageStatus?.() ?? "complete",
    mainHasStats,
    perCall,
    pricing,
    sessionPricing,
    sessionPct: createMemo(() =>
      mainSessionHasStats(main()) ? formatRatioAsPercent(sessionRatio()) : "-",
    ),

    hasData,
    trendLabel,
    bar,
    hitColor,
    trendFg,
    pctLabel: createMemo(() => (noMainData() ? "-" : formatPercentOneDecimal(perCall().hitPercent))),
    modelShort: createMemo(() => shortModelName(main().model)),
    totalSubCost: createMemo(() => subs().reduce((s, a) => s + a.cost, 0)),
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
