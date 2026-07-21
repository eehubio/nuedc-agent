# NUEDC Agent · 电赛智能体

> **1 个总控编排器 + 专业 Agent + 规则引擎 + 结构化模块数据库**，可嵌入 ezPLM，也可独立部署到 Vercel。

覆盖需求：物料清单整理 · 题目预测 · 模块数据库（淘宝/实验室/官方，上传审批）· 原理图/接口/图片/代码仓库 · 自动构建方案 · 代码生成 · 调试助手（LabSight）· 报告生成。

技术栈与 [eehubio/ai-hardware-genesis-platform](https://github.com/eehubio/ai-hardware-genesis-platform) 保持一致（Next.js 14 + @libsql/client + zod），模块 schema 兼容其枚举体系，两库数据可互导；方案生成流程参考 [eehubio/ai-hardware-genesis](https://github.com/eehubio/ai-hardware-genesis) 的渐进式需求确认与组件推荐模式。

---

## 核心设计（为什么不是"一个聊天机器人"）

```
┌────────────────────────────────────────────────────┐
│  工作区：赛题 │ 预测 │ 方案 │ 模块BOM │ 代码 │ 调试 │ 报告  │
│  签名元素：项目状态机刻度条（备赛 → … → 提交）           │
└─────────────────────┬──────────────────────────────┘
                      │ POST /api/agent
              总控编排 Orchestrator
                      │ （状态门禁：项目阶段决定可调用的 Agent）
   ┌──────────────────┼───────────────────┐
   规划类              工程类               交付类
   problem_interpreter solution_architect  code_generator
   topic_forecast      integration_checker labsight_debug
   module_knowledge    bom_agent           report_composer
                       procurement_planner
                      │
        ┌─────────────┼─────────────┐
        LLM 路由       规则引擎        libsql 数据库
   （Anthropic/OpenAI  （不用 LLM：    modules / projects /
    兼容/Gemini 可切）   电平·引脚·电源·  artifacts / agent_runs /
                        备料数量·预测评分） module_reviews / events
```

三条硬原则（来自设计文档，已落实在代码里）：

1. **Agent 间不传聊天记录**，传 Task/Artifact/Review/Event 标准对象；每次运行落库 `agent_runs`，产物落库 `artifacts` 形成版本历史。
2. **能用规则就不用 LLM**：接口电平/引脚冲突/电源预算（`lib/rules/integration-rules.ts`）、备料数量（`procurement-rules.ts`）、预测评分（`forecast-scoring.ts`）全部是确定性程序。接口检查发现 blocker 时，**代码生成被状态门禁拦截**。
3. **不虚构**：模块推荐只能引用库内真实 id（幻觉 id 会被丢弃）；BOM 低置信度强制人工确认；代码输出 `GENERATED` 状态，编译通过前不得标"可用"；报告缺失数据写【待补充】占位并做型号一致性检查。

## 快速开始（本地）

```bash
npm install
cp .env.example .env.local     # 至少配置一个 LLM 提供商的 API Key
npm run db:init && npm run db:seed
npm run dev                    # http://localhost:3000
```

不配数据库时默认使用 `file:local.db`（本地 SQLite 文件）。

## 部署到 Vercel

1. 创建 [Turso](https://turso.tech) 数据库（Vercel Serverless 无持久文件系统，必须用外部库）：
   ```bash
   turso db create nuedc-agent
   turso db show nuedc-agent --url      # → TURSO_DATABASE_URL
   turso db tokens create nuedc-agent   # → TURSO_AUTH_TOKEN
   ```
2. `vercel` 部署（或连 GitHub 仓库），在 Vercel 环境变量里配置 `.env.example` 中的项。
3. 首次部署后本地跑一次初始化（指向线上库）：
   ```bash
   TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... npm run db:init
   TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... npm run db:seed
   ```

`vercel.json` 已把 `/api/agent` 与 `/api/report` 的超时提到 120s（方案与报告生成较慢）。

## 嵌入 ezPLM

**方式一：iframe + 嵌入脚本**（最快，电赛专区页面直接放）

```html
<div id="nuedc-agent" style="height: 80vh"></div>
<script src="https://your-app.vercel.app/ezplm-embed.js"></script>
<script>
  const agent = NuedcAgent.mount("#nuedc-agent", {
    baseUrl: "https://your-app.vercel.app",
    ezplmProjectId: "EZ-2026-001",   // 关联 ezPLM 项目
    userTier: "paid",                 // ezPLM 已知的付费状态
    onEvent: (evt) => {
      // 智能体 → ezPLM 回传：bom_ready / report_ready / solution_approved / stage_changed
      if (evt.type === "bom_ready") importBomIntoEzplm(evt.payload);
    },
  });
  // ezPLM → 智能体：推送赛题文本
  agent.post("set_problem", problemPdfText);
</script>
```

记得在环境变量 `ALLOWED_EMBED_ORIGIN` 里写上 ezPLM 域名（CSP frame-ancestors）。

**方式二：纯 API 集成**（ezPLM 后端代理，推荐生产使用）

ezPLM 服务端携带共享密钥调用，用户分级由 ezPLM 声明，本应用不重复做账号体系：

```
POST https://your-app.vercel.app/api/agent
Headers: X-Api-Key: <EZPLM_API_KEY>
         X-User-Tier: paid            # free | paid | lab | admin
Body: { "agent": "bom_agent", "project_id": "P-xxx", "input": { "raw_bom": "..." } }
```

## API 一览

| 端点 | 说明 |
|---|---|
| `POST /api/agent` | 统一 Agent 入口。`agent` ∈ orchestrator / problem_interpreter / topic_forecast / module_knowledge / solution_architect / integration_checker / bom_agent / procurement_planner / code_generator / labsight_debug / report_composer |
| `GET/POST /api/modules` | 模块检索 / 上传（上传强制进 DRAFT 待审核；免费用户看不到原理图/PCB/代码资产） |
| `GET/PATCH /api/modules/:id` | 模块详情（付费门控 + 下载计数）/ 编辑 |
| `POST /api/modules/:id/review` | 审核：沿认证状态机推进 DRAFT→DOCUMENTED→POWER_TESTED→FUNCTION_TESTED→BENCHMARKED→COMPETITION_READY |
| `GET/POST /api/projects`，`GET/PATCH /api/projects/:id` | 项目与状态机、产物历史 |
| `GET /api/report?project_id=` | 下载最新设计报告 Markdown |

Agent 调用示例：

```bash
# 赛题解析
curl -X POST /api/agent -d '{"agent":"problem_interpreter","input":{"problem_text":"…赛题原文…"}}'
# LabSight 调试（可带 PCB 照片）
curl -X POST /api/agent -d '{"agent":"labsight_debug","input":{"symptom":"电机启动后MCU复位","logs":"…","images":[{"media_type":"image/jpeg","data_base64":"…"}]}}'
```

## 权限体系

| 能力 | free | paid | lab | admin |
|---|---|---|---|---|
| 赛题分析 / 预测 / 模块浏览 / 方案建议 | ✅ | ✅ | ✅ | ✅ |
| 代码生成 / 报告生成 / 调试助手 | — | ✅ | ✅ | ✅ |
| 下载模块完整资料（原理图/PCB/代码） | — | ✅(FUNCTION_TESTED↑) | ✅ | ✅ |
| 上传模块 | — | ✅ | ✅ | ✅ |
| 审核 / 认证模块 | — | — | ✅ | ✅ |

## LLM 配置

`LLM_PROVIDER=anthropic | openai | gemini`。`openai` 模式兼容 DeepSeek / Qwen / Moonshot 等，改 `OPENAI_BASE_URL` 即可。LabSight 调试传图时自动走各家的多模态消息格式。

## 目录结构

```
lib/types.ts              项目状态机 · Agent 类型 · Task/Artifact 对象 · 模块认证状态
lib/module-schema.ts      模块 zod schema（兼容 ai-hardware-genesis-platform）
lib/db.ts                 libsql + 建表 SQL
lib/llm.ts                三提供商 LLM 抽象 + JSON 输出保障
lib/auth.ts               分级鉴权与付费门控
lib/rules/                规则引擎（接口检查 / 备料数量 / 预测评分）
lib/agents/               base（注册表·门禁·落库）+ planning + engineering + delivery
app/api/                  agent / modules(+review) / projects / report
components/Workspace.tsx  七页签工作区 + 状态刻度条 + 智能体面板
public/ezplm-embed.js     ezPLM 嵌入脚本（iframe + postMessage 桥）
data/seed-modules.json    种子模块（MSPM0 / K230 / TB6612 / MPU6050 / TPS5430 / nRF24）
```

## 路线图（对应设计文档分期）

- **一期（本仓库已实现）**：总控编排、赛题理解、题目预测、模块知识库、方案生成（含接口预检）、接口检查、BOM 整理、备料规划、代码生成（模块级）、调试助手、报告生成、模块上传审批、付费门控、ezPLM 嵌入
- **二期**：代码验证 Agent（接 GCC/CCS CLI 真实编译 → COMPILED/HIL_TESTED 状态推进）、测试评分 Agent、LabSight 仪器接入（示波器波形 / 摄像头流）
- **三期**：淘宝商品自动采集与 AI 芯片识别、模块知识图谱（依赖/替换/兼容/历届题目关系）、Word/PDF/LaTeX 报告导出、付费模块市场结算
