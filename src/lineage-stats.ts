import {
  cacheHitRatio,
  compareAssistantMessages,
  isInteractiveAssistantMessage,
  messageLineageKey,
  perMessageHitPercent,
} from "./stats.ts"
import type { AssistantMessage, LineageBucket } from "./types.ts"

export const UNKNOWN_LINEAGE_KEY = "unknown"

export function lineageKey(providerID?: string, modelID?: string): string {
  return providerID && modelID ? `${providerID}:${modelID}` : UNKNOWN_LINEAGE_KEY
}

function emptyBucket(key: string, providerID: string, modelID: string): LineageBucket {
  return {
    key,
    providerID,
    modelID,
    callCount: 0,
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    cacheRatio: 0,
    agentCounts: {},
  }
}

export function aggregateLineages(messages: readonly AssistantMessage[]): LineageBucket[] {
  const buckets = new Map<string, LineageBucket>()
  const eligible = messages
    .filter((message) => message.role === "assistant" && isInteractiveAssistantMessage(message))
    .slice()
    .sort(compareAssistantMessages)

  for (const message of eligible) {
    const providerID = message.providerID ?? ""
    const modelID = message.modelID ?? ""
    const key = messageLineageKey(message)
    const bucket = buckets.get(key) ?? emptyBucket(key, providerID, modelID)
    const tokens = message.tokens ?? {}
    const agent = message.agent ?? "unknown"
    bucket.callCount += 1
    bucket.input += tokens.input ?? 0
    bucket.output += tokens.output ?? 0
    bucket.reasoning += tokens.reasoning ?? 0
    bucket.cacheRead += tokens.cache?.read ?? 0
    bucket.cacheWrite += tokens.cache?.write ?? 0
    bucket.cost += message.cost ?? 0
    bucket.agentCounts[agent] = (bucket.agentCounts[agent] ?? 0) + 1
    bucket.cacheRatio = cacheHitRatio(bucket.cacheRead, bucket.input)
    bucket.lastCall = {
      id: message.id ?? message.messageID,
      created: message.time?.created,
      completed: message.time?.completed,
      agent: message.agent,
      hitPercent: perMessageHitPercent(message),
    }
    buckets.set(key, bucket)
  }

  return [...buckets.values()]
}

export function activeLineageKey(messages: readonly AssistantMessage[]): string | undefined {
  const eligible = messages
    .filter((message) => message.role === "assistant" && isInteractiveAssistantMessage(message))
    .slice()
    .sort(compareAssistantMessages)
  const last = eligible[eligible.length - 1]
  return last ? lineageKey(last.providerID, last.modelID) : undefined
}

export function recentLineages(buckets: readonly LineageBucket[]): LineageBucket[] {
  return buckets
    .slice()
    .sort((a, b) => {
      const aTime = a.lastCall?.completed ?? a.lastCall?.created ?? -Infinity
      const bTime = b.lastCall?.completed ?? b.lastCall?.created ?? -Infinity
      return bTime - aTime || a.key.localeCompare(b.key)
    })
}
