/**
 * OpenCode 2 server-side entry (`exports["."]`).
 *
 * The sidebar is TUI-only, but V2 requires a loadable server entrypoint before
 * it reports `features.tui`, and the CLI only activates TUI plugins the server
 * knows about. So this exists to make the package loadable from `opencode.json`
 * `plugins` — the same config key V1 users already have. Without it the package
 * fails with "Plugin entrypoint not found" on V2 and the sidebar never mounts.
 *
 * Deliberately a no-op: the real work is in `exports["./tui"]`.
 * V1 never resolves this file (it reads `./server` or `main`, and neither exists).
 */
export default {
  id: "opencode-cache-hit",
  setup() {},
}
