/** @jsxImportSource @opentui/solid */
import { CacheHitSidebarHost } from "./sidebar-host.tsx"
import { loadPluginConfig } from "./load-config.ts"
import { createCostFormatter, createRateFormatter } from "./format-cost.ts"
import type { OpenCodeTuiApi, V1TuiApi } from "./types.ts"
import { createV2Api } from "./v2/adapter.ts"
import { toThemeRecord } from "./v2/map.ts"
import type { V2Context } from "./v2/types.ts"

export const PLUGIN_ID = "opencode-cache-hit"

/** Shared by both entrypoints: same host component, same config, same formatters. */
function sidebar(api: OpenCodeTuiApi, sessionId: string, theme: Record<string, unknown>) {
  const pluginConfig = loadPluginConfig()
  return (
    <CacheHitSidebarHost
      sessionId={sessionId}
      theme={theme}
      display={pluginConfig.display}
      timeline={pluginConfig.timeline}
      cacheTTL={pluginConfig.cacheTTL}
      dynamicPricing={pluginConfig.dynamicPricing}
      formatCost={createCostFormatter(pluginConfig.cost)}
      formatRate={createRateFormatter(pluginConfig.cost)}
      api={api}
    />
  )
}

/** OpenCode 1: TUI slot API. */
export const tui = async (api: V1TuiApi) => {
  api.slots.register({
    order: 56,
    slots: {
      sidebar_content(ctx, props) {
        return sidebar(api, props.session_id ?? "", ctx.theme.current)
      },
    },
  })
}

/**
 * OpenCode 2: `Plugin.define({ id, setup })`. Plain object (no
 * `@opencode/plugin` import) — V2 substitutes that specifier, V1 does not, so a
 * runtime import of it would break V1 loading.
 */
export const setup = (ctx: V2Context) => {
  const api = createV2Api(ctx)
  const unregister = ctx.ui.slot({
    append: "sidebar.content",
    render: ({ sessionID }) => sidebar(api, sessionID ?? "", toThemeRecord(ctx.theme)),
  })
  return () => {
    unregister?.()
    api.dispose()
  }
}

const plugin = { id: PLUGIN_ID, tui, setup }
export default plugin
