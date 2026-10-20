# Token 速度侧边栏 — 设计

功能：在侧边栏面板中显示 **TPOT**（每个输出 token 耗时，ms/token），与现有的缓存命中率 / token / 费用指标并列。

> **事件名**：本文使用插件内部事件契约（`src/types.ts` 的 `TuiEvent`）：`part` / `message` / `delta` / `tick`。OpenCode 1 与 OpenCode 2 的源事件分别在 `v1-map.ts` / `v2/adapter.ts` 中映射到该契约，见 [design.md § 事件映射](./design.md#事件映射)。

## 1. 参考：MiMo-Code 侧边栏

MiMo-Code 的 TUI 侧边栏使用两种模式显示速度：
- **流式传输中**：基于字符的启发式估算（4 字符 ≈ 1 token），周期性轮询；显示时通过 `1000 / speed` 转换为 ms/tok
- **完成后**：使用 `StepFinishPart.tokens` 的真实 token 数，以 TPOT（ms/token）展示

---

## 2. 功能特性

### 已完成调用的速度（TPOT）

展示**已完成** LLM 调用的 **TPOT**（Time Per Output Token，ms/token），使用真实 token 数。TPOT 遵循业界标准公式：

```
TPOT = generationMs / (output_tokens + reasoning_tokens - 1)
```

`-1` 排除首个 token（已由 TTFT 单独捕获）。当 `firstPartTime` 已跟踪时，`generationMs = completedAt - firstPartTime`（排除 TTFT）；否则回退为整轮时长（`completed - created`）。

**边界情况：**
- `output + reasoning <= 1`：TPOT 未定义（业界标准 — 单 token 无 inter-token 间隔）
- `generationMs < 500ms`：TPOT 未定义（噪声阈值）

**分子包含 reasoning tokens** — reasoning 是模型 decode 产出，计入生成速度。

### 实时流式速度

流式传输期间的实时速度估算，使用 char/4 启发式。内部以 tok/s 计算，显示时转换为 ms/tok（`1000 / speed`）。需要 `api.state.part(id)` 访问流式文本内容。

**实时** 行状态：

| 状态 | 显示 | 颜色 |
|------|------|------|
| 空闲（无流式） | `·` | muted |
| 预热（TTFT 等待、距起点 &lt;500ms 或尚无文本） | `—` | success |
| 流式中 | `~N ms/tok` | success |
| 保持（流式结束后 2 秒） | 上次 `~N ms/tok` | muted |

`~` 表示 **实时** 为流式估算值（char/4 启发式）。**最近** 和 **平均** 使用真实 token 数，无 `~` 前缀。

### 速度迷你图（Sparkline）

微型内联图表，展示最近 N 次调用的 TPOT 趋势。渲染为方块字符迷你图（如 `▁▃▅▇▆▄▂`）。

### 子 Agent 速度

扩展"子 Agent"区域，为每个子会话添加 TPOT 行。仅使用整轮时长（子 session 未接入主 session 的 TTFT tracker）。

### 相关模块

| 文件 | 职责 |
|------|------|
| `src/token-speed.ts` | 纯速度/TPOT 计算（`computeTokenTpotMs`、`computeAvgTokenTpotMs`、`formatTokenTpot` 等） |
| `src/streaming-state.ts` | 流式 phase 状态机（`advanceStreamingNow`） |
| `src/sparkline.ts` | 迷你图渲染 + `collectTpotValues` |
| `src/first-part-time.ts` | TTFT tracker（侧边栏 + timeline） |
| `src/itl-tracker.ts` | ITL chunk 间隔 tracker（侧边栏事件 → JSONL） |
| `src/use-cache-hit-metrics.ts` | 最近 / 平均 TPOT |
| `src/main-session-view.tsx` | 速度区域 UI |
| `src/sidebar-host.tsx` | 事件驱动流式唤醒、自适应轮询、子 Agent TPOT |
| `src/agents-view.tsx` | 子 Agent TPOT 行 |
| `src/stats.ts` | `toSubAgentSummary()` 的 tpot |
| `src/types.ts` | `StreamPart`、`SubAgentSummary.speed` |
| `src/i18n.ts` | 速度文案（含 `streamingIdle`） |
| `src/plugin-config.ts` | `display.showSpeed` |

---

## 3. 配置

```json
{
  "display": {
    "showSpeed": true,
    "speedUnit": "tps"
  }
}
```

| 字段 | 默认 | 含义 |
|------|------|------|
| `showSpeed` | `true` | 显示/隐藏速度区域 |
| `speedUnit` | `"tps"` | `"tps"`（tok/s）或 `"tpot"`（ms/tok） |

---

## 4. UI 布局

位置：**Detail** 和 **Model** 区域之间。

```
┌─ 缓存命中 ─────────────────────────────┐
│ ▼ 命中率 [████████░░] 82.5% ↑5.2      │
│ 总命中: 82.2%                            │
│ 存活: 3m 12s                             │
│                                          │
│ ▼ 明细                                   │
│   缓存读: 125.0K tok                     │
│   缓存写: 8.2K tok                       │
│   ...                                    │
│                                          │
│ ▼ 速度                                   │
│   实时: ~19 ms/tok                         │  ← 流式（空闲: ·）
│   最近: 21 ms/tok                         │
│   平均: 24 ms/tok                          │
│   趋势: ▁▃▅▇▆▄▂                         │
│   首Token: 944ms                         │  ← 最近有有效首Token时间戳的轮次（或 "—"）
│                                          │
│ ▼ 模型                                   │
│   费用: $0.20                            │
│   模型: claude-sonnet-4-20250514         │
│   ...                                    │
│                                          │
│ ▼ 子 Agent (2) · 仅子会话               │
│   deepseek-v4-f… …cgy1  ¥0.092          │
│                      10 ms/tok           │
│   deepseek-v4-f… …auBU  ¥0.044          │
│                      11 ms/tok           │
└──────────────────────────────────────────┘
```

---

## 5. 风险与依赖

| 风险 | 影响 | 缓解 |
|------|------|------|
| `api.state.part()` 不可用 | **实时** 无法估算（warmup / `·`） | **最近/平均** 仍用真 token；见 [TTFT 故障排除](./ttft-troubleshooting.md) |
| 插件 SDK 字段缺失 | 部分指标为空 | 可选链；缺数据行用 `"—"`（非 **实时** 空闲） |
| 极短已完成轮次 | **最近/平均** 显示 `—` | `generationMs < 500` 时 `computeTokenTpotMs` 返回 undefined |
| 单 token 输出 | TPOT 未定义 | 返回 `undefined` → 显示 `—` |

> **轮询策略：** 自适应 `setTimeout`（流式 1s / 空闲 3s），辅以 `part` / `delta` 事件驱动唤醒。极轻量 — 空闲 tick 仅更新 phase 指示（`·`）。

**`—` 用法（与 §2 一致）**：**实时** 空闲为 `·`；`—` 用于首Token、单 token TPOT 等无可靠数据的指标，不用于流式空闲。

---

## 6. **实时**速度算法

### 当前：自首 token 起的累积平均（已采用）

`src/token-speed.ts` 中的 `estimateStreamingSpeed()`：

```
start = firstPartTime（> created 时）?? msg.time.created
速度 ≈ (text.length / 4) / ((now - start) / 1000)   // tok/s
显示 = 1000 / 速度                                   // → ms/tok
```

**分母选择：** 当 `firstPartTime` 已记录（与 timeline / **TTFT** 行共用的 hybrid tracker）时，分母从首 token 起算 — **实时**反映生成速度，不含 TTFT 等待。首条 stream part 记录前仍回退到 `msg.time.created`。

**语义：** 这是**自首次输出以来的平均速度**，不是瞬时速率。以 ms/tok 显示，与 TPOT 保持一致。

**作为默认的理由**

- 实现简单 — 无需 per-message 采样缓冲
- TUI 侧边栏数值稳定、少跳动
- 与**最近** / **平均**（完成后的真 token）互补
- 与 MiMo-Code 参考实现同为 char/4 启发式；排除 TTFT，与 opencode-hud / throughput 等插件一致

**代价**

- 首 token 尚未记录时，分母仍用 `created`（warmup / TTFT 阶段）
- 流中停顿（工具调用、长思考）时平均缓慢下降，而非骤降到近 0
- 中英文、代码、reasoning 混排时 char/4 有系统误差（凡基于文本的估算共有）

### 备选：滑窗式（未实现）

在最近 Δt（如 1–3 秒）内度量增量：

```
速度 ≈ (Δchars / 4) / Δt
```

由定时轮询或 `delta` 事件打点，对每个进行中的消息维护 `(时间戳, 字符数)` 环形缓冲。

| | 累积平均（当前） | 滑窗式 |
|--|-----------------|--------|
| 含义 | 自首 token 起的平均（已跟踪时排除 TTFT） | 接近瞬时的速率 |
| 稳定性 | 高 | 较低；可能需要 EMA 平滑 |
| 卡顿 | 缓慢回落 | 无新字时快速走低 |
| 突发加速 | 被历史稀释 | 短窗内更明显 |
| 状态 | 极少 | 需记录上次采样或缓冲 |
| 工具/思考间隙 | 平均持续被拉低 | 窗内无增量时接近 0，需单独语义 |

**何时再考虑滑窗：** 需要明显感知卡顿/突发，或希望流式中 **实时** 更接近完成后的 **最近**。对当前「粗看吞吐」的侧边栏目标非必需。
