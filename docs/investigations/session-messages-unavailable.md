# Investigate: `loadSessionMessages` unavailable root cause

**Status**: 未定位（open）

## 问题

用户环境（opencode 1.18.23）中，`src/session-messages.ts` 的 `loadSessionMessages`
对 `client.session.messages({ path: { id }, query: { directory, limit } })` 请求失败，
回退到 `unavailable` 状态（面板显示 `* history truncated`，当 mirror 满 100 条时）。

该问题的**显示语义**已修复（mirror 未满 100 条视为完整、不误报），
但**根本原因未定位**——history API 在用户环境不可用，影响大于 100 条消息的会话
（只能回退到最近 100 条 mirror 数据，指标不完整）。

## 已确认的事实

1. **SDK 签名正确**：`@opencode-ai/plugin@1.15.13` 的 `TuiPluginApi.client: OpencodeClient`，
   `session.messages(options: Options<SessionMessagesData>)` 签名与插件调用一致
   （`{ path: { id }, query: { directory, limit } }` → `Array<{ info, parts }>`）。
2. **binary 路由存在**：opencode 1.18.23 binary 内含 `/session/{id}/message` 路由定义。
3. **外部探测矛盾**：opencode 进程监听端口（127.0.0.1:42446/41078/41198 等）对
   `/session/{id}/message`（含真实 session id）返回 `{"error":"not found"}`；
   `/` 返回 `{"skills":[...]}`；WebSocket 握手失败。
   → 怀疑 TUI 注入的 client 走**进程内 RPC**，外部 HTTP 探测无法复现真实调用路径。
4. **诊断日志已移除**：此前在 `loadSessionMessages` 失败分支添加的
   `console.error` + 文件 diag 日志已回退（仅用于一次性定位，未保留）。

## 待办（定位根因）

- [ ] 在 `loadSessionMessages` 的 catch / malformed 分支临时加 `console.error`，
      输出 reason + 原始响应（`raw` 的 JSON 摘要），重启后从 opencode stderr 确认：
      - `missing-client`：注入 client 无 `session.messages` 方法（签名/版本不匹配）
      - `request-failed`：调用抛错（HTTP 错误 / 进程内 RPC 异常）
      - `malformed-response`：返回了非预期格式（`{"error":"not found"}` 之类）
- [ ] 确认 opencode 1.18.23 的 TUI 注入 client 实际 baseUrl / transport
      （是否 WebSocket / 进程内 RPC，非本地 HTTP）
- [ ] 对比 opencode 1.18.23 与 `@opencode-ai/sdk@1.15.13` 的
      `SessionMessagesData` 路由/字段是否漂移（`/session/{id}/message` 是否改名或改参）
- [ ] 若为版本漂移：升级插件 peer 依赖的 `@opencode-ai/plugin` / `@opencode-ai/sdk`，
      或改用 `state.session.messages`（TUI state，同步数组，受 100 条限制）作为替代

## 相关文件

- `src/session-messages.ts` — `loadSessionMessages` / `fallbackResult` / `TUI_MIRROR_LIMIT`
- `src/sidebar-host.tsx` — `loadHistory` 调用方
- `src/use-cache-hit-metrics.ts` — `metricInput` / `main`（DB 聚合回退已缓解数据不完整）
