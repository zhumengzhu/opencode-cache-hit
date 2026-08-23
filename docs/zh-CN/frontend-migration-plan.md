# 前端迁移方案：session.get() 聚合数据

> **历史状态：** 本文描述的 `session.get()` 迁移不再是主 session 交互指标的主要数据源。当前 lineage 实现直接请求主 session 消息（`limit: 10000`），过滤 summary 与 compaction 调用；`session.get()` 仅作为 snapshot 和子 session 数据的兜底。详见 [design.md](./design.md)。

## 概述

cache-hit 插件此前通过遍历 `api.state.session.messages()` 逐条累加 per-message 字段来统计 cost/token。这个路径受 OpenCode TUI sync 的 **100 条消息上限** 限制（[issue #31513]），超过 100 条消息的会话数据被静默截断。

**影响**：对于超过 100 条消息的会话，截断导致大量数据丢失。在一个实际的长会话中，插件仅显示了约 43% 的缓存读 token 和约 39% 的实际费用。

| 指标 | 旧（messages，100 条截断） | 新（session.get，无截断） |
|------|--------------------------|-------------------------|
| 缓存读 | 59.6M tok | **139.0M tok** |
| 缓存写 | 89.8K tok | **1.4M tok** |
| 未命中 | 118 tok | **329 tok** |
| 输出 | 32.7K tok | **91.9K tok** |
| 可见子 Agent | 3 | **10** |

修复方案是将数据来源从逐条消息累加切换为 `api.state.session.get()`，该接口返回 **数据库层聚合值**，由 session projector 从全部消息累加得出 —— 不受 100 条上限影响。

## 根因

OpenCode TUI sync（`packages/opencode/src/cli/cmd/tui/context/sync.tsx`）在获取会话消息时硬编码了 `limit: 100`：

```typescript
// 第 559 行 — 最多获取 100 条消息
sdk.client.session.messages({ sessionID, limit: 100 }),

// 第 580-581 行 — TUI store 也只保留最后 100 条
const visible = infos.slice(-100)
```

`api.state.session.messages(sid)` 读取的是 `sync.data.message[sid]`，最多 100 条。超过的会话，插件看到的是不完整数据，且没有任何截断提示。

与此同时，OpenCode SQLite 数据库的 `session` 表存储了**预聚合**列（`cost`、`tokens_input`、`tokens_output`、`tokens_cache_read`、`tokens_cache_write`），由 session projector 通过 SQL 增量更新 —— 每条消息都会被计入，无上限。

`api.state.session.get(sid)` 返回完整 `Session` 对象（SDK 类型 `Session`），包含来自数据库聚合的 `cost` 和 `tokens` 字段。

## 方案

### 设计

```
之前：
  api.state.session.messages(sid) → 遍历 100 条消息 → 累加           ❌ 截断

现在：
  api.state.session.get(sid)      → 直接读 cost/tokens → 完成       ✅ 全量
  └─ session 不可用时              → fallback 到消息累加             （兼容）
```

### 改动

| 文件 | 内容 |
|------|------|
| `src/types.ts` | 新增 `SessionObject` 类型（`model`、`cost`、`tokens`、`parentID`）；更新 `session.get` 返回类型 |
| `src/stats.ts` | 新增 `aggregateFromSessionObject()` — O(1) 从 `SessionObject` 提取 `SessionSnapshot` |
| `src/sidebar-host.tsx` | `mainSnap` 和 `subAgentList` 优先使用 `session.get()`，不可用时 fallback 到消息累加 |
| `tests/stats.test.ts` | 3 个测试用例覆盖空对象、完整对象、部分字段对象 |

### 数据流

1. **`mainSnap`**：调用 `api.state.session.get(sid)` → `aggregateFromSessionObject()` → 有数据则返回。若 session 不可用或为空，fallback 到 `aggregateSessionFromMessages()`。

2. **`subAgentList`**：每个子会话同上。

3. **逐轮趋势**（`computePerCallHitTrend`）：仍使用 `api.state.session.messages()` —— 趋势只看最近几轮，100 条足够。

### 为什么 resume 会话立即可见

resume 会话时，OpenCode TUI `sync()` 立即调用 `sdk.client.session.get({ sessionID })` 获取完整 `Session` 对象（含数据库级聚合值）。该对象存入 TUI state store，`api.state.session.get(sid)` 读取之。插件从会话加载的瞬间就能看到准确总数。

### Fallback 策略

`session.get()` 对从未被 sync 到 TUI state 的会话返回 `undefined`（极少见，多见于特殊上下文中加载的子会话）。fallback 到 `api.state.session.messages()` 作为安全网保留原有行为。

## 性能

| 维度 | 旧（消息遍历） | 新（session.get） |
|------|---------------|-------------------|
| 时间复杂度 | O(n)，n ≤ 100 | O(1) |
| 内存 | 读取整个消息数组 | 读取一个小对象 |
| 响应式触发 | `message.updated` → 重算 | 同一事件，同一时机 |
| 数据完整性 | ≤ 100 条消息 | 全部消息（数据库聚合） |

## 上线

1. **无需配置变更** —— 插件自动优先使用 `session.get()`。
2. **存量用户无需迁移** —— 旧配置文件和 timeline 日志不受影响。
3. **重启 OpenCode** 加载更新后的插件代码。
4. **验证**：打开一个超过 100 条消息的会话，侧边栏数据应与数据库聚合值一致。

## 相关链接

- [anomalyco/opencode#31513] — v1 TUI sync 硬编码 limit:100
- [anomalyco/opencode#26861] — 基于游标的分页 PR（待合入）
- [anomalyco/opencode#6548] — 分页消息加载功能请求

[issue #31513]: https://github.com/anomalyco/opencode/issues/31513
[anomalyco/opencode#31513]: https://github.com/anomalyco/opencode/issues/31513
[anomalyco/opencode#26861]: https://github.com/anomalyco/opencode/pull/26861
[anomalyco/opencode#6548]: https://github.com/anomalyco/opencode/issues/6548
