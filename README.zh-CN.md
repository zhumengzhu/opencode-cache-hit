# opencode-cache-hit

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

OpenCode **TUI 侧边栏插件**：展示 prompt cache 命中率、token 用量与成本；**主 session + 子 agent** 同屏汇总（默认独立使用）。可选与 [opencode-visual-cache](https://www.npmjs.com/package/opencode-visual-cache) 共存。

**语言：** [English](README.md) · 简体中文（本页）· [文档索引](docs/README.md)

![Cache Hit 侧边栏](docs/assets/cache-hit-panel.v4.zh.png)

![Cache Hit 仪表盘](docs/assets/cache-hit-dashboard.png)

## 项目意图

[opencode-visual-cache](https://www.npmjs.com/package/opencode-visual-cache) 已经很好地覆盖**主 session** 的 cache 可视化（Token 分布、节省估算、斜杠命令配置等）。本项目的存在是因为其范围无法满足以下几种实际工作流：

1. **子 agent 可观测性** — OpenCode 会为 Task / explore agent 创建子 session；你需要**汇总**各子会话的 cache、token 和费用，而非仅主线程。
2. **一场对话一块面板** — 主 session 的命中率/token/费用**与**可折叠 **Agents** 段（子 agent 汇总）同屏展示。
3. **离开 TUI 的分析** — 可选 **timeline JSONL**（每 assistant 轮次），用于绘图、jq 对账，无需扒取平台日志。
4. **可复用 TUI 组件** — `src/tui-panel/` 被提取出来，方便其他侧边栏插件复用与 visual-cache 相同的布局语言。

后续规划（侧栏 Timeline 段、指标窗口、嵌套子 agent）见 [docs/zh-CN/timeline.md](docs/zh-CN/timeline.md) 和 [docs/zh-CN/design.md](docs/zh-CN/design.md)。

## 致谢

本插件**并非** opencode-visual-cache 的一部分。其侧栏布局、面板组件（`src/tui-panel/`）及共存策略**大量借鉴**自 [opencode-visual-cache](https://www.npmjs.com/package/opencode-visual-cache)。visual-cache 关注**主 session 上下文 / token 分布**；cache-hit 关注**按轮次指标和子 agent 汇总**。

**缓存存活时间**功能（显示已缓存时长 + 颜色状态）借鉴自 [opencode-cache-timer](https://github.com/nero-sensei/opencode-cache-timer)（作者：nero-sensei）。原插件提供独立侧边栏倒计时；本插件将该概念直接集成到 cache-hit 面板中。

**工具调用 TTFT 回退**（当无 text/reasoning 流式 part 时，以 `tool.pending` 作为首次响应时间）借鉴自 [oc-tps](https://github.com/Tarquinen/oc-tps)（作者：Tarquinen），该插件率先在 OpenCode 生态中正确处理了 `finish=tool-calls` 的 TTFT 计量。

## 功能一览

- **命中率**：会话累计 + **单轮**命中率与趋势（↑ / ↓ / `-`）
- **Token 明细**：缓存读 / 写 / 未命中 / 输出（对齐 visual-cache 的行布局）
- **费用**：多币种配置（`USD` / `CNY` / `EUR` / `GBP` / `JPY`）；从 provider 配置读取百万 token 单价及缓存节省；**动态计价**：支持按时段（DeepSeek 高峰/空闲）与按上下文分档（`context_over_200k`，如 GPT-5.6）
- **子 agent**：**Agents** 段仅汇总**子 session**（UI 有范围标注）；每行显示模型名 + session ID 后缀，**label 按厂商近似品牌色**，金额为灰色
- **主 + Agents**：主块始终显示；有子 agent 时出现可折叠的 **Agents** 段
- **可折叠段落**：Detail / Model（以及 Agents）；主题自适应的命中率条颜色
- **国际化**：`display.lang` — `en` / `zh` / `auto`（配置文件，暂无斜杠命令）
- **时间轴**（可选）：按天 JSONL，每 assistant 轮次一条，可用于 `jq` / 脚本分析

## 与 [opencode-visual-cache](https://www.npmjs.com/package/opencode-visual-cache) 对比

**默认独立使用**（主 session + 子 agent 同面板）。布局借鉴 visual-cache，**不依赖**该插件。

| | visual-cache | opencode-cache-hit |
|---|----------------|-------------------|
| 主 session 上下文 / token **分布**估算 | 有 | 无（使用 visual-cache） |
| 按角色 token 分布（system / tools / …） | 有 | 无 |
| 缓存**节省**估算 | 有 | 有（从 provider 定价计算） |
| 模型**百万 token** 单价 | 有 | 有（从 SDK provider 配置读取） |
| **斜杠命令**（`/cache-lang`, `/cache-currency`, …） | 有 | 仅配置文件 |
| 折叠状态持久化（`api.kv`） | 有 | 仅内存（不持久） |
| **已加载 skill** 面板 | 有 | 无 |
| **子 agent** 会话汇总 | 无 | **有** |
| **合并**命中率（主 + 子） | 无 | 有子 agent 时显示 |
| 按次 **JSONL** 导出 | 无 | 可选 `timeline` |

## 快速开始

### 方式 A：OpenCode 命令面板（推荐）

`Ctrl+P` → 输入 **install plugin** → 按 `Tab` 切换范围为 **global**（默认是 local）→ 输入 `opencode-cache-hit@latest` → 回车。

全局插件安装到 `~/.cache/opencode/packages/opencode-cache-hit@latest/`。在 `~/.config/opencode/cache-hit.json` 创建配置：

### 方式 B：手动

创建或编辑 `~/.config/opencode/tui.json` / `tui.jsonc`：

```jsonc
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["opencode-cache-hit@latest"]
}
```

本地开发：将 npm 名称替换为 `"./plugins/opencode-cache-hit"`。

复制 `cache-hit.config.example.json` → `~/.config/opencode/cache-hit.json`（推荐）或放在插件根目录旁。更改插件代码或配置后**重启 OpenCode**。

| 安装方式 | 更新后 |
|----------|--------|
| 本地 `./plugins/...` | 完全重启 |
| npm `@latest` | 重启；如果 UI 未更新，删除 `~/.cache/opencode/packages/opencode-cache-hit@latest` |

加载失败：`~/.local/share/opencode/log/`（搜索 `cache-hit` 或 `failed to load tui plugin`）。

## 配置

配置文件支持 JSONC（行注释、块注释、尾逗号）。`cache-hit.config.example.json` 保持严格 JSON，便于 jq、编辑器等外部工具使用。

### 成本展示（USD → CNY 示例）

```json
{
  "currency": "CNY",
  "costUnit": "USD",
  "rate": 6.77
}
```

| 字段 | 含义 |
|-------|-------|
| `costUnit` | `msg.cost` 的币种（通常为 `USD`） |
| `currency` | 侧边栏展示币种 |
| `rate` | `costUnit` → `currency` 的汇率 |

`rate` 是**手动维护的快照值**——示例中的 `6.77` 是当时 USD→CNY 的汇率，不会自动更新。省略 `rate` 时回落到内置默认值 6.77，因此只有在展示非 USD 币种且希望汇率准确时才需要设置（可到 [Xe](https://www.xe.com/currencyconverter/)、[Wise](https://wise.com/currency-converter) 或 [OANDA](https://www.oanda.com/currency-converter/) 查询最新汇率）。当无需换算时使用 `"currency": "USD", "costUnit": "USD"`。

支持的展示币种：`USD`、`CNY`、`EUR`、`GBP`、`JPY`（见 `cache-hit.config.example.json`）。暂未实现类似 visual-cache 的 `/cache-currency` 斜杠命令。

### 展示（`display`）

```json
"display": {
  "lang": "en",
  "panelBorder": true,
  "showSpeed": true,
  "speedUnit": "tpot"
}
```

| 字段 | 默认 | 含义 |
|-------|---------|------|
| `lang` | `"en"` | `en` / `zh` / `auto` |
| `panelBorder` | `true` | 外框与内边距 |
| `mainHitLabel` | （i18n） | 可选，覆盖 Hit 行标签 |
| `showSpeed` | `true` | 显示/隐藏速度区块 |
| `speedUnit` | `"tpot"` | `"tpot"`（ms/tok）或 `"tps"`（tok/s） |

**Agents** 段仅汇总**子 session**，不含主 session（详见 `agentsScopeHint`）。主 session 指标始终在上方块中；折叠 **Agents** 可节省空间。各子 session 行与主块 **Model** 行同源模型名（侧栏窄时会截断）；详见 [docs/zh-CN/design.md](docs/zh-CN/design.md)「子 session 行展示」。

### 时间轴日志（`timeline`，默认关闭）

每 assistant 轮次 → JSONL（tokens、cache、cost、TTFT，各工具 `toolDurations`）。详见 [docs/zh-CN/timeline.md](docs/zh-CN/timeline.md)。

```json
"timeline": {
  "enabled": true,
  "dir": "",
  "rotateMaxBytes": 16777216,
  "retainRotated": 5,
  "maxAgeDays": 30,
  "maxLogFiles": 20,
  "toolSummary": { "allTools": true, "bash": false }
}
```

| 字段 | 默认 | 含义 |
|-------|---------|-------|
| `enabled` | `false` | 总开关 |
| `toolSummary` | `{ allTools: true, bash: false }` | 控制隐私敏感的 `toolDurations[].summary` 字段（默认安全：bash 关闭）。可用 `true`/`false` 控制全部工具，或 `{ allTools, bash?, … }` 按工具控制。耗时（`tool`、`durationMs`）始终记录。详见 [docs/zh-CN/timeline.md](docs/zh-CN/timeline.md) |
| `dir` | `""` | `logs/timeline-YYYY-MM-DD.jsonl`（插件根目录下） |
| `rotateMaxBytes` | `0` | 同日大小轮转至 `.jsonl.1` |
| `retainRotated` | `5` | 每日保留的轮转备份数 |
| `maxLogFiles` | `0` | 文件数量上限；删除**最早**日志 |

```bash
LOG=~/.config/opencode/plugins/opencode-cache-hit/logs/timeline-$(date +%Y-%m-%d).jsonl
tail -f "$LOG"
# 时间字段为 ISO 8601 字符串，含本地时区（如 "2024-05-30T08:00:00.000+08:00"）
jq -r 'select(.rootSessionId=="YOUR_ROOT") | [.created,.scope,.hitPercent,.cost]|@tsv' "$LOG"
```

轮转与清理：[docs/zh-CN/timeline.md#轮转与清理](docs/zh-CN/timeline.md#轮转与清理)。图表工具：[scripts/README.md](scripts/README.md)。

### 缓存 TTL（`cacheTTL`，默认开启）

显示 prompt cache 已存活时间。超过 TTL 时颜色变化：

- 绿色：已存活 < TTL
- 黄色：TTL ≤ 已存活 < 2×TTL
- 红色：已存活 ≥ 2×TTL

```json
"cacheTTL": {
  "enabled": true,
  "providers": {
    "anthropic": "5m",
    "openai": "5m",
    "deepseek": "2h",
    "google": "1h"
  }
}
```

| 字段 | 默认 | 含义 |
|-------|---------|-------|
| `enabled` | `true` | 总开关 |
| `providers` | `{}` | 每个 provider 的 TTL（或 `provider:model`）。可读格式：`30s`、`5m`、`1.5h` |

**内置默认值**（配置中未指定时使用）：

| Provider | 默认 TTL | 来源 |
|----------|----------|------|
| anthropic | 5 分钟 | [Anthropic 文档](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) |
| openai | 5 分钟 | [OpenAI 文档](https://platform.openai.com/docs/guides/prompt-caching) |
| deepseek | 2 小时 | [DeepSeek 文档](https://api-docs.deepseek.com/guides/kv_cache) |
| google | 1 小时 | [Google 文档](https://ai.google.dev/api/caching) |
| xai | 5 分钟 | [xAI 文档](https://docs.x.ai/developers/advanced-api-usage/prompt-caching) |
| minimax | 5 分钟 | [MiniMax 文档](https://platform.minimax.io/docs/api-reference/text-prompt-caching) |
| xiaomi | 5 分钟 | 隐式缓存 |
| qwen | 5 分钟 | 隐式缓存 |
| moonshot | 5 分钟 | 隐式缓存 |

**默认 TTL**：上表未列出的 provider 均为 5 分钟。颜色基于已存活时间与 TTL 的比值：绿色（< TTL）、黄色（TTL–2×TTL）、红色（≥ 2×TTL）。

### 动态计价（`dynamicPricing`，默认开启）

模型单价通常为 OpenCode provider 注册表中的静态 USD/百万 token。部分模型按**时段**计价（DeepSeek V4：高峰 09:00-12:00 / 14:00-18:00 北京时间，空闲半价），或按**上下文大小**分档（`context_over_200k`，如 GPT-5.6：超过 200k token 单价约翻倍）。

零配置时插件已自动：

- 读取 `state.provider` 中模型的上下文档位（运行时 `tiers` / `experimentalOver200K`，内部归一化），按总上下文（输入 + 缓存读）与阈值显示对应档位。
- 时段匹配时对 DeepSeek 模型应用内置空闲 0.5× 倍率。

```json
"dynamicPricing": {
  "enabled": true,
  "timezone": "Asia/Shanghai",
  "schedule": [
    { "level": "peak",    "windows": [{"start": "09:00", "end": "12:00"}, {"start": "14:00", "end": "18:00"}] },
    { "level": "offpeak", "windows": [{"start": "18:00", "end": "09:00"}, {"start": "12:00", "end": "14:00"}] }
  ],
  "contextThreshold": 200000,
  "providers": {
    "deepseek": {
      "models": {
        "deepseek/deepseek-v4-flash": {
          "multipliers": { "peak": 1, "offpeak": 0.5 }
        }
      }
    }
  }
}
```

| 字段 | 默认值 | 含义 |
|------|--------|------|
| `enabled` | `true` | 总开关。设为 `false` 恢复完全静态计价 |
| `timezone` | `Asia/Shanghai` | 时段匹配所用 IANA 时区（DeepSeek 按北京时间计价） |
| `schedule` | DeepSeek 高峰/空闲 | `{level, windows:[{start,end}]}` 列表；`HH:MM` 格式，支持跨天窗口 |
| `contextThreshold` | `200000` | 上下文档位的 token 阈值；模型级 `contextThreshold` 优先于 `state.provider` 的运行时档位阈值 |
| `providers` | `{}` | 按 `providerID` → `modelID` 的规则 |

单模型规则支持两种形式（显式配置优先于内置 DeepSeek 默认）：

- `multipliers`：按时段档对静态价施加系数（如 `{"offpeak": 0.5}`）
- `levels`：各时段档的绝对单价，如 `{"peak": {"input": 0.44, "output": 0.88, "cacheRead": 0.01}, "offpeak": {"input": 0.22, ...}}`。缓存单价可写为扁平 `cacheRead`/`cacheWrite`（或 `cache_read`/`cache_write`），也可写为嵌套 `cache: {"read": …, "write": …}`（两种都接受；同时存在时扁平优先）。默认单位为 **USD/百万 token**（与 `state.provider` 一致）。想用其他币种写价时设 `"currency": "CNY"`：要么与展示币种 `cost.currency` 一致（按 `cost.rate` 换算），要么提供模型级 `"rate"`（USD → 该币种，如 EUR 填 1.08）。无法换算时（无 `rate` 且币种 ≠ 展示币种）向 stderr 告警并按 USD 处理。`multipliers` 是倍率，无币种概念。
- `contextThreshold`：覆盖全局阈值的模型级配置（优先于 `state.provider` 的运行时档位阈值）。

侧边栏单价会在时段边界自动切换（无需轮询）。会话成本在动态规则生效时按每条消息的请求时刻 + 上下文档位重算（标注 `≈`）；否则使用 OpenCode 自身的 `msg.cost`。子 agent 行按其**会话创建时刻**（`session.list`）做时段计价（任一子会话被重算时 Agents 合计标注 `≈`）。

**时间轴看板**（[docs/zh-CN/timeline.md](docs/zh-CN/timeline.md)）也会离线重算成本：读取 `~/.config/opencode/opencode.json`（支持 JSONC 注释）获取 provider 单价，逐条注入 `dynCost`（与原值不同时以 `≈` 展示，并计入图表与合计）。

**刷新 DeepSeek 官方价**：`bun scripts/fetch-deepseek-pricing.ts` 输出可直接粘贴的 `dynamicPricing.providers` 片段（默认人民币并带 `"currency": "CNY"`，`--usd --rate 6.77` 转美元）。

## 更新

> [!IMPORTANT]
> OpenCode **会把 `@latest` 固定到首次解析的版本，之后永不重新拉取**（[opencode#6774](https://github.com/anomalyco/opencode/issues/6774)、[#25293](https://github.com/anomalyco/opencode/issues/25293)、[#30631](https://github.com/anomalyco/opencode/issues/30631)）。仅**重启并不会**加载更新的 npm 版本。如果你还在跑旧的缓存构建，可能会遇到上游早已修复的崩溃（例如 [#3](https://github.com/zhumengzhu/opencode-cache-hit/issues/3) —— 侧边栏消失并报 `undefined is not an object (evaluating 'config.providers')`）。OpenCode 通过 `@opentui/solid` 为每个插件 slot 包裹了 per-slot `<ErrorBoundary>`（自 v1.17.0 起存在）。SolidJS 组件渲染错误会被捕获并记录到 stderr —— 出错的 slot 静默卸载（无崩溃屏，容易被忽略），TUI 其余部分正常存活。注意：更底层的 opentui/yoga 渲染器错误（如布局阶段故障）仍可能绕过此边界并拖垮整个 TUI。

强制更新：删除缓存目录，然后重装并重启：

```bash
rm -rf ~/.cache/opencode/packages/opencode-cache-hit@latest
```

然后通过 `Ctrl+P` → install plugin 重装并**重启 OpenCode**。

要彻底避免固定问题，可安装**固定版本**而非 `@latest`：

```jsonc
{ "plugin": ["opencode-cache-hit@0.6.4"] }
```

## 兼容性

模型无关：任何在消息中暴露 assistant `tokens` / `cost` 的 OpenCode provider 均可（DeepSeek、Claude、GPT 等）。数据来自 OpenCode session API，与 visual-cache 一致。

**需要**支持 TUI 插件槽位的 OpenCode（`@opencode-ai/plugin` ≥ 1.14）。可与 visual-cache 共存；运行时除 `package.json` 中声明的 peer 依赖外无额外依赖。

## 文档索引

| 读者 | English | 中文 |
|----------|---------|------|
| 使用者 | [README.md](README.md) | 本文 |
| 维护者 | [docs/en/design.md](docs/en/design.md) | [docs/zh-CN/design.md](docs/zh-CN/design.md) |
| 时间轴 / JSONL | [docs/en/timeline.md](docs/en/timeline.md) | [docs/zh-CN/timeline.md](docs/zh-CN/timeline.md) |
| TUI 面板复用 | [src/tui-panel/README.md](src/tui-panel/README.md) | [src/tui-panel/README.zh-CN.md](src/tui-panel/README.zh-CN.md) |
| 贡献 / npm | [CONTRIBUTING.md](CONTRIBUTING.md) | — |
| AI 维护指南 | [AGENTS.md](AGENTS.md) | — |
| 总索引 | [docs/README.md](docs/README.md) | |

## 项目结构

```
index.tsx
cache-hit.config.example.json
src/
  plugin.tsx              # sidebar_content 插槽
  sidebar-host.tsx        # 消息、子会话同步、timeline
  widget.tsx
  stats.ts / timeline/ / tui-panel/
tests/
```

## 开发

```bash
bun test
```

环境搭建、PR 规范、npm 发布见 [CONTRIBUTING.md](CONTRIBUTING.md)。架构：[docs/zh-CN/design.md](docs/zh-CN/design.md)。

## License

MIT
