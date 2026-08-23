/**
 * Cache TTL elapsed time display.
 * Inspired by opencode-cache-timer (https://github.com/nero-sensei/opencode-cache-timer)
 * by nero-sensei.
 */
/** @jsxImportSource @opentui/solid */
import { createMemo, createSignal, onCleanup, Show, type Accessor } from "solid-js"
import type { AssistantMessage } from "./types.ts"
import { type CacheTTLConfig, DEFAULT_CACHE_TTL } from "./plugin-config.ts"
import { findLastCacheActivityByLineage, getTTL, formatElapsed, DEFAULT_TTL_MS } from "./cache-ttl.ts"
import type { PanelPalette, PanelLayout } from "./tui-panel/index.ts"

export function CacheTTLView(props: {
  messages?: Accessor<AssistantMessage[]>
  lineageKey?: Accessor<string | undefined>
  now?: Accessor<number>
  config?: CacheTTLConfig
  pal: PanelPalette
  layout: PanelLayout
  label: string
}) {
  const [localNow, setLocalNow] = createSignal(Date.now())
  const tick = props.now ? undefined : setInterval(() => setLocalNow(Date.now()), 1000)
  onCleanup(() => {
    if (tick !== undefined) clearInterval(tick)
  })

  const now = () => props.now?.() ?? localNow()
  const activities = createMemo(() => findLastCacheActivityByLineage(props.messages?.() ?? []))
  const lastCache = createMemo(() => {
    const key = props.lineageKey?.()
    if (key) return activities().get(key) ?? null
    let latest: AssistantMessage | null = null
    for (const message of activities().values()) {
      if (!latest || (message.time?.completed ?? 0) > (latest.time?.completed ?? 0)) latest = message
    }
    return latest
  })

  // Self-heal against partial/undefined config reaching this component (see #1, #3):
  // a stale-cached plugin build may pass { enabled: true } without `providers`.
  const safeConfig = createMemo(() =>
    props.config?.providers ? props.config : DEFAULT_CACHE_TTL,
  )

  const ttlMs = createMemo(() => {
    const m = lastCache()
    if (!m || !m.providerID) return DEFAULT_TTL_MS
    return getTTL(m.providerID, m.modelID ?? "", safeConfig())
  })

  const elapsed = createMemo(() => {
    const m = lastCache()
    if (!m || m.time.completed === undefined) return null
    return now() - m.time.completed
  })

  const statusIcon = createMemo(() => {
    const e = elapsed()
    const ttl = ttlMs()
    if (e === null) return ""
    if (e < ttl) return "●"
    if (e < ttl * 2) return "◐"
    return "○"
  })

  const statusColor = createMemo(() => {
    const e = elapsed()
    const ttl = ttlMs()
    if (e === null) return props.pal.textMuted
    if (e < ttl) return props.pal.success
    if (e < ttl * 2) return props.pal.warning
    return props.pal.error
  })

  return (
    <Show when={elapsed() !== null}>
      <text fg={statusColor()}>
        {props.layout.row(props.label, `${statusIcon()} ${formatElapsed(elapsed() ?? 0)}`, "")}
      </text>
    </Show>
  )
}
