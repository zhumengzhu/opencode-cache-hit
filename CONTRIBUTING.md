# Contributing

Development, packaging, and npm release notes for **opencode-cache-hit**. User install and configuration: [README.md](README.md) · [README.zh-CN.md](README.zh-CN.md).

## Development

```bash
bun install   # dev: solid-js; peers resolved by OpenCode at runtime
bun test
bun run check   # bun test + tsc --noEmit (type-check via tsconfig.json)
```

Architecture: [docs/en/design.md](docs/en/design.md). After refactors, `tests/module-load.test.ts` catches broken import paths.

Coding agents: [AGENTS.md](AGENTS.md).

After `bun install`, a **pre-push** hook runs `bun run check` — tests plus `tsc --noEmit` (skip with `git push --no-verify`). **CI** (GitHub Actions on `main` and PRs) runs the same check on the server.

## Configuration file

The plugin reads config from two locations (priority order):

1. **XDG**: `~/.config/opencode/cache-hit.json` (preferred — persists across plugin updates)
2. **Legacy**: `cache-hit.config.json` beside plugin root (backward compatible)

The XDG path is recommended for npm global installs; the legacy path still works for local installs and existing setups.

| File | In npm tarball? | Purpose |
|------|-----------------|--------|
| `cache-hit.config.example.json` | **Yes** | Template; copy and edit |
| `cache-hit.config.json` | **No** | Legacy plugin-root overrides |
| `logs/` | **No** | Timeline output (default: `~/.local/share/opencode/logs/cache-hit/`) |

After installing:

```bash
cp cache-hit.config.example.json ~/.config/opencode/cache-hit.json
# edit, then restart OpenCode
```

For a **local path** plugin in `~/.config/opencode/plugins/opencode-cache-hit/`, placing `cache-hit.config.json` in that folder also works (matches the legacy fallback).

## Versioning

Follow [Semantic Versioning](https://semver.org/):

| Change | Bump | Example |
|--------|------|---------|
| Bug fix (backward-compatible) | **patch** | `0.1.0` → `0.1.1` |
| New feature (backward-compatible) | **minor** | `0.1.0` → `0.2.0` |
| Breaking change | **major** | `0.2.0` → `1.0.0` |

Default changes (rate, paths) accompanied by new features → minor. Pure bugfixes only → patch.

## Building and publishing to npm

The published `./tui` entry is a **pre-transformed bundle**, `dist/tui.js` (`bun run build` → [scripts/build-tui.ts](scripts/build-tui.ts)). It has to be: opencode loads plugin TUI modules from `node_modules`, where OpenTUI's Solid transform is skipped, so raw TSX runs as generic JSX and mouse folding silently does nothing ([docs/adr/0001](docs/adr/0001-prebundled-tui-entry.md), [opencode#39986](https://github.com/anomalyco/opencode/issues/39986)).

```bash
bun run build   # writes dist/tui.js; also runs on `bun install` (prepare) and before npm packs (prepack)
```

Keep `packages: "external"` in the build config: opencode resolves `solid-js` / `@opentui/solid` to its own runtime modules, and inlining them creates a second runtime whose signals never repaint the host renderer.

**Tarball contents** — `package.json` → `"files"`:

- `dist/tui.js` (the `./tui` entry), `index.tsx`, `src/`, docs, `scripts/`, `cache-hit.config.example.json`, READMEs, `AGENTS.md`, `CONTRIBUTING.md`, `CONTEXT.md`, `LICENSE`
- Not included: `tests/`, `logs/`, personal `cache-hit.config.json`, `node_modules/`
- `dist/` is gitignored: it is built into the tarball, not committed.
- Verify the shipped shape before publishing: `bun pm pack --dry-run` (runs `prepack`, lists the tarball without writing it).

**npmjs.com page**

| Source | Effect |
|--------|--------|
| `description` | One-line summary (keep under ~180 chars) |
| `README.md` | Main package page |
| `keywords` | Search tags |
| `LICENSE` | License tab |

`prepublishOnly` runs `bun run check` (tests + type-check). Set `author` in `package.json` before publish if not already present.

**Release** — tag-driven CI publish, no local `npm publish` needed:

```bash
git tag vX.Y.Z && git push origin vX.Y.Z
```

Pushing a `v*` tag triggers [.github/workflows/publish.yml](.github/workflows/publish.yml): it runs `bun run check` (tests + type-check), then `npm publish --provenance --access public` (requires the `NPM_TOKEN` repo secret; provenance uses the workflow's OIDC `id-token: write` permission). Check the result with `gh run list --workflow=publish.yml`.

[opencode-visual-cache](https://www.npmjs.com/package/opencode-visual-cache) pre-bundles its `./tui` entry the same way (esbuild + `esbuild-plugin-solid`); `@mtayfur/opencode-cache-view` uses `@opentui/solid/bun-plugin`, like this repo.

## Pull requests

- Ensure the [test workflow](.github/workflows/test.yml) passes on your branch.
- Run `bun run check` locally (or rely on pre-push / CI).
- User-facing README: update [README.md](README.md) and mirror key points in [README.zh-CN.md](README.zh-CN.md).
- Timeline: update [docs/en/timeline.md](docs/en/timeline.md) and [docs/zh-CN/timeline.md](docs/zh-CN/timeline.md).
