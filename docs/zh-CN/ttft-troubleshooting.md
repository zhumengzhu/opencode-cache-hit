# TTFT 故障排除指南

**速度** 区域中的 **首Token**（TTFT）表示最近一条有有效 first-part 时间戳的 assistant 轮次的首 Token 延迟：从请求开始（`msg.time.created`）到首个 `text` 或 `reasoning` 流式 token 的时间。流式中首 token 到达即可显示，不依赖轮次完成。

示例：`首Token: 944ms` 或 `首Token: 1.2s`。无法获得可靠的首 token 时间戳时显示 `"—"`。

侧边栏 TTFT 使用默认配置即可，**不需要**开启 `timeline.enabled`。Timeline JSONL 中的 `ttftMs` 字段是另一套能力，见 [Timeline](./timeline.md)。

实现说明：[TTFT 混合实现](./ttft-hybrid.md)。

> **事件名**：本文使用插件内部事件契约（`src/types.ts` 的 `TuiEvent`）：`part` / `message` / `delta` / `tick`。OpenCode 1（`message.part.updated`、`message.part.delta` …）与 OpenCode 2（`session.text.started`、`session.text.delta` …）的源事件分别在 `v1-map.ts` / `v2/adapter.ts` 中映射到该契约，见 [design.md § 事件映射](./design.md#事件映射)。

---

## 何时显示 `"—"` 属于正常情况

| 情况 | 原因 |
|------|------|
| 轮次仍在流式输出 | 流式中首 token 到达即可展示（与侧边栏相同） |
| 速度区域被隐藏 | `cache-hit.json` 中 `display.showSpeed: false` |
| 刚打开面板尚无可用首Token | 还没有带有效 first-part 时间戳的 assistant 轮次 |

---

## 轮次完成后仍为 `"—"` 时的排查

### 1. 对照 **实时**（流式速度）

| 流式时 **实时** | 可能原因 |
|----------------|----------|
| 有 tok/s | parts 存在，完成后通常应出现 TTFT；若仍无，见 §2–3 |
| 显示 `·` | `api.state.part()` 可能为空 — 部分本地后端常见 |

### 2. Provider / OpenCode 限制

部分环境不提供流式 part 或 `part.time.start`：

- **本地模型**（LM Studio、Ollama）可能无 parts 表 ([#23673](https://github.com/anomalyco/opencode/issues/23673))
- **`part` 事件无 `part.time.start`** — 插件会尝试 TUI 端增量与 part 状态扫描；两者皆空则 TTFT 为 `"—"`
- **部分 OpenCode 版本不投递流式增量**（V1 的 `message.part.delta`，[#27663](https://github.com/anomalyco/opencode/issues/27663)）
- **时间戳无效**（`part.time.start <= msg.time.created`，如 SDK [#21544](https://github.com/anomalyco/opencode/issues/21544)）— 省略该值，避免显示 0 或负 TTFT

### 3. 侧边栏有 TTFT 但 JSONL 无 `ttftMs`

侧边栏与 JSONL 共用同一套时序数据。侧边栏有值而日志无字段时：

```json
{
  "timeline": { "enabled": true }
}
```

确认 `~/.config/opencode/cache-hit.json`（或包目录旁 legacy `cache-hit.config.json`）中 `timeline.enabled` 为 `true`，修改后重启 OpenCode。

---

## 配置说明

**侧边栏 TTFT** — 无需额外配置；`display.showSpeed` 为 true 时显示（默认开启）。

**JSONL `ttftMs`** — 需开启 timeline：

```json
{
  "display": { "showSpeed": true },
  "timeline": { "enabled": true }
}
```

---

## 已知上游限制

| Issue | 对 TTFT 的影响 |
|-------|----------------|
| [#23673](https://github.com/anomalyco/opencode/issues/23673) 本地模型无 parts | 常始终为 `"—"` |
| [#27663](https://github.com/anomalyco/opencode/issues/27663) 丢失 V1 `message.part.delta` | TUI 端路径可能不可用 |
| [#26924](https://github.com/anomalyco/opencode/issues/26924) Part 事件乱序 | 插件通过多数据源补偿 |
| [#21544](https://github.com/anomalyco/opencode/issues/21544) `time.start` 被覆盖 | 无效 SDK 端时间戳会被跳过 |

消息元数据中的总轮次耗时（`time.completed - time.created`）始终可得，但**不会**作为 TTFT 展示 — TTFT 只度量首 Token 延迟。

---

## 相关文档

- [TTFT 混合实现](./ttft-hybrid.md) — 时序采集方式
- [Timeline](./timeline.md) — JSONL 日志
- [Token 速度](./token-speed.md) — 速度区域布局
