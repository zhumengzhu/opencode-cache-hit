/** @jsxImportSource @opentui/solid */
import { createMemo, createSignal, Show, type Accessor } from "solid-js"
import type { DisplayConfig, CacheTTLConfig, DynamicPricingConfig } from "./plugin-config.ts"
import type { AssistantMessage, ProviderInfo, SessionSnapshot, SubAgentSummary } from "./types.ts"
import type { SessionMessageLoadStatus } from "./session-messages.ts"
import type { StreamingPhase } from "./streaming-state.ts"
import { PLUGIN_VERSION } from "./version.ts"
import { AgentsView } from "./agents-view.tsx"
import { MainSessionView } from "./main-session-view.tsx"

import { useCacheHitMetrics } from "./use-cache-hit-metrics.ts"
import { formatTokenSpeed, formatTokenTpot } from "./token-speed.ts"
import {
  createPanelLayout,
  createSectionFold,
  TuiPanel,
  TuiPanelNoData,
  TuiPanelSep,
  TuiPanelTitle,
  TuiSection,
  TuiTitleSummaryPad,
  visualWidth,
} from "./tui-panel/index.ts"

export function CacheHitSidebar(props: {
  sessionId: Accessor<string>
  theme: Record<string, unknown>
  display: DisplayConfig
  cacheTTL: CacheTTLConfig
  dynamicPricing: DynamicPricingConfig
  messages: Accessor<AssistantMessage[]>
  metricMessages?: Accessor<AssistantMessage[]>
  metricMessageStatus?: Accessor<SessionMessageLoadStatus>
  main: Accessor<SessionSnapshot>
  subAgents: Accessor<SubAgentSummary[]>
  providers: Accessor<ReadonlyArray<ProviderInfo>>
  formatCost: (amount: number) => string
  formatRate: (perMillion: number) => string
  streamingNow: Accessor<{ phase: StreamingPhase; speed: number }>
  firstPartTime: Accessor<ReadonlyMap<string, number>>
}) {
  const [panelOpen, setPanelOpen] = createSignal(true)
  const detail = createSectionFold(true)
  const speed = createSectionFold(true)
  const model = createSectionFold(true)
  const lineages = createSectionFold(true)
  const agents = createSectionFold(true)

  const borderOn = () => props.display.panelBorder
  const layout = createPanelLayout({ border: borderOn })

  const m = useCacheHitMetrics({
    theme: () => props.theme,
    display: props.display,
    messages: props.messages,
    metricMessages: props.metricMessages ?? props.messages,
    metricMessageStatus: props.metricMessageStatus,
    main: props.main,
    subAgents: props.subAgents,
    providers: props.providers,
    dynamicPricing: props.dynamicPricing,
    layout,
    firstPartTime: props.firstPartTime,
  })

  const formatSpeed = createMemo(() =>
    props.display.speedUnit === "tps"
      ? (v: number | undefined) => formatTokenSpeed(v ?? 0)
      : (v: number | undefined) => formatTokenTpot(v),
  )

  const agentsSuffix = createMemo(() => {
    const n = m.subs().length
    if (n === 0) return ""
    return ` (${n})${m.t().agentsScopeHint}`
  })

  return (
    <Show when={props.sessionId().length > 0}>
      <TuiPanel pal={m.pal()} border={borderOn()} layout={layout}>
        <TuiPanelTitle
          pal={m.pal()}
          layout={layout}
          open={panelOpen()}
          onToggle={() => setPanelOpen((o) => !o)}
          title={m.t().title}
          version={PLUGIN_VERSION}
          collapsed={
            <>
              <Show when={m.hasData() && m.mainHasStats()}>
                <TuiTitleSummaryPad
                  layout={layout}
                  titleWidth={visualWidth(m.t().title)}
                  summaryWidth={m.collapsedHitSummary().width}
                >
                  <span style={{ fg: m.hitColor() }}>{m.collapsedHitSummary().text}</span>
                </TuiTitleSummaryPad>
              </Show>
              <Show when={m.hasData() && !m.mainHasStats() && m.subs().length > 0}>
                <TuiTitleSummaryPad
                  layout={layout}
                  titleWidth={visualWidth(m.t().title)}
                  summaryWidth={visualWidth(props.formatCost(m.totalSubCost()))}
                >
                  <span style={{ fg: m.pal().success }}>{props.formatCost(m.totalSubCost())}</span>
                </TuiTitleSummaryPad>
              </Show>
            </>
          }
        />

        <Show when={panelOpen()}>
          <Show
            when={m.hasData()}
            fallback={<TuiPanelNoData pal={m.pal()} layout={layout} message={m.t().noData} />}
          >
            <TuiPanelSep pal={m.pal()} layout={layout} />
            <MainSessionView
              m={m}
              layout={layout}
              detail={detail}
              speed={speed}
              model={model}
              lineages={lineages}
              showSpeed={props.display.showSpeed}
              streamingNow={props.streamingNow}
              formatCost={props.formatCost}
              formatRate={props.formatRate}
              cacheTTL={props.cacheTTL}
              messages={props.messages}
            />
            <Show when={m.subs().length > 0}>
              <TuiSection
                pal={m.pal()}
                layout={layout}
                open={agents.open()}
                title={m.t().secAgents}
                suffix={agentsSuffix()}
                onToggle={agents.toggle}
              >
                <AgentsView m={m} layout={layout} formatCost={props.formatCost} formatSpeed={formatSpeed()} />
              </TuiSection>
            </Show>
          </Show>
        </Show>
      </TuiPanel>
    </Show>
  )
}
