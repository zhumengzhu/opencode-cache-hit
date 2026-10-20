# 设计说明

面向**维护本插件的开发者**：说明数据从哪来、何时重算、与 visual-cache 的边界。使用与配置见 [README.zh-CN.md](../../README.zh-CN.md)。

## 与 opencode-visual-cache 的关系

本插件是**独立项目**，并非 visual-cache 官方维护。实现上**大量借鉴**了 [opencode-visual-cache](https://www.npmjs.com/package/opencode-visual-cache) 的思路，包括但不限于：

- **侧栏面板布局**（`src/tui-panel/`）：边框、命中率条、折叠段、主题色映射等页面骨架
- **布局**：主 session 块始终显示；有子 agent 时增加可折叠的 **Agents** 段
- **命中率口径**：会话累计与 visual-cache 的 `cache.read / (cache.read + input)` 约定对齐

**分工**：visual-cache 侧重主 session **上下文 / token 分布预估**；cache-hit 侧重**按轮次指标、成本与子 agent 汇总**。推荐两个插件一起装。

用法见 [文档索引](../README.md)。

## 产品边界

```mermaid
flowchart TB
  subgraph ours [opencode-cache-hit]
    DISC[子 session 发现]
    AGG[筛选后的消息级与 lineage 聚合]
    UI[Cache Hit 侧边栏]
  end
  subgraph ref [opencode-visual-cache 参考]
    EST[上下文 token 预估]
    VCUI[Token Cache 侧边栏]
  end
  OC[OpenCode session / messages API] --> DISC
  OC --> AGG
  AGG --> UI
  OC -.->|只读参考 UI 语言| EST
  EST -.-> VCUI
```

| 角色 | 职责 |
|------|------|
| **cache-hit** | 子 agent 发现与汇总；主/子 session 的 cache、token、成本；可独立演进 |
| **visual-cache** | 主 session 上下文与预估；非本仓库维护 |
| **默认** | 主 session + 可折叠 **Agents**（子 session 合计） |

## 成本模型

- OpenCode：`msg.cost` = 按 `opencode.json` 中**美元**单价对 assistant 消息累加。
- 插件：`createCostFormatter(loadPluginConfig().cost)`；默认 `costUnit: USD` → `currency: CNY`，`rate: 6.77`。
- 配置路径：优先 `~/.config/opencode/cache-hit.json`，兜底插件根目录 `cache-hit.config.json`。缺省见 `plugin-config.ts` 的 `DEFAULT_PLUGIN_CONFIG`。
- 交互指标排除 `summary: true` 或 `agent: "compaction"` 的消息。
- 主 session lineage 指标按 `providerID:modelID` 对直接历史消息分桶；缺少元数据的消息进入 `unknown` 分桶。
- 混合模型的费用、读取节省、写入溢价和缓存净值使用每条消息自己的 provider/model 单价。如果有消息缺少单价，费用行保留 OpenCode 的混合费用。

## 动态计价（`dynamicPricing`）

两个正交的价格维度决定侧边栏显示的有效百万 token 单价：

- **上下文档位**：读取 `state.provider` 的运行时 cost 档位（`tiers[]` / `experimentalOver200K`，内部归一化为上下文档并携带自身阈值）；按总上下文（`input + cacheRead`）与阈值选档（模型级配置 > 运行时档位阈值 > 全局 > 200k）。GPT-5.6 类模型零配置生效。
- **时段档**：`schedule`（默认 DeepSeek 高峰为北京时间**周一至周五** 09:00-12:00 / 14:00-18:00，其余含周末为空闲）+ 单模型 `multipliers`（默认 DeepSeek 空闲 0.5×）或绝对价 `levels`（时段未命中回退静态价；`enabled: false` 恢复完全静态计价）。窗口可带可选 `days`（ISO 1=周一…7=周日；省略 = 每天）；`windows` 为空的 level 即「**回退档**」（默认 `offpeak` 兜底周末等一切未覆盖时刻）。跨天窗口锚定开启日（`days` 日承载晚间段，次日承载早晨段）。

查找回退链（`src/dynamic-pricing/lookup.ts`）：显式 `levels` → 显式 `multipliers` → 内置 DeepSeek 默认 → `state.provider` 静态价。

- `src/dynamic-pricing/schedule.ts`：基于时区的窗口匹配（`Intl.DateTimeFormat`，含 `tzWeekdayOf` 星期判定），`nextBoundaryMs` 星期感知地驱动 `use-cache-hit-metrics.ts` 中 `setTimeout` 精确刷新（周五 18:00 后直达周一 09:00，周末不轮询）——无需轮询。
- 会话成本重算（`src/dynamic-pricing/recompute.ts`）：逐消息用 `msg.time.created` 选时段、总上下文（`input + cacheRead`）选上下文档；`tokens.input` 不含缓存，缓存命中部分按 `cacheReadRate` 单独计费。
- 子 agent：`session.list` 条目携带 `time.created`（`src/session-list.ts` → `child-session-sync.ts`），可按子会话创建时刻重算成本（`recomputeSubAgentCost`）。
- 时间轴看板（`scripts/timeline-dashboard.ts`）：离线重算读取 `~/.config/opencode/opencode.json`（JSONC 感知）的 provider 单价，逐条向 `LlmCallRecord` 注入 `dynCost`（`≈` 展示并计入图表/合计）。

## 运行时架构

```mermaid
sequenceDiagram
  participant Slot as sidebar_content slot
  participant Host as sidebar-host
  participant API as OpenCode API
  participant W as widget + metrics

  Slot->>Host: sessionId, display, api
  Host->>API: session.list → childIds
  API-->>Host: message { info } / tick
  Host->>Host: refreshTick++, timeline.handleMessage(info)
  Host->>API: session.messages(sid, limit=10000) → 主 session 指标历史
  Host->>API: session.get(cid) / session.messages(cid) → 子 session 聚合
  Host->>Host: TUI 镜像 → 流式速度与 TTFT
  Host->>W: main, messages, subAgents
  W->>W: aggregate / format / TuiPanel
```

### 模块职责

| 文件 | 职责 |
|------|------|
| `plugin.tsx` | 双入口：V1 `tui(api)` + V2 `setup(ctx)`；加载配置与 `formatCost` |
| `types.ts` | 两版本共用的内部 `TuiApi` / `TuiEvent` 契约 |
| `v1-map.ts` | V1 旧式 `{ properties }` 事件与 SDK 线格式（`{ path, query }` / `{ data }` 信封）→ 内部契约（纯函数，有单测） |
| `v2/adapter.ts` | V2 context/事件 → 内部契约 |
| `sidebar-host.tsx` | 绑定 `sessionId`；主 session 直接历史；`mainSnap` / `mainMessages` / `subAgentList`；`refreshTick` + message/tick 事件 |
| `widget.tsx` | `sessionId` 非空则渲染面板；`hasData` 否则 noData |
| `use-cache-hit-metrics.ts` | Hit 条、趋势、Combined Hit、hasData |
| `main-session-view.tsx` / `agents-view.tsx` | 业务区块 |
| `cache-hit-rows.tsx` | Detail 区共用 token 行 |
| `stats.ts` | 纯函数聚合（无 UI） |
| `session-messages.ts` | 基于类型化 client 契约的主 session 历史加载器与数据源状态 |
| `lineage-stats.ts` | provider/model lineage 分桶与当前 lineage 选择 |
| `pricing.ts` | 按消息计算混合模型缓存价值 |
| `cache-ttl.ts` / `cache-ttl-view.tsx` | 按 lineage 独立计算缓存 TTL |
| `session-list.ts` | `session.list` 响应解析、`childSessionIdsForParent` |
| `format-cost.ts` / `format-tokens.ts` / `format-cache-ui.ts` | 展示格式化（**不含** `computeHitBarWidth`，其在 `tui-panel/layout.ts`） |
| `format-model.ts` | 子 agent 行 label（`formatSubAgentLabel`）与厂商品牌色（`modelRowColor`） |
| `message-timing.ts` | SDK 时间字段辅助 |
| `token-speed.ts` / `streaming-state.ts` | 速度计算与流式 phase 状态机 |
| `timeline/` | 按次 JSONL（`records` / `writer` / `collector`） |
| `plugin-config.ts` / `load-config.ts` | 配置归一化与默认值 |

### 版本支持

同一个包通过 `src/plugin.tsx` 的单一默认导出同时服务 OpenCode 1 和 2：

| 版本 | 入口 | 插槽 |
|------|------|------|
| V1 | `tui(api)` | `sidebar_content`（`order: 56`） |
| V2 | `setup(ctx)` | `sidebar.content` |

- V2 的 CLI loader 调用 `setup(ctx)` 并忽略 `tui`；V1 的 TUI loader 调用 `tui(api)` 并忽略 `setup`。
- `exports["."]` 是空的 V2 server 入口（`src/v2/server.ts`），使包能从 `opencode.json` 加载，V2 才会报告 `features.tui` 并挂载侧边栏。
- `src/v2/adapter.ts` 把 V2 context 映射为内部 `TuiApi` / `TuiEvent` 契约（`src/types.ts`）；纯映射逻辑在 `src/v2/map.ts`，无需运行中的 OpenCode 即可单测。V1 的旧式事件载荷在 `src/v1-map.ts` 映射到同一契约。
- V2 没有消息级的流事件：一个 step 就是一条 assistant 消息，因此 adapter 用 `session.step.started` 加上终止事件 `session.step.ended` / `session.step.failed` 合成 `message` 事件（store 行用于补上 compaction 的 `summary` 标记）。
- V2 插件运行在 OpenCode 内置的 OpenTUI 上（当前版本为 `0.6.6`）。`@opentui/*` peers 保持 `>=0.6.6`：旧版本会在 OpenTUI 的 `globalThis` 环境变量注册表中以冲突类型注册 `OPENTUI_FORCE_WCWIDTH`，导致插件加载中止。
- 本地目录安装会解析 `<dir>/server` / `<dir>/tui`，而不是 `package.json` exports；根目录的 `server.ts` / `tui.ts` 垫片分别转发到空的 server 入口和已构建的 bundle。按包名安装时仍走 `exports`。
- 自 1.0.0 起仅 V2 路径获得官方支持与测试；V1 路径仅尽力兼容。

### 事件映射

内部契约（`src/types.ts` 的 `TuiEvent`）与版本无关，翻译各自留在入口：

| 内部事件 | V1 来源（`tui(api)`） | V2 来源（`setup(ctx)`） | 说明 |
|----------|----------------------|-------------------------|------|
| `part` | `message.part.updated`（`properties.part`） | `session.text.started`、`session.reasoning.started`、`session.tool.input.started`、`session.tool.success` / `failed` | V2 把一次 tool 调用拆成多个事件（callID/name/start/end）；只有 V1 会报 `state.status = "pending"`（纯 tool-call 的 TTFT 依赖它） |
| `message` | `message.updated`（`properties.info`） | `session.step.started` + `session.step.ended` / `session.step.failed` | 一个 step 就是一条 assistant 消息；compaction 的 `summary` 标记由 store 行补上。失败的 step 没有 `finish`，按 V2 的投影记为 `"error"` |
| `delta` | `message.part.delta`（`{ messageID, field }`） | `session.text.delta`、`session.reasoning.delta` | 首个 chunk 提供 TUI 侧 TTFT 兜底与 ITL 间隔；V1 的 `field: "tool"` delta 有意丢弃（tool part 自带时间戳） |
| `tick` | 无 `info` 的 `message.updated` | `session.usage.updated` | 只做刷新（重读 `session.get()`），不带消息 |

- V2 没有消息级的流事件；`session.text.ended` / `session.reasoning.ended` 用权威全文覆盖 adapter parts 缓存里累积的 delta。
- 宿主事件面是 `src/v2/adapter.ts` 里的一张表，表里每个名字都必须在 `tests/fixtures/v2-events.ts` 有一条用例。用例按顺序投递宿主 payload，并逐字段钉住它必须产生的内部事件——所以 adapter 换了「读哪个 payload 字段」（比如 `created` → `data.timestamp`）该用例就会红。这些 payload 是**假设而非抓包**：宿主自己写的 timeline 能确认 adapter 依赖的四个字段（`created`、delta 的消息身份、tool 的 `id`/`name`、`step.ended` 的 `assistantMessageID`），事件名则通过对已安装的 OpenCode 2.0.32 CLI 二进制做字符串扫描确认（下表每个名字都存在，而 SDK 总线 schema 的 `session.next.*` 命名在那里面 0 命中）。`step.started` 的元数据字段与失败/删除类事件仍未经观测确认。真实抓包应当覆盖它们，它们本身不构成关于宿主的证据。
- `session.message.content.updated` 在宿主里存在（名字在 2.0.32 二进制里），但 adapter **不**订阅它。它只在回放时携带一份全量内容快照，处理它也只能刷新该消息的 part 时间戳；在抓包证明它确实会触发之前，缺这个 handler 最多让回放后的 TTFT 缺失，不影响正确性。
- `api.state.part()` 在 V1 是宿主 API；V2 由 adapter 用有界缓存（200 条消息）提供同样的视图。
- V2 的历史读取走生成的客户端（`message.list` 按 200 条一页、用 `cursor` 翻到调用方上限）。客户端缺失或第一页失败时回退到 TUI store 窗口；该窗口由宿主一页一页填充（当前构建是 20 条），所以非空窗口一律报告为不完整——插件契约没有 cursor，行数也不是可用代理。空窗口会先等那一次在途的 `message.sync`（sync 落地后没有任何回读），所以空结果只代表"会话确实为空"（`complete`）或"同步失败"（`incomplete`）。
- 插件热重载会销毁 sidebar host 与 adapter，进行中消息的 part 事件因此丢给已销毁的 tracker。所以 `step.ended` 在发出 `message` 之前，会从该消息的 store 行重放带时间的 part（见 [ttft-hybrid.md § Store 回放](./ttft-hybrid.md)）；text part 在 store 里无时间戳，以 text 开头的回复无法用这条路径恢复 TTFT（只有首个内容 part 可以播下它）。
- `message` 一定带 `sessionID`：V1 从 info 里取，V2 从 step 事件里取。

### TUI 面板框架（`src/tui-panel/`）

可复用的 visual-cache **页面**骨架（布局、配色、折叠段），**不含** skills 预估、slash、kv 等业务。

| 模块 | 职责 |
|------|------|
| `layout.ts` | 视觉列宽、`justifyRow`、`computeHitBarWidth`、分隔线 |
| `palette.ts` | 主题色 → 面板调色板；`toneBrandHex` 用于深色面板上的厂商色 |
| `use-panel-layout.ts` | `createPanelLayout`（测宽）、`createSectionFold` |
| `components.tsx` | `TuiPanel`、`TuiHitRow`、`TuiMetricRow`（`labelFg` / `valueFg` 分段上色）等（需 `@opentui/solid`） |
| `index.ts` | 对外 barrel |

纯逻辑模块（如 `use-cache-hit-metrics`）应从 `layout.ts` / `palette.ts` 直接 import，避免经 `index.ts` 拉入 JSX（便于 `bun test` 冒烟）。

用法见 [src/tui-panel/README.zh-CN.md](../../src/tui-panel/README.zh-CN.md)。

## 子 agent 发现

实现：`src/child-session-sync.ts`（`sidebar-host` 调用）。

```mermaid
flowchart TD
  A[sessionId 变化] --> B[resetForParentChange]
  B --> C[loadChildren 立即 session.list]
  E[message 事件 任意会话] --> R[refreshTick++]
  E --> F{sessionID !== parent?}
  F -->|是| G[debounce 200ms]
  G --> C2[loadChildren 覆盖 childIds]
  F -->|否| R
  C --> H[childSessionIdsForParent]
  C2 --> H
  H --> I["session.get 聚合 + messages 兜底"]
```

- **唯一来源**：`childIds` 始终由 `session.list` 结果**覆盖**写入，不再 `session.get` + 追加（避免漏发现、僵尸 id）。
- **竞态**：`listGen` 在 parent 切换时递增；回调校验 generation 与 `parentId` 未变。
- **流式**：外国 session 的 `message` 事件很密，用 `CHILD_LIST_DEBOUNCE_MS`（200ms）合并 list 请求。
- **一层子 session**：`parentID === sid` 的直接子节点；嵌套子 agent 见「未来方向」。
- **子 session 数据**：`session.get(cid)` → `aggregateFromSessionObject`（主路径）；不可用时降级到 `messages(cid)` → `aggregateSessionFromMessages`。若 session 聚合缺少 model/provider 元数据，从 messages 末尾补齐（`withModelFallback`）。

### Agents 合计语义（实现正确，勿与「全场总账」混淆）

| 范围 | 是否计入 Agents 段 |
|------|-------------------|
| 各子 session 的 assistant 消息 | 是（`aggregateSubAgents`） |
| 主 session 的 assistant 消息 | **否**（即使在 auto 下仍会计入 `mainSnap`，仅 UI 隐藏主块） |

主 session 若仍有编排类调用，其 token/费用不会出现在 Agents 合计中；UI 通过 `agentsScopeHint`（「仅子会话 / sub-sessions」）标明。与 visual-cache 对主 session 的展示互补，不是漏算 bug。

### 子 session 行展示

多个子 session 并行时，**Agents** 段下每个有活动的子 session 一行（见截图 `docs/assets/cache-hit-panel.v4.png`）。

| 方面 | 行为 |
|------|------|
| **目的** | 在窄侧栏中辨认「哪条子 session、用的什么模型」 |
| **Label 文案** | `{displayModelName} …{sessionIdTail}` — 与主块 **Model** 行同源（`shortModelName` + 去日期尾）；**不做**语义缩写（如 `ds-flash`） |
| **截断** | `gauge` ≈ 实测面板宽 − 边框 gutter；label 预算再减去右侧 cost/tok。优先保留**模型前缀**；先缩短 ID 尾（6 → 4 字符） |
| **Label 颜色** | 厂商近似品牌色（`MODEL_BRAND_HEX`，经 `toneBrandHex` 压低饱和度以适配深色终端） |
| **金额颜色** | `muted`，与 label 分开，避免与 Agents 合计 **Cost** 的 `success` 绿色混淆 |
| **Family 匹配** | `MODEL_FAMILY_RULES`（claude、deepseek、openai、gemini、qwen、glm、kimi、minimax、grok、mimo、meta、mistral）；模型 slug 与 `providerID` **大小写不敏感** |
| **未知模型** | 稳定 hash → 中性 fallback 色（不用 `success`） |
| **配置** | v1 无 `cache-hit.json` 项；在代码中扩展 `MODEL_FAMILY_RULES` / `MODEL_BRAND_HEX` |

实现：`agents-view.tsx` 调用 `formatSubAgentLabel`、`modelRowColor`；`TuiMetricRow` 使用 `labelFg` / `valueFg`。

## 聚合与刷新

### 何时重算

| 数据 | 触发方式 |
|------|----------|
| 主 session 指标历史 | 直接请求 `session.messages(sid, limit=10000)`；回退到 TUI 镜像——镜像满 100 条时标记 `unavailable`，直接历史达 10,000 上限时标记 `capped` |
| 主 session 实时消息 | `createMemo` 读取 `refreshTick` + TUI 镜像，用于流式速度和 TTFT |
| 主 session snapshot 兜底 | `session.get?.(sid)` 聚合值，再回退到 TUI 镜像 |
| 子 agent 列表内容 | `refreshTick` + `childIds` → 每个 child 的 `session.get?.(cid)`；fallback `messages(cid)` |
| 子 agent id 集合 | `session.list` 完成回调 / `message` 发现新 child |

主 session 显式订阅 `message` / `tick`（在 `sidebar-host`）：每次事件 `refreshTick++`，触发相关 memo 重算。主指标总量优先 DB 级 `session.get` 聚合（完整、不受上限影响）；lineage 分桶使用直接历史。流式速度和 TTFT 使用 TUI 镜像；子 session 总量优先使用 `session.get()`。

### session.get() 可用性

`session.get()` 提供数据库级聚合（不受 100 条消息限制），但在 [opencode#26644](https://github.com/anomalyco/opencode/pull/26644)（2026-05-12）才加入。在此之前 fork 的分支（含 MiMo-Code）缺少该方法。主指标路径优先使用 DB 级 `session.get` 聚合；缺失或为空时再直接请求最多 10,000 条 session 消息。请求失败且镜像已满 100 条时标记 `unavailable`，返回历史达 10,000 上限时标记 `capped`。镜像每次最多包含最近 100 条消息。

### 累加规则

- **不是**只在「最后一轮」算一次；session 内每条符合条件的 `role === assistant` 消息都进入累加。
- **流式中**：同一条 message 的 `tokens` 可能多次变化；每次 `message` 事件后重算。
- `reasoning` token **不参与**命中率分母。
- `summary: true` 和 `agent: "compaction"` 的 assistant：从交互总量、速度、费用、趋势和 TTL 选择中排除。

### 侧边栏可见性（避免与 README 混淆）

```mermaid
flowchart TD
  M{是否子 session?<br/>session.parentID 存在}
  M -->|是| NC[slot 从不被调用]
  M -->|否| V{是否可见?<br/>已手动打开，或宽于 120 列<br/>且状态为 auto}
  V -->|否| NC
  V -->|是| S{sessionId 非空?}
  S -->|否| H[不渲染面板]
  S -->|是| P[渲染 TuiPanel]
  P --> D{hasData?<br/>主或子有统计}
  D -->|否| ND[noData]
  D -->|是| MAIN[Main / Detail / Model / Models]
  D -->|有子 agent| AG[Agents 段（可折叠）]
```

| 概念 | 实现 |
|------|------|
| 侧边栏**是否挂载** | 不归本插件管：只有会话无 `parentID`，且「用户手动打开」或「终端宽于 120 列且持久化状态为 `auto`（非 `hide`）」时 OpenCode 才渲染侧边栏；否则本插件 slot 从不被调用（见 README「兼容性」） |
| 整个面板 | `widget.tsx`：`Show when={sessionId().length > 0}` |
| 有无可显示数据 | `hasData` = `lineages.length > 0 \|\| subs.length > 0` |
| 主 session **区块** | 始终渲染（Hit / Detail / Model） |
| **Agents 段** | `subs.length > 0` 时显示，各段可独立折叠 |
| `sidebarShouldShow` | `mainSessionHasStats(main) \|\| subs.length > 0`（测试用） |

## 命中率（当前实现）

**当前 lineage 累计（Total Hit）**

```
对当前 provider/model lineage 中符合条件的 assistant 消息累加 input、cache.read
→ cacheRead / (cacheRead + input)
```

可折叠的 **Models** 段按最近 lineage 展示独立命中率与调用次数。混合 session 的旧聚合仍可作为费用回退使用，但不会标记为当前模型的 Total Hit。

**顶栏 Hit（单轮 + 趋势）**

- `computePerCallHitTrend(messages)`：每条符合条件的 assistant 一轮命中率；跳过 summary 与 compaction。
- lineage 切换后显示 `switch`，新 lineage 的第一条调用显示 `warming`；只有同 lineage 前序调用存在时才显示 ↑ / ↓ / `-`。

**单价与节省（Pricing & Saved）**

- Provider 单价从 `api.state.provider`（SDK 运行时数据）读取，非硬编码。
- `computePricing` 根据当前 lineage 的 `providerID` + `modelID` 查找百万 token 单价。
- `computeSessionPricing` 按消息累加输入、缓存读、缓存写和输出单价；Detail 段展示读取节省、写入溢价和缓存净值。
- 动态规则生效且所有消息都有单价时，主 session 成本使用逐消息重算结果；否则使用 OpenCode 的混合消息成本。
- Agents 段：**Saved** 行汇总所有子 session 的节省金额（`computeSubsSaved`）。
- 单价不可用或节省为零时，所有 pricing 行隐藏。

## 时间字段（OpenCode SDK v2）

| 来源 | 字段 | 说明 |
|------|------|------|
| `AssistantMessage` | `time.created` | ms epoch，消息创建 |
| `AssistantMessage` | `time.completed?` | ms epoch，本轮 LLM 结束；流式中常缺失 |
| `ReasoningPart` | `time.start` / `time.end?` | thought 片段 |
| `ToolStateCompleted` | `time.start` / `time.end` | 工具执行 |
| `StepFinishPart` | （无 time） | 有 tokens/cost，时间回退到 message |

按次日志（**Phase 1 已实现**，默认关闭）：以 `AssistantMessage` 为一行，用 `created` + `completed` 排序；按**本地日历日**单文件 JSONL 落盘。实现：`src/timeline/`、`src/message-timing.ts`。路径、轮转与清理见 **[timeline.md](./timeline.md)**（本文档同目录）§ 存储、§ 轮转与清理。

## 测试策略

| 层级 | 文件 | 作用 |
|------|------|------|
| 单元 | `tests/*.test.ts` | `stats`、`format-*`、`tui-panel/layout` 等纯函数 |
| 冒烟 | `tests/module-load.test.ts` | `import` 消费者模块，捕获「符号已迁移但 import 路径未改」 |
| 运行时 | OpenCode 日志 | JSX / peer（`@opentui/solid`）加载错误；本地 `bun test` 不覆盖 |

重构移动 `export` 后：`rg` 旧符号名 + `bun test`。

## 未来方向（未实现）

| 方向 | 说明 | 设计文档 |
|------|------|----------|
| 按次 LLM + 时间轴 / JSONL | **Phase 1 已实现**（`src/timeline/`，默认关闭） | [timeline.md](./timeline.md) |
| 指标切换 | 累计 / 最近 N 轮 / 滑动窗口；与时间轴 Phase 3 联动 | timeline.md § Phase 3 |
| 子 agent | 递归子 session、按 agent 类型过滤 | timeline.md § 风险；侧栏另议 |

实现日志时使用 `message` 事件直接驱动的 `handleMessage()`；落盘异步、勿阻塞 TUI（见 timeline.md）。

## 插件缓存

| 安装 | 更新 |
|------|------|
| 本地路径 | 重启 OpenCode |
| npm 包 | 重启；必要时删除 `~/.cache/opencode/packages/opencode-cache-hit@latest` |
