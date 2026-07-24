# 接入国内大模型（预留位，配好即生效）

模型网关**不锁定任何厂商**。国内主流厂商都提供 OpenAI 兼容端点，
接入只需配置环境变量，**不需要改任何代码**。

## 当前状态

访问 `/api/routing-preview` 查看实时选路：

```json
{ "mock_enabled": false, "primary_candidate": "gemini:gemini-2.5-flash",
  "routing_chain": ["gemini:gemini-2.5-flash"], "fallback_env": [] }
```

`routing_chain` 只有一项 = **容灾链是断的**：Gemini 挂了会直接降级到仅规则模式，
项目编辑与规则工具仍可用，但 AI 生成会暂停。配好备用 Provider 后这条链才真正生效。

## 接入步骤（以通义千问为例）

在 Vercel（以及 Worker 所在机器）添加环境变量，然后**重新部署**：

```
QWEN_API_KEY=sk-你的key
QWEN_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
QWEN_MODEL_TEXT=qwen-plus
QWEN_MODEL_VISION=qwen-vl-plus
MODEL_PROVIDER_FALLBACK=qwen
```

重新访问 `/api/routing-preview`，`routing_chain` 应变成两项。

## 其他已预置的厂商

改前缀即可，无需改代码：

| 厂商 | 前缀 | BASE_URL | 常用模型 |
|---|---|---|---|
| 通义千问 | `QWEN_` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` / `qwen-vl-plus` |
| DeepSeek | `DEEPSEEK_` | `https://api.deepseek.com/v1` | `deepseek-chat` |
| 智谱 GLM | `GLM_` | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash` / `glm-4v-flash` |
| Kimi | `MOONSHOT_` | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` |
| 任意其他 / 自建网关 | `CUSTOM_` | 你的地址 | 你的模型名 |

每个前缀支持四个变量：`_API_KEY`、`_BASE_URL`、`_MODEL_TEXT`、`_MODEL_VISION`。

## 路由策略

- `MODEL_PROVIDER_PRIMARY`：主模型（默认 gemini），承担方案生成等高质量任务
- `MODEL_PROVIDER_FALLBACK`：容灾链，逗号分隔，按顺序尝试
- `MODEL_PROVIDER_CHEAP`：低成本任务优先链；留空则按各家实际单价自动排序
- `MODEL_PROVIDER_VISION`：多模态任务（PDF/OCR）优先链；留空则自动选有 vision 能力的

低成本任务（BOM 规范化、报告润色、一般问答）会自动优先便宜的 Provider——
排序按**该任务的实际输入/输出 token 配比**估算，而不是简单比较单价。
未声明定价的 Provider（如自建网关）不参与自动排序，但可显式指定。

## 容灾行为

某家 Provider 出现以下情况会自动熔断并切换下一家：

- 连续 5 次 429（限流）→ 熔断 5 分钟
- 5 分钟内失败率 > 30% → 熔断 5 分钟
- 认证失败 / 模型不存在 / 区域限制 → 熔断 30 分钟（重试无意义）

熔断状态可在 `/admin/model-operations` 查看，也可手工启停。
全部 Provider 不可用时系统进入 `RULES_ONLY`，页面明确提示
"项目数据、模块库、BOM 编辑、接口检查、测试评分与报告编辑均可正常使用"，不会白屏。

## 成本控制

```
PER_USER_DAILY_BUDGET_USD=1.0     # 每用户每日预算
PER_PROJECT_DAILY_BUDGET_USD=2.0  # 每项目每日预算
GLOBAL_DAILY_BUDGET_USD=50        # 全局每日预算
```

超限只停 AI 生成，不影响项目编辑与规则工具。用量与成本在 `/admin/model-operations`
按 Provider 与任务类型双维度统计。
