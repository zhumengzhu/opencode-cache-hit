import { describe, test, expect } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CONFIG_PATH, PLUGIN_ROOT, XDG_CONFIG_PATH, cloneDefault, loadPluginConfig, tryRead } from "../src/load-config.ts"
import { DEFAULT_PLUGIN_CONFIG } from "../src/plugin-config.ts"

describe("load-config paths", () => {
  test("PLUGIN_ROOT is package root", () => {
    expect(existsSync(join(PLUGIN_ROOT, "cache-hit.config.example.json"))).toBe(true)
    expect(existsSync(join(PLUGIN_ROOT, "index.tsx"))).toBe(true)
    expect(CONFIG_PATH).toBe(join(PLUGIN_ROOT, "cache-hit.config.json"))
  })

  test("XDG_CONFIG_PATH is outside cache dir", () => {
    expect(XDG_CONFIG_PATH).toInclude(".config/opencode/cache-hit.json")
    expect(XDG_CONFIG_PATH).not.toInclude(".cache")
  })

  test("loads config from repo cache-hit.config.json when XDG config is absent", () => {
    if (!existsSync(CONFIG_PATH)) return
    const cfg = loadPluginConfig()
    expect(cfg.timeline.enabled).toBe(true)
  })

  test("returns defaults when neither config exists", () => {
    const cfg = loadPluginConfig()
    expect(cfg.display.lang).toBeTruthy()
  })

  test("cloneDefault includes cacheTTL — regression for crash on config.providers access", () => {
    const cfg = cloneDefault()
    expect(cfg.cacheTTL).toBeDefined()
    expect(cfg.cacheTTL.providers).toBeDefined()
    expect(typeof cfg.cacheTTL.enabled).toBe("boolean")
  })

  test("cloneDefault returns deep copy — mutations do not pollute DEFAULT_PLUGIN_CONFIG", () => {
    const cfg = cloneDefault()
    cfg.cacheTTL.providers["evil"] = "1m"
    cfg.timeline.toolSummary = false
    cfg.display.lang = "zh"

    expect(DEFAULT_PLUGIN_CONFIG.cacheTTL.providers).toEqual({})
    expect(DEFAULT_PLUGIN_CONFIG.timeline.toolSummary).toEqual({ allTools: true, bash: false })
    expect(DEFAULT_PLUGIN_CONFIG.display.lang).toBe("en")
  })

  test("parses JSONC configs — comments and trailing commas", () => {
    const dir = mkdtempSync(join(tmpdir(), "cache-hit-"))
    const path = join(dir, "cache-hit.json")
    writeFileSync(
      path,
      [
        "{",
        '  // line comment',
        '  "currency": "USD",',
        '  "costUnit": "USD",',
        '  "display": { "lang": "zh" }, // trailing comma + comment',
        '  /* block comment */ "timeline": { "enabled": false },',
        "}",
      ].join("\n"),
    )
    try {
      const cfg = tryRead(path)
      expect(cfg).not.toBeNull()
      expect(cfg?.cost.currency).toBe("USD")
      expect(cfg?.cost.costUnit).toBe("USD")
      expect(cfg?.display.lang).toBe("zh")
      expect(cfg?.timeline.enabled).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("returns null for malformed config content", () => {
    const dir = mkdtempSync(join(tmpdir(), "cache-hit-"))
    const path = join(dir, "bad.json")
    writeFileSync(path, "{ nope")
    try {
      expect(tryRead(path)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
