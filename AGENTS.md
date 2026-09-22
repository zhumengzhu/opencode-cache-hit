# AGENTS.md — maintainer & AI assistant guide

Instructions for humans and coding agents working in **opencode-cache-hit**. End-user docs: [README.md](README.md) · [README.zh-CN.md](README.zh-CN.md).

## Project purpose

OpenCode TUI sidebar plugin: **cache hit rate**, **tokens**, **cost**, with **sub-agent (child session)** rollup. Optional per-call **JSONL timeline** (`timeline.enabled`).

**Not** a fork of [opencode-visual-cache](https://github.com/Hotakus/opencode-visual-cache). UI patterns and `src/tui-panel/` are **heavily inspired by** visual-cache; product focus differs (see README comparison table).

## Documentation map

| Topic | English | 中文 |
|-------|---------|------|
| Users | [README.md](README.md) | [README.zh-CN.md](README.zh-CN.md) |
| Architecture | [docs/en/design.md](docs/en/design.md) | [docs/zh-CN/design.md](docs/zh-CN/design.md) |
| Timeline / JSONL | [docs/en/timeline.md](docs/en/timeline.md) | [docs/zh-CN/timeline.md](docs/zh-CN/timeline.md) |
| Token Speed | [docs/en/token-speed.md](docs/en/token-speed.md) | [docs/zh-CN/token-speed.md](docs/zh-CN/token-speed.md) |
| TTFT Hybrid | [docs/en/ttft-hybrid.md](docs/en/ttft-hybrid.md) | [docs/zh-CN/ttft-hybrid.md](docs/zh-CN/ttft-hybrid.md) |
| TTFT Troubleshooting | [docs/en/ttft-troubleshooting.md](docs/en/ttft-troubleshooting.md) | [docs/zh-CN/ttft-troubleshooting.md](docs/zh-CN/ttft-troubleshooting.md) |
| Dynamic pricing (plan) | — | [docs/zh-CN/dynamic-pricing-plan.md](docs/zh-CN/dynamic-pricing-plan.md) |
| TUI panel | [src/tui-panel/README.md](src/tui-panel/README.md) | [src/tui-panel/README.zh-CN.md](src/tui-panel/README.zh-CN.md) |
| Migration plan | [docs/en/frontend-migration-plan.md](docs/en/frontend-migration-plan.md) | [docs/zh-CN/frontend-migration-plan.md](docs/zh-CN/frontend-migration-plan.md) |
| Contributing / npm | [CONTRIBUTING.md](CONTRIBUTING.md) | — |
| Index | [docs/README.md](docs/README.md) | |

## Commands

```bash
bun test          # full unit + module-load smoke
bun run check     # same as test
bun run build     # emit dist/tui.js (the published ./tui entry)
```

After moving or renaming exports: run full `bun test`; `tests/module-load.test.ts` imports the real consumer graph.

## Code conventions

- **Minimal diffs**; match existing naming and module boundaries.
- **Pure logic** in `stats.ts`, `first-part-time.ts`, `timeline/`, `format-*.ts`, `format-model.ts`, `tui-panel/layout.ts` — avoid pulling JSX into modules used by tests (import `layout.ts` / `palette.ts` directly, not `tui-panel/index.ts` when possible).
- **Sub-agent row UI**: `format-model.ts` + `agents-view.tsx`; behavior in design doc § Sub-agent row display / 子 session 行展示.
- **`PLUGIN_ROOT`** in `load-config.ts` is `fileURLToPath(new URL("..", import.meta.url))` — do **not** wrap with an extra `dirname` (breaks config path).
- **Sub-agent ids**: only from `session.list` overwrite in `child-session-sync.ts`; do not append via `session.get`.
- **Agents UI totals**: child sessions only; main session excluded by design (see design doc).
- **Eager-safe JSX**: the published `./tui` entry is a pre-transformed bundle ([docs/adr/0001](docs/adr/0001-prebundled-tui-entry.md)), but `bun test` and the `"."` / `"./tui-panel"` exports still load raw TSX, which bun compiles with generic JSX: `<Show>`/`<For>` children are evaluated eagerly, so accessing a guard variable's property inside children can throw on `undefined` before `when`/`each` runs. Never `!`-assert a guard variable in control-flow children; use `?.`/`??`, bind a local accessor, or accept `| undefined` in child props. Guard against `tests/eager-safe-jsx.test.ts`.
- Comments only for non-obvious behavior.

## Configuration

- Example: [cache-hit.config.example.json](cache-hit.config.example.json) — **included in npm** `files`.
- Runtime: `~/.config/opencode/cache-hit.json` (preferred) or `cache-hit.config.json` beside package root (legacy fallback); **not** published; gitignored.
- Defaults: [src/plugin-config.ts](src/plugin-config.ts).
- Dynamic pricing (`dynamicPricing`): time-of-day tiers + context tier (runtime `tiers`/`experimentalOver200K` normalized); see README § Dynamic pricing and [docs/zh-CN/dynamic-pricing-plan.md](docs/zh-CN/dynamic-pricing-plan.md). `levels` absolute prices default to USD/1M; non-USD prices convert via `cost.rate` (when the level currency matches the display currency) or the per-rule `"rate"` (USD → level currency).
- Timeline log dir default: `~/.local/share/opencode/logs/cache-hit/`. Supports `~/` expansion in `timeline.dir`.

## npm publish

- Tarball = `package.json` `"files"` only (bundled TUI entry, source TSX, example config, docs — no `tests/`, `logs/`, user config).
- `exports["./tui"]` → `./dist/tui.js`, emitted by `bun run build` ([scripts/build-tui.ts](scripts/build-tui.ts)); `prepack` rebuilds it. `dist/` is gitignored but published — never commit it, and rebuild before testing the local file plugin.
- Keep `packages: "external"` in the build: opencode supplies one reactive runtime. Inlining `solid-js` / `@opentui/solid` breaks folding silently ([docs/adr/0001](docs/adr/0001-prebundled-tui-entry.md)).
- Run `bun test` before `npm publish`; see [CONTRIBUTING.md](CONTRIBUTING.md).

## OpenCode integration

- Entry: [index.tsx](index.tsx) → [src/plugin.tsx](src/plugin.tsx), built to `dist/tui.js` for `exports["./tui"]`.
- Dual entrypoint: that module default-exports `{ id, tui, setup }`. V1's TUI loader takes `tui(api)`, V2's CLI loader takes `setup(ctx)`. Never add `server` (V1 rejects `server`+`tui` together) and never runtime-import `@opencode/plugin` — V1 does not substitute that specifier, so the bundle must stay free of it.
- V2 adapter: [src/v2/adapter.ts](src/v2/adapter.ts) maps the V2 context onto `OpenCodeTuiApi`, so stats/pricing/timeline/rendering stay shared by both versions. Pure mapping lives in [src/v2/map.ts](src/v2/map.ts); the V2 surface is hand-written in [src/v2/types.ts](src/v2/types.ts) (no `@opencode/plugin` dependency).
- `exports["."]` is the V2 server entry ([src/v2/server.ts](src/v2/server.ts)): a no-op that keeps the package loadable from `opencode.json`, so V2 reports `features.tui` and the CLI mounts the sidebar. V1 never resolves it (it reads `./server` or `main`; neither exists).
- Slots: V1 `sidebar_content` (order 56), V2 `sidebar.content`.
- Peers: `@opencode-ai/plugin`, `@opencode-ai/sdk`, `@opentui/solid`, `solid-js` (see [package.json](package.json)).

## Git / safety

- Do not `git reset --hard`, `checkout --`, or force-push unless the user explicitly asks.
- Do not commit unless asked; do not commit `logs/` or personal `cache-hit.config.json` if gitignored.

## When adding features

- Prefer config file over slash commands unless parity with visual-cache is an explicit goal.
- Timeline changes: update **both** `docs/en/timeline.md` and `docs/zh-CN/timeline.md`.
- User-facing README changes: update **English README** and mirror key points in **README.zh-CN.md**.
