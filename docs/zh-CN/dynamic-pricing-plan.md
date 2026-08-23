# 动态计价设计（feat/dynamic-pricing · v0.7.0）

> 状态：**已实现并提交（ef55650）**。本文档保留设计动机、关键决策与精度边界；
> 用户配置与最新字段以 README § Dynamic pricing 为准。

---

## 1. 背景

- DeepSeek V4 系列自 2026-08 起官方按时间计价：高峰时段（北京时间**周一至周五** 9:00-12:00、14:00-18:00）全价，空闲时段半价（缓存命中 / 未命中 / 输出三档各乘 0.5）；**周末全天为空闲**。
- 部分模型（如 GPT-5.6 系列）配置了 `cost.context_over_200k`：上下文超过 200k 时价格约翻倍。
- 以上两类价格都无法用当前插件的静态单档价格表达。

## 2. 设计背景：现状计价链路

实现前的计价链路（改动动机）：

```
opencode TUI API（api.state.provider）
  └─ 静态单档价格（USD/1M：input / output / cache.read / cache.write）
       ▼
src/pricing.ts：lookupModelCost(providerID, modelID) → ModelCost（基础档）
       ▼
src/use-cache-hit-metrics.ts：pricing memo = computePricing(...)
       ├─ rates（input/output/cacheRead/cacheWrite 单价）
       └─ saved = (inputRate − cacheReadRate) × cacheRead / 1M
       ├─ main-session-view.tsx：展示 rates + saved + cost（Σ msg.cost）
       └─ agents-view.tsx：computeSubsSaved 汇总子 agent saved
```

关键决策点：价格源 `state.provider` 为静态单档；`msg.cost` 由 opencode 按其内部 tier 数组计算（插件只读）；rates/saved 为插件自算（可动态化）；消息与 timeline 记录均有请求时刻；子 agent 无时间戳（实现后已从 `session.list` 补齐）。

## 3. context_over_200k 支持性调研

实现前确认：插件类型与逻辑均未覆盖上下文分档，但**运行时数据可得**：

- 配置层（opencode.json 的 ProviderConfig）的 `cost.context_over_200k` 会被 opencode 运行时转为 `tiers[]` / `experimentalOver200K`；`api.state.provider` 暴露的是运行时格式（SDK 已确认，含 `tier:{type:"context",size}`）。
- 插件通过 `normalizeRuntimeCost` 归一化为内部上下文档（含档位阈值），按总上下文（`input + cacheRead`）选档。

## 4. 方案：统一计价引擎（双维度正交）

价格 = f(模型, 用量, **上下文大小**, **请求时刻**)

### 4.1 价格档位模型

把「计价」抽象为**价格档选择**：每个模型可有多档价格，每档带适用条件。

```
type PriceTier = {
  condition: {
    context?: { min?: number; max?: number }   // 上下文 token 范围（如 >200k）
    level?: "peak" | "offpeak" | string        // 时段档
  }
  rates: { input; output; cacheRead; cacheWrite }  // USD/1M
}
```

选择顺序（fallback 链）：
1. **用户配置的显式档**（`dynamicPricing.providers[...]`，含时段档 / 自定义上下文档）
2. **`state.provider` 自带运行时上下文档**（`tiers[]` / `experimentalOver200K`，已归一化）→ 按总上下文（`input + cacheRead`）选档（零配置即支持 GPT-5.6 类模型）
3. **静态基础档**（现状行为，兜底）

### 4.2 配置设计（新增 `dynamicPricing` 段）

```jsonc
{
  "dynamicPricing": {
    "enabled": true,
    "timezone": "Asia/Shanghai",          // DeepSeek 以北京时间为准
    "schedule": [                          // 时段规则（DeepSeek 官方默认；星期感知）
      { "level": "peak", "windows": [
        { "start":"09:00","end":"12:00","days":[1,2,3,4,5] },  // 周一~周五
        { "start":"14:00","end":"18:00","days":[1,2,3,4,5] }
      ] },
      { "level": "offpeak", "windows": [] }   // 回退档：周末等一切未覆盖时刻
    ],
    "contextThreshold": 200000,            // 全局默认上下文档位阈值（默认读 200k）
    "providers": {
      "deepseek": {
        "models": {
          "deepseek/deepseek-v4-flash": {
            "currency": "CNY",           // levels 原始币种（默认 USD）；加载时按 cost.rate ÷换算为内部 USD
            "levels": {                    // 时段绝对价（/1M tokens）
              "peak":    { "input": 3.0, "output": 9.0, "cacheRead": 0.10, "cacheWrite": 0 },
              "offpeak": { "input": 1.5, "output": 4.5, "cacheRead": 0.05, "cacheWrite": 0 }
            }
          }
        }
      },
      "openai": {
        "models": {
          "gpt-5.6": {
            "contextThreshold": 200000     // 可覆盖全局阈值；不配则自动用运行时上下文档（tiers/experimentalOver200K）
          }
        }
      }
    }
  }
}
```

- 支持**绝对价**（`levels`，默认 USD/1M，可设 `currency` 用 CNY 等直接写价；缓存单价支持扁平 `cacheRead/cacheWrite` 或嵌套 `cache:{read,write}`，扁平优先）与**倍率**（如 `{"offpeak": 0.5}`，相对静态价打折）两种模式；显式配置优先于内置 DeepSeek 默认。
- 内置 `deepseek.ts` 默认规则：DeepSeek 模型空闲时段 0.5× 倍率（零配置生效）。
- 完整字段与示例见 README § Dynamic pricing。

### 4.3 模块划分（符合 AGENTS.md 纯逻辑约定）

```
src/dynamic-pricing/
  types.ts        // ModelPricingRule / ScheduleLevel / TimeWindow(days?) / DynamicPricingConfig
  schedule.ts     // 时段解析、tzWeekdayOf(ISO 星期)、isLevelAt(now)（含回退档）、nextBoundaryMs(now)（星期感知，距下一边界毫秒数）
  context.ts      // 上下文档位选择（context_over_200k）+ 倍率缩放
  lookup.ts       // resolveModelCost(providers, providerID, modelID, ctx) → 有效四率 + 档位标注
  deepseek.ts     // 内置 DeepSeek 空闲 0.5× 默认规则
  recompute.ts    // recomputeSessionCost / recomputeSubAgentCost / recomputeRecordCost
```

`pricing.ts` 改造（向后兼容）：

```ts
computePricing(providers, providerID, modelID, cacheRead,
  ctx?: { now?: number; contextTokens?: number; rules?: DynamicPricingConfig })
// now / rules 缺省 → 完全回退现状
// 返回增加 level（时段）与 contextTier（档位）标注
```

### 4.4 跨时段边界的精确刷新

`use-cache-hit-metrics` 增加 `now` signal：
- `setTimeout(nextBoundaryMs)` 精确对齐下一边界（9:00/12:00/14:00/18:00），`onCleanup` 清理；
- 星期感知：周五 18:00 后的下一边界直达周一 09:00（周末无有效边界，不轮询）；
- 跨边界时 rates/saved/时段标记**瞬间切换**，无需每秒轮询。

### 4.5 已发生成本（msg.cost）修正

- **主会话**：`recomputeSessionCost` 逐条用 `msg.time.created`（时段）＋ 总上下文 `input + cacheRead`（上下文档）→ 该 msg 有效价格 × 用量 → 累加。动态规则生效时展示重算值（标注 `≈`），否则回退 `msg.cost`。
- **子 agent**：`SubAgentSummary.created` 来自 `session.list`（`session-list.ts` → `child-session-sync.ts`），按会话创建时刻重算（`recomputeSubAgentCost`）；**无 created 时直接回退 msg.cost，不做近似**（无法确定时段不猜测）。
- **timeline 离线重算**：dashboard 读取 opencode.json（JSONC 感知）的 provider 单价，逐条按记录时刻重算并注入 `dynCost`。

### 4.6 UI

- rates / saved 行：随时段与上下文档位显示对应价格，可加 `peak/offpeak`、`≤200k/>200k` 标记。`peak/offpeak` 徽标仅在该模型对当前时段档有定价（当前档存在于显式 `levels`/`multipliers` 或内置 DeepSeek 默认）时显示，静态价模型与未定价档不标注。
- cost 行：动态计价生效时用重算值（`≈` 前缀），否则维持 `msg.cost`。

## 5. 精度边界与权衡

| 边界 | 口径 |
|---|---|
| 请求跨时段边界（11:59:59 发起） | 官方按请求时刻计费 → 用 `msg.time.created` 判定 |
| 上下文大小判定 | `msg.tokens.input`（含缓存）；200k 阈值可配置 |
| `state.provider` 静态价滞后 | 显式 `levels` 绝对价绕开；倍率模式受影响 |
| 时区 | 默认 Asia/Shanghai，可覆盖 |
| 节假日 | 官方未声明差异，当前按每日同规则（未实现节假日感知） |
| 星期 | `days`（ISO 1=周一…7=周日）可选；省略 = 每天。旧配置未写 `days` 时周末仍按高峰（向后兼容，README 有迁移提示 + 运行时一次性 stderr 提示） |
| 子 agent 无 created | 直接回退 msg.cost，不按时段重算（不近似） |
| 与 opencode msg.cost 口径差异 | 重算值标注 `≈`；opencode 若已按 tier 计算则差异为时段维度 |

## 6. 已实施范围（v0.7.0）

- **M1 计价引擎**：`dynamic-pricing/` 纯函数模块 + 配置 normalize + `pricing.ts` 向后兼容改造 + 时段边界精确刷新（setTimeout，无轮询）。
- **M2 UI**：cost 重算展示（`≈` 标注，主会话按消息、子 agent 按会话创建时刻）+ rate 行档位/时段标记（peak/offpeak/>200k）+ i18n 双语。
- **M3 时间戳与离线重算**：子 agent 创建时刻（`session.list`）+ timeline dashboard 离线 `dynCost` 注入（读 opencode.json，JSONC 感知）。
- **M4 定价刷新脚本**：`scripts/fetch-deepseek-pricing.ts` 抓官方定价页 → 输出可粘贴片段（CNY/USD，含 `currency`）。
- **M5 星期感知（weekday-aware schedule）**：`TimeWindow.days?` + 回退档（空 `windows` level 兜底）；`nextBoundaryMs` 跳过周末；DeepSeek 周末自动空闲（默认 schedule 生效，无需配置）；旧配置需手动补 `days:[1..5]`（README/示例/运行时提示三触点）。

## 7. 测试

- `tests/dynamic-pricing-schedule.test.ts`：时段解析与边界（09:00 整点归属、12:00 切档、跨天 18:00→09:00）、`nextBoundaryMs`、时区换算；**星期感知**（周末→offpeak、回退档语义、跨天起始日规则、`nextBoundaryMs` 周五→周一、`tzWeekdayOf`）。
- `tests/dynamic-pricing-lookup.test.ts`：上下文档位选择（≤/＞200k、无 context_over_200k 回退）、lookup fallback 链、内置 DeepSeek 时段倍率（含周末 0.5×）、computePricing 向后兼容。
- `tests/dynamic-pricing-recompute.test.ts`：跨时段/跨档消息序列重算、子 agent 重算、记录重算、配置 normalize（含非 USD levels 换算）。
- `tests/plugin-config.test.ts`：`days` 解析、非法 `days` 忽略、空 windows 档保留与去重。

## 8. 参考

- DeepSeek 官方定价：https://api-docs.deepseek.com/zh-cn/quick_start/pricing （高峰**周一至周五** 9:00-12:00、14:00-18:00 北京时间，其余含周末空闲半价）
- models.dev schema 支持上下文分档；opencode 核心将其转为 `tier: { type: "context", size: 200000 }` 数组
- opencode 社区：issue #592（Gemini context tier）、PR #20808
- 参考实现：GPT-5.6 类模型通过 `context_over_200k` 配置、运行时暴露为 `tiers` / `experimentalOver200K`
