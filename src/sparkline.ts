const BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"]

/**
 * Format a series of speed values as a sparkline string.
 * @param values - Array of speed values (tok/s)
 * @param width - Max number of blocks to display (default: 7)
 * @returns Sparkline string like "▁▃▅▇▆▄▂"
 */
export function formatSparkline(values: number[], width: number = 7): string {
  if (values.length === 0) return ""

  const recent = values.slice(-width)
  const min = Math.min(...recent)
  const max = Math.max(...recent)
  const range = max - min

  return recent
    .map((v) => {
      if (range === 0) return BLOCKS[3]
      const normalized = (v - min) / range
      const index = Math.min(Math.floor(normalized * BLOCKS.length), BLOCKS.length - 1)
      return BLOCKS[index]
    })
    .join("")
}

/**
 * Collect speed values from timeline JSONL data.
 * @param records - Array of { durationMs, output, reasoning } from timeline
 * @param maxPoints - Maximum number of data points (default: 7)
 * @returns Array of speed values (tok/s), numerator includes reasoning
 */
export function collectSpeedValues(
  records: Array<{ durationMs?: number; output?: number; reasoning?: number }>,
  maxPoints: number = 7,
): number[] {
  const speeds: number[] = []
  for (const rec of records) {
    const tokens = (rec.output ?? 0) + (rec.reasoning ?? 0)
    if (!rec.durationMs || rec.durationMs <= 0 || tokens < 2) continue
    const speed = (tokens / rec.durationMs) * 1000
    if (speed > 0) speeds.push(speed)
  }
  return speeds.slice(-maxPoints)
}

export function collectTpotValues(
  records: Array<{ durationMs?: number; output?: number; reasoning?: number }>,
  maxPoints: number = 7,
): number[] {
  const values: number[] = []
  for (const rec of records) {
    const tokens = (rec.output ?? 0) + (rec.reasoning ?? 0)
    if (!rec.durationMs || tokens <= 1 || rec.durationMs < 500) continue
    const tpot = rec.durationMs / (tokens - 1)
    if (tpot > 0) values.push(tpot)
  }
  return values.slice(-maxPoints)
}
