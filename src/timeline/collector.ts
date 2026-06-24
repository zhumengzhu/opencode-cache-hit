import type { FirstPartTimeTracker } from "../first-part-time.ts"
import type { ItlTracker } from "../itl-tracker.ts"
import type { ToolTimingTracker } from "../tool-timing.ts"
import type { TimelineConfig } from "../plugin-config.ts"
import type { AssistantMessage } from "../types.ts"
import { assistantMessageToRecord } from "./records.ts"
import {
  appendTimelineRecord,
  localDateKey,
  purgeTimelineLogDir,
  resolveTimelineDir,
  timelineDailyLogPath,
} from "./writer.ts"
import type { LlmCallRecord } from "./types.ts"

export type TimelineCollector = {
  /** Process a single message from a message.updated event. */
  handleMessage: (sessionID: string, msg: AssistantMessage) => void
  resetForRootChange: () => void
  dispose: () => void
  memoryRecords: () => readonly LlmCallRecord[]
}

export function createTimelineCollector(opts: {
  getConfig: () => TimelineConfig
  getRootSessionId: () => string
  getChildIds: () => readonly string[]
  firstPartTime: FirstPartTimeTracker
  toolTiming: ToolTimingTracker
  itlTracker?: ItlTracker
  /** Test hook: replace disk append */
  append?: (logPath: string, record: LlmCallRecord, config: TimelineConfig) => Promise<void>
}): TimelineCollector {
  const ttft = opts.firstPartTime
  const toolTiming = opts.toolTiming
  const itlTracker = opts.itlTracker
  const processId = process.pid
  const defaultAppend = opts.append ?? ((path: string, record: LlmCallRecord, cfg: TimelineConfig) =>
    appendTimelineRecord(path, record, {
      maxLinesPerFile: cfg.maxLinesPerFile,
      rotateMaxBytes: cfg.rotateMaxBytes,
      retainRotated: cfg.retainRotated,
    }))

  let activeDateKey = localDateKey()
  let memory: LlmCallRecord[] = []
  let disposed = false
  let purgeDone = false

  const ensureDateKey = () => {
    const today = localDateKey()
    if (today !== activeDateKey) {
      activeDateKey = today
    }
    return today
  }

  const maybePurge = (config: TimelineConfig) => {
    if (purgeDone) return
    if (config.maxAgeDays <= 0 && config.maxLogFiles <= 0) return
    purgeDone = true
    void purgeTimelineLogDir(resolveTimelineDir(config), {
      maxAgeDays: config.maxAgeDays,
      maxLogFiles: config.maxLogFiles,
    })
  }

  const handleMessage = (sessionID: string, msg: AssistantMessage) => {
    if (disposed) return
    const config = opts.getConfig()
    if (!config.enabled) return

    const rootId = opts.getRootSessionId()
    if (!rootId) return

    let scope: "main" | "child"
    if (sessionID === rootId) {
      scope = "main"
    } else if (opts.getChildIds().includes(sessionID)) {
      scope = "child"
    } else {
      return
    }

    if (msg.role !== "assistant") return
    if (!config.logSummaryMessages && msg.summary === true) return

    maybePurge(config)

    const msgID = msg.id ?? msg.messageID ?? ""
    const q = itlTracker?.getQuantiles(msgID)
    const rec = assistantMessageToRecord(
      msg,
      sessionID,
      rootId,
      scope,
      Date.now(),
      ttft.get().get(msgID),
      ttft.getSource(msgID),
      toolTiming.getDurations(msgID),
      q && q.p50,
      q && q.p90,
      q && q.count,
      processId,
    )
    if (!rec) return
    if (!config.flushIncomplete && !rec.isComplete) return
    // Skip records with invalid timestamps (e.g. uninitialised epoch 1970)
    if (rec.created.startsWith("1970")) return

    const logsDir = resolveTimelineDir(config)
    const logPath = timelineDailyLogPath(logsDir, ensureDateKey())
    void defaultAppend(logPath, rec, config).catch(() => {})

    memory.push(rec)
    const max = config.maxMemoryRows
    while (memory.length > max) memory.shift()
  }

  return {
    handleMessage,
    resetForRootChange: () => {
      memory = []
    },
    dispose: () => {
      disposed = true
      memory = []
    },
    memoryRecords: () => {
      const max = opts.getConfig().maxMemoryRows
      if (memory.length <= max) return memory
      return memory.slice(-max)
    },
  }
}
