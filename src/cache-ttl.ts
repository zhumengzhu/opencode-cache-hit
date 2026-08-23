/**
 * Cache TTL pure logic: provider TTL resolution and built-in defaults.
 * Kept JSX-free so it can be imported directly by tests (see AGENTS.md).
 * UI lives in cache-ttl-view.tsx.
 */
import type { CacheTTLConfig } from "./plugin-config.ts"
import { parseDuration } from "./plugin-config.ts"
import { compareAssistantMessages, isInteractiveAssistantMessage, messageLineageKey } from "./stats.ts"
import type { AssistantMessage } from "./types.ts"

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE

export const DEFAULT_TTL_MS = 5 * MINUTE

export const BUILT_IN_TTL: Record<string, number> = {
  anthropic: 5 * MINUTE,
  openai: 5 * MINUTE,
  deepseek: 2 * HOUR,
  google: 1 * HOUR,
  xai: 5 * MINUTE,
  minimax: 5 * MINUTE,
  xiaomi: 5 * MINUTE,
  qwen: 5 * MINUTE,
  moonshot: 5 * MINUTE,
}

export function findLastCacheActivityByLineage(
  messages: readonly AssistantMessage[],
): Map<string, AssistantMessage> {
  const result = new Map<string, AssistantMessage>()
  for (const message of messages) {
    if (
      message.role !== "assistant" ||
      !isInteractiveAssistantMessage(message) ||
      message.time?.completed === undefined ||
      ((message.tokens?.cache?.read ?? 0) === 0 && (message.tokens?.cache?.write ?? 0) === 0)
    ) {
      continue
    }
    const key = messageLineageKey(message)
    const previous = result.get(key)
    if (!previous || compareAssistantMessages(previous, message) < 0) result.set(key, message)
  }
  return result
}

// Tolerates undefined/partial config (guards against pre-normalize input; see #3).
export function getTTL(
  providerID: string,
  modelID: string,
  config: CacheTTLConfig | undefined,
): number {
  const userProviders = config?.providers ?? {}
  const specific = userProviders[`${providerID}:${modelID}`]
  if (specific !== undefined) {
    const parsed = parseDuration(specific)
    if (parsed !== null) return parsed
  }
  const userProvider = userProviders[providerID]
  if (userProvider !== undefined) {
    const parsed = parseDuration(userProvider)
    if (parsed !== null) return parsed
  }
  const builtIn = BUILT_IN_TTL[providerID]
  if (builtIn !== undefined) return builtIn
  return DEFAULT_TTL_MS
}

export function formatElapsed(ms: number): string {
  if (ms <= 0) return "0s"
  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}
