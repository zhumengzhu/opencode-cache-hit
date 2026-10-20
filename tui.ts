/**
 * V2 TUI entry discovered from the package root.
 *
 * V2 resolves local directory plugins as `<dir>/tui` (`Host.resolve`); without
 * this shim the CLI reports the plugin as unsupported and never mounts the
 * sidebar. Re-exporting the pre-transformed bundle keeps `solid-js` and
 * `@opentui/solid` external so the host and the plugin share one runtime (see
 * docs/adr/0001-prebundled-tui-entry.md).
 *
 * `dist/tui.js` is gitignored: run `bun run build` (or the `prepare` script)
 * before loading a plain checkout.
 */
export { default } from "./dist/tui.js"
