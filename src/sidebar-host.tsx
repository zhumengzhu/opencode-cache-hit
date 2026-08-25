/** @jsxImportSource @opentui/solid */
import { createSignal, createMemo, createEffect, onCleanup, untrack } from "solid-js"
import { CacheHitSidebar } from "./widget.tsx"
import type { DisplayConfig, TimelineConfig, CacheTTLConfig, DynamicPricingConfig } from "./plugin-config.ts"
import { isToolSummaryEnabled } from "./plugin-config.ts"
import { createTimelineCollector } from "./timeline/collector.ts"
import {
  createFirstPartTimeTracker,
  earliestPartStart,
  STREAM_PART_TYPES,
} from "./first-part-time.ts"
import { createToolTimingTracker, type ToolPartEventData } from "./tool-timing.ts"
import { createItlTracker } from "./itl-tracker.ts"
import { isPartUpdatedEvent } from "./types.ts"
import type {
  AssistantMessage,
  OpenCodeTuiApi,
  SubAgentSummary,
} from "./types.ts"
import { loadSessionMessages, type SessionMessageLoadStatus } from "./session-messages.ts"
import {
  emptySessionSnapshot,
  aggregateFromSessionObject,
  aggregateSessionFromMessages,
  mainSessionHasStats,
  subAgentHasStats,
  toSubAgentSummary,
  withModelFallback,
} from "./stats.ts"
import { createChildSessionSync } from "./child-session-sync.ts"
import type { SessionListEntry } from "./session-list.ts"
import { loadPluginConfig } from "./load-config.ts"
import { computeAvgTokenTpotMs, computeAvgTokenSpeed } from "./token-speed.ts"
import {
  advanceStreamingNow,
  initialStreamingTickState,
  type StreamingPhase,
} from "./streaming-state.ts"

/**
 * Session-scoped sidebar host. Bumps `refreshTick` on message.updated
 * so memos re-compute.
 *
 * Where available, session.get() provides DB-level aggregate cost/tokens
 * (not capped at 100 messages). This method was added in opencode#26644
 * (2026-05-12) — forks that split earlier (e.g. MiMo-Code) lack it.
 * When absent, the code falls back to session.messages(), which is limited
 * to the most recent 100 messages per call.
 *
 * Timeline writes are event-driven: message.updated → handleMessage → appendFile.
 */
export function CacheHitSidebarHost(props: {
  sessionId: string
  theme: Record<string, unknown>
  display: DisplayConfig
  timeline: TimelineConfig
  cacheTTL: CacheTTLConfig
  dynamicPricing: DynamicPricingConfig
  formatCost: (amount: number) => string
  formatRate: (perMillion: number) => string
  api: OpenCodeTuiApi
}) {
  const [refreshTick, setRefreshTick] = createSignal(0)
  const [childIds, setChildIds] = createSignal<string[]>([])
  const [childEntries, setChildEntries] = createSignal<SessionListEntry[]>([])
  const [historyMessages, setHistoryMessages] = createSignal<AssistantMessage[]>([])
  const [historyStatus, setHistoryStatus] = createSignal<SessionMessageLoadStatus>("complete")
  const pendingHistoryUpdates = new Map<string, AssistantMessage>()
  let historyLoadGeneration = 0

  /** Re-read cache-hit.config.json when parent session changes (picks up edits without full plugin reload). */
  const runtimeConfig = createMemo(() => {
    void props.sessionId
    return loadPluginConfig()
  })
  const display = createMemo(() => runtimeConfig().display)
  const cacheTTL = createMemo(() => runtimeConfig().cacheTTL)
  const dynamicPricing = createMemo(() => runtimeConfig().dynamicPricing)
  const timelineConfig = createMemo(() => runtimeConfig().timeline)

  const bumpRefresh = () => setRefreshTick((v) => v + 1)

  const firstPartTracker = createFirstPartTimeTracker()
  onCleanup(() => firstPartTracker.dispose())

  const toolTiming = createToolTimingTracker({
    isSummaryEnabled: (tool) => isToolSummaryEnabled(timelineConfig().toolSummary, tool),
  })
  onCleanup(() => toolTiming.dispose())

  const itlTracker = createItlTracker()

  const timeline = createTimelineCollector({
    getConfig: () => timelineConfig(),
    getRootSessionId: () => props.sessionId,
    getChildIds: childIds,
    firstPartTime: firstPartTracker,
    toolTiming,
    itlTracker,
  })
  onCleanup(() => timeline.dispose())

  const childSync = createChildSessionSync({
    client: props.api.client.session,
    getDirectory: () => props.api.state.path.directory,
    getParentId: () => props.sessionId,
    setChildIds,
    setChildEntries,
    onSynced: () => {
      bumpRefresh()
    },
  })
  onCleanup(() => childSync.dispose())

  const mainSnap = createMemo(() => {
    void refreshTick()
    const sid = props.sessionId
    if (!sid) return emptySessionSnapshot()
    // session.get() (opencode#26644, 2026-05-12) may be absent on forks like MiMo-Code.
    const session = props.api.state.session.get?.(sid)
    if (session) {
      const snap = aggregateFromSessionObject(session)
      if (mainSessionHasStats(snap)) {
        const msgs = props.api.state.session.messages(sid) as AssistantMessage[] | undefined
        return msgs ? withModelFallback(snap, msgs) : snap
      }
    }
    const msgs = props.api.state.session.messages(sid)
    return msgs?.length
      ? aggregateSessionFromMessages(msgs as AssistantMessage[])
      : emptySessionSnapshot()
  })

  const mainMessages = createMemo(() => {
    void refreshTick()
    const sid = props.sessionId
    if (!sid) return [] as AssistantMessage[]
    return (props.api.state.session.messages(sid) ?? []) as AssistantMessage[]
  })

  const mergeHistoryMessage = (messages: readonly AssistantMessage[], update: AssistantMessage) => {
    const id = update.id ?? update.messageID
    const next = [...messages]
    const index = id ? next.findIndex((message) => (message.id ?? message.messageID) === id) : -1
    if (index >= 0) next[index] = update
    else next.push(update)
    next.sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0))
    return next
  }

  const loadHistory = (sid: string) => {
    const generation = ++historyLoadGeneration
    pendingHistoryUpdates.clear()
    const mirror = untrack(mainMessages)
    setHistoryMessages(mirror)
    // Reset to "complete" so a session switch does not carry over the previous
    // session's "capped"/"unavailable" status (which would flash the hint until
    // the new load settles). The real status is set when the request completes.
    setHistoryStatus("complete")
    if (!sid) return
    void loadSessionMessages({
      client: props.api.client.session,
      sessionId: sid,
      directory: props.api.state.path.directory,
      fallback: mirror,
    }).then((result) => {
      if (generation !== historyLoadGeneration) return
      let merged = result.messages
      for (const update of pendingHistoryUpdates.values()) {
        merged = mergeHistoryMessage(merged, update)
      }
      setHistoryMessages(merged)
      setHistoryStatus(result.status)
    })
  }

  const subAgentList = createMemo(() => {
    void refreshTick()
    const useTps = display().speedUnit === "tps"
    const createdById = new Map(childEntries().map((e) => [e.id, e.created]))
    return childIds()
      .map((cid) => {
        const created = createdById.get(cid)
        const session = props.api.state.session.get?.(cid)
        if (session) {
          const snap = aggregateFromSessionObject(session)
          if (subAgentHasStats(snap)) {
            const msgs = props.api.state.session.messages(cid) as AssistantMessage[] | undefined
            const merged = msgs ? withModelFallback(snap, msgs) : snap
            const speed = msgs
              ? (useTps ? computeAvgTokenSpeed(msgs) || undefined : computeAvgTokenTpotMs(msgs))
              : undefined
            return toSubAgentSummary(cid, merged, speed, created)
          }
        }
        const msgs = props.api.state.session.messages(cid)
        if (!msgs?.length) return null
        const snap = aggregateSessionFromMessages(msgs as AssistantMessage[])
        if (!subAgentHasStats(snap)) return null
        const speed = useTps
          ? computeAvgTokenSpeed(msgs as AssistantMessage[]) || undefined
          : computeAvgTokenTpotMs(msgs as AssistantMessage[])
        return toSubAgentSummary(cid, snap, speed, created)
      })
      .filter(Boolean) as SubAgentSummary[]
  })

  const [streamingNow, setStreamingNow] = createSignal<{ phase: StreamingPhase; speed: number }>({
    phase: "idle",
    speed: 0,
  })
  let streamingTickState = initialStreamingTickState()

  // firstPartTracker.get() returns the same Map instance (mutated in-place).
  // void refreshTick() forces SolidJS to re-evaluate dependents on each refresh
  // cycle, since reference equality alone would never trigger a re-run.
  const firstPartTime = createMemo(() => {
    void refreshTick()
    return firstPartTracker.get()
  })

  const recordPart = (
    messageID: string,
    partType: string,
    startTime: number,
    source: "sdk" | "tui",
  ): boolean => {
    const first = firstPartTracker.handlePart(messageID, partType, startTime, source)
    if (first) bumpRefresh()
    return first
  }

  const seedTtftFromParts = (msg: AssistantMessage) => {
    const msgID = msg.id ?? msg.messageID
    const created = msg.time?.created
    if (!msgID || typeof created !== "number" || firstPartTracker.get().has(msgID)) return
    if (!props.api.state.part) return
    const start = earliestPartStart(props.api.state.part(msgID), created)
    if (start !== undefined) {
      recordPart(msgID, "text", start, "sdk")
    }
  }

  const trackStreaming = () => {
    const messages = mainMessages()
    const last = messages[messages.length - 1]
    if (last?.role === "assistant" && !last.time?.completed) {
      seedTtftFromParts(last)
    }
    const result = advanceStreamingNow(streamingTickState, {
      messages,
      part: props.api.state.part,
      now: Date.now(),
      firstPartTime: firstPartTracker.get(),
    })
    streamingTickState = result
    setStreamingNow({ phase: result.phase, speed: result.speed })
  }

  createEffect(() => {
    // Adaptive polling: idle=3s, active=1s. trackStreaming() calls setStreamingNow(),
    // which triggers this effect to re-read the new phase and adjust the next interval.
    const ms = streamingNow().phase === "idle" ? 3000 : 1000
    const timer = setTimeout(trackStreaming, ms)
    onCleanup(() => clearTimeout(timer))
  })

  createEffect(() => {
    const sid = props.sessionId
    void props.api.state.path.directory
    childSync.resetForParentChange()
    timeline.resetForRootChange()
    firstPartTracker.reset()
    toolTiming.reset()
    itlTracker.reset()
    streamingTickState = initialStreamingTickState()
    setStreamingNow({ phase: "idle", speed: 0 })
    loadHistory(sid)
    if (sid) {
      childSync.loadChildren()
    }
  })

  createEffect(() => {
    const unsub = props.api.event.on("message.updated", (event) => {
      bumpRefresh()
      const msg = event.properties?.info as (AssistantMessage & { sessionID?: string }) | undefined
      const sid = msg?.sessionID
      childSync.onForeignSessionActivity(sid)
      if (msg?.role === "assistant") {
        seedTtftFromParts(msg)
      }
      if (sid && msg) {
        if (sid === props.sessionId && msg.role === "assistant") {
          pendingHistoryUpdates.set(msg.id ?? msg.messageID ?? String(msg.time?.created ?? Date.now()), msg)
          setHistoryMessages((messages) => mergeHistoryMessage(messages, msg))
        }
        timeline.handleMessage(sid, msg)
      }
    })
    onCleanup(() => unsub?.())
  })

  createEffect(() => {
    const unsub1 = props.api.event.on("message.part.updated", (event) => {
      if (!isPartUpdatedEvent(event)) return
      const { part } = event.properties
      if (STREAM_PART_TYPES.has(part.type) && typeof part.time?.start === "number") {
        const recorded = recordPart(part.messageID, part.type, part.time.start, "sdk")
        if (recorded) trackStreaming()
      }
      // When a tool part transitions to "pending" the model has decided to call a tool.
      // Capture the wall-clock time so pure-tool-calls responses (no text/reasoning
      // streaming parts) still have a TTFT value.  SDK timestamps on text/reasoning
      // parts take priority via the tracker's existing upgrade logic.
      // Only fire if the tool part has no SDK time.start (avoid redundant call when
      // the part already carried a valid timestamp and was handled by the branch above).
      if (part.type === "tool" && !part.time?.start && part.state?.status === "pending") {
        const recorded = recordPart(part.messageID, "tool", Date.now(), "tui")
        if (recorded) trackStreaming()
      }
      if (part.type === "tool") {
        toolTiming.handleToolPart(part.messageID, part as ToolPartEventData)
      }
    })
    const unsub2 = props.api.event.on("message.part.delta", (event) => {
      const props_ = event.properties
      const messageID = props_?.messageID
      const field = props_?.field
      // `Date.now()` is the event-handler arrival time, not the true network-first-byte time.
      // It may lag by tens to hundreds of ms under UI thread pressure; used only as a
      // fallback when SDK-side part.time.start is unavailable (message.part.updated).
      if (typeof messageID === "string" && typeof field === "string" && STREAM_PART_TYPES.has(field)) {
        const recorded = recordPart(messageID, field, Date.now(), "tui")
        itlTracker.trackChunk(messageID)
        if (recorded) trackStreaming()
      }
    })
    onCleanup(() => {
      unsub1?.()
      unsub2?.()
    })
  })

  return (
    <CacheHitSidebar
      sessionId={() => props.sessionId}
      theme={props.theme}
      display={display()}
      cacheTTL={cacheTTL()}
      dynamicPricing={dynamicPricing()}
      messages={mainMessages}
      metricMessages={() => historyMessages()}
      metricMessageStatus={() => historyStatus()}
      main={mainSnap}
      subAgents={subAgentList}
      providers={() => props.api.state.provider ?? []}
      formatCost={props.formatCost}
      formatRate={props.formatRate}
      streamingNow={streamingNow}
      firstPartTime={firstPartTime}
    />
  )
}
