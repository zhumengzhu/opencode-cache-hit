import type { ToolDurationRecord } from "../tool-timing.ts"

/** Single LLM call row (one JSONL line). */
export type LlmCallRecord = {
  schema: 1
  recordedAt: string
  processId?: number
  sessionId: string
  rootSessionId: string
  scope: "main" | "child"
  messageKey: string
  modelId: string
  created: string
  completedAt?: string
  durationMs?: number
  isComplete: boolean
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  cost: number
  hitPercent: number | null
  skippedForHit: boolean
  ttftMs?: number
  ttftSource?: "sdk" | "tui"
  tps?: number
  tpot?: number
  /** Inter-Token Latency P50 (ms). Measured from message.part.delta intervals. */
  itlP50?: number
  /** Inter-Token Latency P90 (ms). Spread between P50 and P90 indicates jitter. */
  itlP90?: number
  /** Number of inter-chunk intervals used to compute ITL quantiles. */
  itlCount?: number
  finish?: string
  toolDurations?: ToolDurationRecord[]
}
