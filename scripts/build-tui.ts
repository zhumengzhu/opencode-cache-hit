import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

/**
 * Build config for the published TUI entry. Keep this the single source of
 * truth: `bun run build` and the packaging tests both go through it, so the
 * artifact we test is the artifact we publish.
 *
 * `packages: "external"` is load-bearing. opencode rewrites the bare
 * `solid-js` / `@opentui/solid` specifiers in TUI plugin modules to its own
 * runtime modules, so the bundle must share the host's reactive runtime.
 * Inlining either package yields a second runtime instance whose signals never
 * notify the host renderer: clicks still fire but nothing repaints. See
 * docs/adr/0001-prebundled-tui-entry.md.
 */
export function buildOptions(entry = "./index.tsx"): Parameters<typeof Bun.build>[0] {
  return {
    entrypoints: [entry],
    outdir: "./dist",
    naming: "tui.js",
    target: "bun",
    format: "esm",
    packages: "external",
    plugins: [createSolidTransformPlugin()],
  }
}

export async function buildTui(
  overrides: Partial<Parameters<typeof Bun.build>[0]> = {},
): Promise<Awaited<ReturnType<typeof Bun.build>>> {
  const result = await Bun.build({ ...buildOptions(), ...overrides })
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    throw new AggregateError(result.logs, "TUI build failed")
  }
  return result
}

if (import.meta.main) {
  const result = await buildTui()
  for (const output of result.outputs) {
    console.log(`${output.path} ${(output.size / 1024).toFixed(1)} KiB`)
  }
}
