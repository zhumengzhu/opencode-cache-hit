/** @jsxImportSource @opentui/solid */
import { Show, createMemo, createSignal, onCleanup } from "solid-js"
import { TokenDetailRows } from "./cache-hit-rows.tsx"
import { CacheTTLView } from "./cache-ttl-view.tsx"
import { formatStreamingNowDisplay, type StreamingPhase } from "./streaming-state.ts"
import type { CacheHitMetrics } from "./use-cache-hit-metrics.ts"
import type { CacheTTLConfig } from "./plugin-config.ts"
import type { AssistantMessage } from "./types.ts"
import { formatRatioAsPercent } from "./format-cache-ui.ts"
import {
  TuiHitRow,
  TuiMetricRow,
  TuiSection,
  truncateVisual,
  type PanelLayout,
  type SectionFold,
} from "./tui-panel/index.ts"
import type { Accessor } from "solid-js"

export function MainSessionView(props: {
  m: CacheHitMetrics
  layout: PanelLayout
  detail: SectionFold
  speed: SectionFold
  model: SectionFold
  lineages: SectionFold
  showSpeed: boolean
  streamingNow: Accessor<{ phase: StreamingPhase; speed: number }>
  formatCost: (n: number) => string
  formatRate: (perMillion: number) => string
  cacheTTL?: CacheTTLConfig
  messages?: Accessor<AssistantMessage[]>
}) {
  const { m, layout } = props
  const [ttlNow, setTtlNow] = createSignal(Date.now())
  const ttlTimer = props.cacheTTL?.enabled ? setInterval(() => setTtlNow(Date.now()), 1000) : undefined
  onCleanup(() => {
    if (ttlTimer !== undefined) clearInterval(ttlTimer)
  })
  const streamingNowRow = createMemo(() => {
    const now = props.streamingNow()
    return formatStreamingNowDisplay(now.phase, now.speed, m.t().streamingIdle, m.useTps())
  })

  /** Show the recomputed cost (≈ prefix) when dynamic rules apply, else OpenCode's msg.cost. */
  const shownCost = createMemo(() => {
    const pricing = m.sessionPricing()
    if (pricing.counted > 0 && pricing.dynamic && pricing.unpriced === 0) {
      return { value: pricing.cost, approx: true }
    }
    return { value: m.blendedMain().cost, approx: false }
  })

  const rateLabel = createMemo(() => {
    const p = m.pricing()
    const badges: string[] = []
    if (p.level === "peak") badges.push(m.t().peakBadge)
    else if (p.level === "offpeak") badges.push(m.t().offpeakBadge)
    if (p.contextTier === "over") badges.push(m.t().over200kBadge)
    return badges.length > 0 ? `${m.t().rate} ${badges.join("·")}` : m.t().rate
  })
  return (
    <>
      <TuiHitRow
        label={m.hitLabel()}
        bar={m.bar()}
        pct={m.pctLabel()}
        barColor={m.hitColor()}
        textColor={m.pal().text}
        trend={
          m.trendLabel() ? { text: m.trendLabel(), color: m.trendFg() } : undefined
        }
      />
      <Show when={m.metricMessageStatus() !== "complete"}>
        <text fg={m.pal().muted}>{m.t().historyIncomplete}</text>
      </Show>
      <TuiMetricRow pal={m.pal()} layout={layout} label={m.t().totalHit} value={m.sessionPct()} />
      <Show when={props.cacheTTL?.enabled && props.cacheTTL?.providers}>
        <CacheTTLView
          messages={m.metricMessages}
          lineageKey={m.activeLineageKey}
          now={ttlNow}
          config={props.cacheTTL}
          pal={m.pal()}
          layout={layout}
          label={m.t().secTTL}
        />
      </Show>

      <TuiSection
        pal={m.pal()}
        layout={layout}
        open={props.detail.open()}
        title={m.t().secDetail}
        onToggle={props.detail.toggle}
      >
        <TokenDetailRows pal={m.pal()} layout={layout} t={m.t()} snap={m.main()}>
          <Show when={m.sessionPricing().readSavings !== 0}>
            <TuiMetricRow
              pal={m.pal()}
              layout={layout}
              label={m.t().readSavings}
              value={props.formatCost(m.sessionPricing().readSavings)}
              fg={m.pal().success}
            />
          </Show>
          <Show when={m.sessionPricing().writePremium !== 0}>
            <TuiMetricRow
              pal={m.pal()}
              layout={layout}
              label={m.t().writePremium}
              value={props.formatCost(m.sessionPricing().writePremium)}
              fg={m.pal().warning}
            />
          </Show>
          <Show when={m.sessionPricing().netCacheValue !== 0}>
            <TuiMetricRow
              pal={m.pal()}
              layout={layout}
              label={m.t().netCacheValue}
              value={props.formatCost(m.sessionPricing().netCacheValue)}
              fg={m.sessionPricing().netCacheValue > 0 ? m.pal().success : m.pal().error}
            />
          </Show>
        </TokenDetailRows>
      </TuiSection>

      <Show when={props.showSpeed}>
        <TuiSection
          pal={m.pal()}
          layout={layout}
          open={props.speed.open()}
          title={m.t().secSpeed}
          onToggle={props.speed.toggle}
        >
          <TuiMetricRow
            pal={m.pal()}
            layout={layout}
            label={m.t().now}
            value={streamingNowRow().value}
            fg={
              streamingNowRow().tone === "live"
                ? m.pal().success
                : m.pal().muted
            }
          />
          <TuiMetricRow
            pal={m.pal()}
            layout={layout}
            label={m.t().lastCall}
            value={m.lastSpeedLabel()}
          />
          <TuiMetricRow
            pal={m.pal()}
            layout={layout}
            label={m.t().avg}
            value={m.avgSpeedLabel()}
          />
          <Show when={m.sparkline()}>
            <TuiMetricRow
              pal={m.pal()}
              layout={layout}
              label={m.t().trend}
              value={m.sparkline()}
            />
          </Show>
          <TuiMetricRow
            pal={m.pal()}
            layout={layout}
            label={m.t().ttft}
            value={m.lastTtftLabel()}
            fg={m.lastTtft() !== undefined ? m.pal().text : m.pal().muted}
          />
        </TuiSection>
      </Show>

      <TuiSection
        pal={m.pal()}
        layout={layout}
        open={props.model.open()}
        title={m.t().secModel}
        onToggle={props.model.toggle}
      >
        <Show when={shownCost().value > 0}>
          <TuiMetricRow
            pal={m.pal()}
            layout={layout}
            label={m.t().cost}
            value={`${shownCost().approx ? m.t().approx : ""}${props.formatCost(shownCost().value)}`}
            fg={m.pal().text}
          />
        </Show>
        <Show when={m.modelShort()}>
          <TuiMetricRow pal={m.pal()} layout={layout} label={m.t().model} value={m.modelShort()} />
        </Show>
        <Show when={m.pricing().inputRate > 0}>
          <TuiMetricRow
            pal={m.pal()}
            layout={layout}
            label={rateLabel()}
            value={`${props.formatRate(m.pricing().inputRate)}${m.t().rateIn}`}
            fg={m.pal().muted}
          />
          <TuiMetricRow
            pal={m.pal()}
            layout={layout}
            label=""
            value={`${props.formatRate(m.pricing().cacheReadRate)}${m.t().rateCache}`}
            fg={m.pal().muted}
          />
          <TuiMetricRow
            pal={m.pal()}
            layout={layout}
            label=""
            value={`${props.formatRate(m.pricing().outputRate)}${m.t().rateOut}`}
            fg={m.pal().muted}
          />
        </Show>
      </TuiSection>

      <Show when={m.lineages().length > 1}>
        <TuiSection
          pal={m.pal()}
          layout={layout}
          open={props.lineages.open()}
          title={m.t().secLineages}
          onToggle={props.lineages.toggle}
        >
          {m.recentLineages().map((lineage) => {
            const model = lineage.modelID ? `${lineage.providerID}/${lineage.modelID.split("/").pop()}` : m.t().unknown
            const agents = Object.entries(lineage.agentCounts)
              .map(([agent, count]) => `${agent}:${count}`)
              .join(",")
            const label = truncateVisual(
              agents ? `${model} ${agents}` : model,
              Math.max(8, layout.gauge() - 10),
            )
            return (
              <>
                <TuiMetricRow
                  pal={m.pal()}
                  layout={layout}
                  label={label}
                  value={formatRatioAsPercent(lineage.cacheRatio)}
                  unit={`${lineage.callCount}c`}
                  labelFg={lineage.key === m.activeLineageKey() ? m.pal().text : m.pal().muted}
                />
                <Show when={props.cacheTTL?.enabled && props.cacheTTL?.providers}>
                  <CacheTTLView
                    messages={m.metricMessages}
                    lineageKey={() => lineage.key}
                    now={ttlNow}
                    config={props.cacheTTL}
                    pal={m.pal()}
                    layout={layout}
                    label={`${m.t().secTTL} ${truncateVisual(model, Math.max(8, layout.gauge() - 8))}`}
                  />
                </Show>
              </>
            )
          })}
        </TuiSection>
      </Show>
    </>
  )
}
