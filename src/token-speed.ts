import { generationDurationMs, timingFromAssistantMessage } from "./message-timing.ts"
import type { AssistantMessage } from "./types.ts"
import { isInteractiveAssistantMessage } from "./stats.ts"

export function computeTokenSpeed(output: number, reasoning: number, durationMs: number): number {
  if (durationMs < 500) return 0
  return ((output + reasoning) / durationMs) * 1000
}

export function computeTokenTpotMs(
  output: number,
  reasoning: number,
  generationMs: number,
): number | undefined {
  if (generationMs < 500) return undefined
  const tokens = output + reasoning
  if (tokens <= 1) return undefined
  return generationMs / (tokens - 1)
}

export function computeAvgTokenSpeed(
  messages: AssistantMessage[],
  firstPartTime?: ReadonlyMap<string, number>,
): number {
  let totalTokens = 0
  let totalMs = 0
  for (const msg of messages) {
    if (!isInteractiveAssistantMessage(msg)) continue
    const timing = timingFromAssistantMessage(msg)
    if (!timing?.isComplete) continue
    const output = msg.tokens?.output ?? 0
    const reasoning = msg.tokens?.reasoning ?? 0
    if (output + reasoning === 0) continue
    const msgID = msg.id ?? msg.messageID
    const firstTime = msgID ? firstPartTime?.get(msgID) : undefined
    const duration = generationDurationMs(timing, firstTime)
    if (duration === undefined || duration < 500) continue
    totalTokens += output + reasoning
    totalMs += duration
  }
  return totalMs > 0 ? (totalTokens / totalMs) * 1000 : 0
}

export function computeAvgTokenTpotMs(
  messages: AssistantMessage[],
  firstPartTime?: ReadonlyMap<string, number>,
): number | undefined {
  let totalGenerationMs = 0
  let totalTokenIntervals = 0
  for (const msg of messages) {
    if (!isInteractiveAssistantMessage(msg)) continue
    const timing = timingFromAssistantMessage(msg)
    if (!timing?.isComplete) continue
    const output = msg.tokens?.output ?? 0
    const reasoning = msg.tokens?.reasoning ?? 0
    const tokens = output + reasoning
    if (tokens <= 1) continue
    const msgID = msg.id ?? msg.messageID
    const firstTime = msgID ? firstPartTime?.get(msgID) : undefined
    const duration = generationDurationMs(timing, firstTime)
    if (duration === undefined || duration < 500) continue
    totalGenerationMs += duration
    totalTokenIntervals += tokens - 1
  }
  return totalTokenIntervals > 0 ? totalGenerationMs / totalTokenIntervals : undefined
}

export function formatTokenSpeed(tps: number): string {
  if (tps < 1) return "<1 tok/s"
  return `${Math.round(tps)} tok/s`
}

export function formatTokenTpot(ms: number | undefined): string {
  if (ms === undefined) return "—"
  if (ms < 1) return "<1 ms/tok"
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s/tok`
  return `${Math.round(ms)} ms/tok`
}

export function estimateStreamingSpeed(
  text: string,
  created: number,
  now: number,
  firstPartTime?: number,
): number {
  if (!text) return 0
  const start =
    firstPartTime !== undefined && firstPartTime > created ? firstPartTime : created
  const elapsed = (now - start) / 1000
  if (elapsed < 0.5) return 0
  const estimated = Math.max(1, Math.round(text.length / 4))
  return estimated / elapsed
}
