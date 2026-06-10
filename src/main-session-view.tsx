/** @jsxImportSource @opentui/solid */
import { Show } from "solid-js"
import { TokenDetailRows } from "./cache-hit-rows.tsx"
import { CacheTTLView } from "./cache-ttl-view.tsx"
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
  model: SectionFold
  formatCost: (n: number) => string
  formatRate: (perMillion: number) => string
  cacheTTL?: CacheTTLConfig
  messages?: Accessor<AssistantMessage[]>
}) {
  const { m, layout } = props
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
      <Show when={props.cacheTTL?.enabled && props.messages}>
        <CacheTTLView
          messages={props.messages!}
          config={props.cacheTTL!}
          pal={m.pal()}
          layout={layout}
          label={m.t().secTTL}
        />
      </Show>

      <Show when={m.ctx() && m.ctxBar()}>
        {() => {
          const c = m.ctx()!
          const pct = c.percent!
          const fg = pct < 60 ? m.pal().success : pct < 80 ? m.pal().warning : m.pal().error
          return (
            <>
              <text>
                <span style={{ fg: m.pal().text }}>{m.t().ctx} </span>
                <span style={{ fg }}>[{m.ctxBar()}] </span>
                <span style={{ fg: m.pal().text }}>{pct}%</span>
              <span style={{ fg: m.pal().textMuted }}>{m.ctxTrend() ? ` ${m.ctxTrend()}` : ""}</span>
              </text>
              <TuiMetricRow
                pal={m.pal()}
                layout={layout}
                label=""
                value={`${c.tokens.toLocaleString()} / ${c.limit.toLocaleString()}`}
              />
            </>
          )
        }}
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

      <TuiSection
        pal={m.pal()}
        layout={layout}
        open={props.model.open()}
        title={m.t().secModel}
        onToggle={props.model.toggle}
      >
        <Show when={m.main().cost > 0}>
          <TuiMetricRow
            pal={m.pal()}
            layout={layout}
            label={m.t().cost}
            value={props.formatCost(m.main().cost)}
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
            label={m.t().rate}
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
