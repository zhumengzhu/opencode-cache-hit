/** @jsxImportSource @opentui/solid */
import { CacheHitSidebarHost } from "./sidebar-host.tsx"
import type { TuiApi } from "./types.ts"
import { createV2Api } from "./v2/adapter.ts"
import { toThemeRecord } from "./v2/map.ts"
import { PLUGIN_ID } from "./v2/server.ts"
import type { V2Context } from "./v2/types.ts"
import { toTuiApi, type V1TuiApi } from "./v1-map.ts"

export { PLUGIN_ID }

/** Shared by both entrypoints: same host component, same source of config (the host). */
function sidebar(api: TuiApi, sessionId: string, theme: Record<string, unknown>) {
  return <CacheHitSidebarHost sessionId={sessionId} theme={theme} api={api} />
}

/** OpenCode 1: TUI slot API. This path maps legacy events onto `TuiEvent`. */
export const tui = async (api: V1TuiApi) => {
  const tuiApi = toTuiApi(api)
  api.slots.register({
    order: 56,
    slots: {
      sidebar_content(ctx, props) {
        return sidebar(tuiApi, props.session_id ?? "", ctx.theme.current)
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
