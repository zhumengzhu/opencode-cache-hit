/** @jsxImportSource @opentui/solid */
import { Show, createMemo } from "solid-js"
import { TokenDetailRows } from "./cache-hit-rows.tsx"
import { CacheTTLView } from "./cache-ttl-view.tsx"
import { formatStreamingNowDisplay, type StreamingPhase } from "./streaming-state.ts"
import type { CacheHitMetrics } from "./use-cache-hit-metrics.ts"
import type { CacheTTLConfig } from "./plugin-config.ts"
import type { AssistantMessage } from "./types.ts"
import {
  TuiHitRow,
  TuiMetricRow,
  TuiSection,
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
  showSpeed: boolean
  streamingNow: Accessor<{ phase: StreamingPhase; speed: number }>
  formatCost: (n: number) => string
  formatRate: (perMillion: number) => string
  cacheTTL?: CacheTTLConfig
  messages?: Accessor<AssistantMessage[]>
}) {
  const { m, layout } = props
  const streamingNowRow = createMemo(() => {
    const now = props.streamingNow()
    return formatStreamingNowDisplay(now.phase, now.speed, m.t().streamingIdle, m.useTps())
  })

  /** Show the recomputed cost (≈ prefix) when dynamic rules apply, else OpenCode's msg.cost. */
  const shownCost = createMemo(() => {
    const rec = m.recomputedCost()
    if (rec && rec.dynamic) return { value: rec.cost, approx: true }
    return { value: m.main().cost, approx: false }
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
          m.perCall().hasTrend ? { text: m.trendLabel(), color: m.trendFg() } : undefined
        }
      />
      <TuiMetricRow pal={m.pal()} layout={layout} label={m.t().totalHit} value={m.sessionPct()} />
      <Show when={props.cacheTTL?.enabled && props.cacheTTL?.providers && props.messages}>
        <CacheTTLView
          messages={props.messages}
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
          <Show when={m.pricing().saved > 0}>
            <TuiMetricRow
              pal={m.pal()}
              layout={layout}
              label={m.t().saved}
              value={props.formatCost(m.pricing().saved)}
              fg={m.pal().success}
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
    </>
  )
}
