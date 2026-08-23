import type { ToolDurationRecord } from "../tool-timing.ts"

/** Single LLM call row (one JSONL line). */
export type LlmCallRecord = {
  schema: 1
  recordedAt: string
  sessionId: string
  rootSessionId: string
  scope: "main" | "child"
  messageKey: string
  modelId: string
  /** Provider id at record time (may be absent in older logs). */
  providerId?: string
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
  /** Injected by timeline-dashboard: cost recomputed with dynamic pricing (time-of-day / context tier). */
  dynCost?: number
  hitPercent: number | null
  skippedForHit: boolean
  /** True for summary/compaction rows kept for diagnostics but excluded from metrics. */
  skippedForMetrics: boolean
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
