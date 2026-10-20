# opencode-cache-hit

A TUI sidebar plugin for OpenCode that reports prompt-cache hit rate, tokens and cost. This context is about how the plugin is *loaded and rendered*, which is where its most surprising constraints live.

## Language

### Packaging

**TUI entry**:
The file OpenCode loads for a plugin's TUI surface — `exports["./tui"]` in the package manifest. The loader reads only `./tui` (or `./server`); `exports["."]` and `main` are never fallbacks.
_Avoid_: main entry, plugin index, sidebar entry

**Dual entry**:
One default export serving both versions: `{ id, tui, setup }`. V1's TUI loader calls `tui(api)` and ignores `setup`; V2's CLI loader calls `setup(ctx)` and ignores `tui`. Neither may coexist with `server` (V1 rejects that pair). Since 1.0.0 only the V2 path is officially supported and tested; the V1 path is best-effort and remains for older releases.
_Avoid_: version branch, compat shim, multi-export

**V2 adapter**:
[src/v2/adapter.ts](../src/v2/adapter.ts) — translates the OpenCode 2 TUI context and events into the internal `TuiApi` / `TuiEvent` contract, so one sidebar implementation serves both versions. It owns the version-specific parts only: message/event translation, provider+model merging, theme flattening, and full-history reads. V1's legacy event payloads reach the same contract through [src/v1-map.ts](../src/v1-map.ts).
_Avoid_: v2 port, v2 sidebar, v2 host

**Raw TSX entry**:
A TUI entry that is TypeScript JSX shipped verbatim, with no build step. This was the form up to 0.7.4, and it is what broke mouse folding.
_Avoid_: source entry, unbundled entry, dev entry

**Pre-transformed TUI bundle**:
A TUI entry emitted by the build with the Solid transform already applied (`dist/tui.js`). This is the form shipped since 0.7.5.
_Avoid_: dist entry, compiled entry, production build

**Solid transform**:
The compile step that turns JSX into reactive element and effect code, implemented by babel-preset-solid through `@opentui/solid/bun-plugin`. It is not the same thing as compiling JSX at all.
_Avoid_: JSX compile, babel step, transpile

**Generic JSX fallback**:
Bun's plain JSX compilation, used when the Solid transform does not apply. It produces a one-shot element tree with no reactive bindings, so a click updates state without repainting anything.
_Avoid_: no transform, JSX mode, unsupported JSX

**Host runtime module**:
The reactive Solid instance OpenCode substitutes for the bare `solid-js` / `@opentui/solid` specifiers in plugin modules. Plugin bundles must keep those specifiers external so both the renderer and the plugin share this one instance.

**Host OpenTUI runtime**:
The single OpenTUI instance OpenCode provides to plugins (`0.6.6` in current OpenCode 2 releases). Its env-var registry lives on a `globalThis` singleton that rejects the same name registered with a different type, so loading a second, older OpenTUI copy into the process aborts plugin load.
_Avoid_: renderer version, opentui peer

**Root entry shims**:
`server.ts` / `tui.ts` at the package root. V2's local-directory resolver looks for `<dir>/server` and `<dir>/tui` and does not read `package.json` exports on that path; package-name installs resolve exports instead. The shims only re-export `src/v2/server.ts` and the built `dist/tui.js`; `tui.ts` therefore needs a build first.
_Avoid_: entry aliases, compat entries

### Panel behaviour

**Fold**:
The collapsed/expanded state of the panel title or of a single section header, toggled by a mouse click. Fold state itself is plain signals; a fold that "does nothing" is a rendering failure, not a state failure.
_Avoid_: collapse, toggle, accordion

**Fold handler**:
The `onMouseUp` callback on the panel title or section header that toggles its fold.
_Avoid_: click listener, mouse callback
