import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  type PluginConfig,
  normalizePluginConfig,
  DEFAULT_PLUGIN_CONFIG,
} from "./plugin-config.ts"
import { parseJsonc } from "./jsonc.ts"

/** Parent of `src/` (plugin package root). Do not wrap in `dirname` — `..` already resolves there. */
export const PLUGIN_ROOT = fileURLToPath(new URL("..", import.meta.url))

/** Preferred config: ~/.config/opencode/cache-hit.json (survives plugin updates). */
export const XDG_CONFIG_PATH = join(homedir(), ".config", "opencode", "cache-hit.json")

/** Legacy config: plugin-root `cache-hit.config.json` (for npm cache / local installs). */
export const CONFIG_PATH = join(PLUGIN_ROOT, "cache-hit.config.json")

export function cloneDefault(): PluginConfig {
  return structuredClone(DEFAULT_PLUGIN_CONFIG)
}

export function tryRead(path: string): PluginConfig | null {
  try {
    return normalizePluginConfig(parseJsonc(readFileSync(path, "utf8")))
  } catch {
    return null
  }
}

export function loadPluginConfig(): PluginConfig {
  // 1. XDG config dir (preferred — persists across updates)
  if (existsSync(XDG_CONFIG_PATH)) {
    const cfg = tryRead(XDG_CONFIG_PATH)
    if (cfg) return cfg
  }
  // 2. Legacy plugin-root config (backward compatible)
  if (existsSync(CONFIG_PATH)) {
    const cfg = tryRead(CONFIG_PATH)
    if (cfg) return cfg
  }
  return cloneDefault()
}
