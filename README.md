# NUEDC Agent · 电赛智能体

> **1 个总控编排器 + 专业 Agent + 规则引擎 + 结构化模块数据库**，可嵌入 ezPLM，也可独立部署到 Vercel。

覆盖需求：物料清单整理 · 模块数据库（淘宝/实验室/官方，上传审批）· 原理图/接口/图片/代码仓库 · 自动构建方案 · 代码生成 · 调试助手（LabSight）· 报告生成。

技术栈与 [eehubio/ai-hardware-genesis-platform](https://github.com/eehubio/ai-hardware-genesis-platform) 保持一致（Next.js 14 + Neon Postgres + zod），模块 schema 兼容其枚举体系，两库数据可互导；方案生成流程参考 [eehubio/ai-hardware-genesis](https://github.com/eehubio/ai-hardware-genesis) 的渐进式需求确认与组件推荐模式。

---

## 核心设计（为什么不是"一个聊天机器人"）

```
┌──────────────────────────────────────────────────────────┐
│ 学生备赛平台：首页 │ 题目预测 │ 方案生成(对话式) │ 模块选型   │
│              │ 电路连线 │ 代码生成 │ 调试助手 │ 报告 │ 项目 │
└─────────────────────┬────────────────────────────────────┘
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
        LLM 路由       规则引擎        Neon Postgres
   （Anthropic/OpenAI  （不用 LLM：    modules / projects /
    兼容/Gemini 可切）   电平·引脚·电源·  artifacts / agent_runs /
                        备料数量·预测评分） module_reviews / events
```

三条硬原则（来自设计文档，已落实在代码里）：

1. **Agent 间不传聊天记录**，传 Task/Artifact/Review/Event 标准对象；每次运行落库 `agent_runs`，产物落库 `artifacts` 形成版本历史。
2. **能用规则就不用 LLM**：接口电平/引脚冲突/电源预算（`lib/rules/integration-rules.ts`）、备料数量（`procurement-rules.ts`）、预测评分（`forecast-scoring.ts`）全部是确定性程序。接口检查发现 blocker 时，**代码生成被状态门禁拦截**。
3. **不虚构**：模块推荐只能引用库内真实 id（幻觉 id 会被丢弃）；BOM 低置信度强制人工确认；代码输出 `GENERATED` 状态，编译通过前不得标"可用"；报告缺失数据写【待补充】占位并做型号一致性检查。

## 赛题输入方式

三选一：**上传赛题 PDF**（电赛题目下发即 PDF，走 LLM 多模态提取，含表格与评分标准）、**选择历年赛题**（2019–2025 年题号题名内置于 `data/past-problems.ts`，题面正文受组委会版权保护不内置，选中后上传 PDF 或粘贴）、**直接粘贴题面文本**。

## 快速开始（本地）

```bash
npm install
cp .env.example .env.local     # 至少配置一个 LLM 提供商的 API Key
npm run db:init && npm run db:seed
npm run dev                    # http://localhost:3000
```

数据库使用 Neon Postgres：在 https://neon.tech 建库后把连接串填入 `DATABASE_URL`（本地开发建议用 Neon 的 dev 分支，免费额度足够）。

## 部署到 Vercel

1. 在 [Neon](https://neon.tech) 创建数据库，复制连接串（`postgresql://...`）。
2. `vercel` 部署（或连 GitHub 仓库），在 Vercel 环境变量里配置 `.env.example` 中的项（至少 `DATABASE_URL`、`LLM_PROVIDER`、对应的 LLM Key）。
3. 首次部署后本地跑一次初始化（指向线上库）：
   ```bash
   DATABASE_URL=postgresql://... npm run db:init
   DATABASE_URL=postgresql://... npm run db:seed
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

## 前端交互（面向参赛学生）

方案生成页采用 **对话式渐进流程**（参考 ai-hardware-genesis 的操作逻辑）：粘贴赛题 → 助手解析为可核对的指标清单并标出歧义 → 人工确认 → 生成一套完整方案（附 **自动布局的 SVG 方案框图**，连线按接口预检结果着色）→ 核对后采用为主方案，解锁 BOM / 连线检查 / 代码 / 报告。写报告的方案论证章节时，可按需追加「稳妥」或「性能」取向的备选方案做对比（每套独立生成，互不影响）。首页的「典型应用方向」卡片可一键带示例需求进入该流程；「模块选型」页选用的模块会在方案生成时被优先考虑。

## 模块数据库（对齐 ai-hardware-genesis-platform）

**数据在哪**：Neon Postgres 的 `modules` 表。每行的 `data` 列存整个模块的 JSON（`lib/module-schema.ts` 定义的 zod schema：接口电平/引脚/约束、电源参数、使用要点、坑点、历届应用、淘宝快照、原理图与代码资产），`certification_status` / `category` / `source_type` 等冗余列用于快速筛选。`module_reviews` 表记录每次审核，`events` 表记录写操作审计。

**怎么调用**（三个消费方）：
1. 前端「模块选型」页 → `GET /api/modules`，付费字段按用户分级自动剥离；
2. 方案/推荐 Agent → `loadModuleIndex()` 读库并注入 LLM 上下文（幻觉 id 会被丢弃）；
3. 规则引擎 → 接口检查直接读模块的 `interfaces`/`power` 做电平与电源预算判定。

**能力查询**（普通搜索答不了的问题，参数对齐 genesis-platform 的 `/api/v1/modules/query`）：
```
GET /api/modules?interface=SPI&vAtMost=3.3&tolerant5v=false   哪些 3.3V SPI 模块不耐 5V（需电平转换）
GET /api/modules?minPeak=500                                  峰值电流 ≥500mA 的大负载（电源预算用）
GET /api/modules?chip=AD98&minCompleteness=70                 按主芯片 + 数据完整度筛
```
每个返回的模块带 `_completeness`（0~100 透明加权完整度评分，权重见 `lib/module-query.ts`）。

**怎么维护**：打开 **`/admin` 编辑后台**（输入 `ADMIN_API_KEY` 登录），仿 ai-hardware-genesis-platform 的 CMS，分三个标签页：
- **模块**：左侧列表（可按名称/芯片搜索、按分类过滤）+ 右侧分区表单编辑器。表单把字段拆成基本信息、接口定义（逐行编辑，含协议下拉/电平/5V 容忍勾选/引脚/约束）、电源参数、工程经验（使用要点/坑点/兼容）、历届电赛应用、资产与来源等区块 —— 不再手写 JSON。支持新建、保存、审核晋级、全量导出。
- **分类管理**：两级分层分类树（大类/子类），每类实时显示模块数量。分类定义在 `data/categories.ts` 的 `CATEGORY_TREE`，新增分类改这一处，模块选型页筛选与编辑表单下拉会同步更新。
- **数据治理**：模块总数/平均完整度/来源分布、待审核工作流（上传强制进 DRAFT，通过沿认证状态机逐级晋级）、低完整度名单（逐个列出缺失字段）。

批量导入仍用 `data/seed-modules.json` + `npm run db:seed`（upsert，可反复执行）。

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
lib/db.ts                 Neon Postgres + 建表 SQL
lib/llm.ts                三提供商 LLM 抽象 + JSON 输出保障
lib/auth.ts               分级鉴权与付费门控
lib/rules/                规则引擎（接口检查 / 备料数量 / 预测评分）
lib/agents/               base（注册表·门禁·落库）+ planning + engineering + delivery
app/api/                  agent / modules(+review) / projects / report
components/Platform.tsx   平台壳：侧边栏导航 + 项目/阶段 + 全部 Agent 动作
components/pages-core.tsx 首页 / 题目预测 / 模块选型 / 我的项目
components/pages-build.tsx 方案生成(对话式+SVG框图) / 电路连线 / 代码 / 调试 / 报告
data/prep-content.ts      首页策展内容（备赛任务/知识点/典型方向）
public/ezplm-embed.js     ezPLM 嵌入脚本（iframe + postMessage 桥）
data/seed-modules.json    10 个种子模块（MSPM0/K230/TB6612/MPU6050/TPS5430/nRF24/AD9833/AD8336/ADS1256/OPA2277）
```

## 路线图（对应设计文档分期）

- **一期（本仓库已实现）**：总控编排、赛题理解、题目预测、模块知识库、方案生成（含接口预检）、接口检查、BOM 整理、备料规划、代码生成（模块级）、调试助手、报告生成、模块上传审批、付费门控、ezPLM 嵌入
- **一期补充 VI（费用与账户治理，已实现）**：公开诊断改读 health_cache 不再实时调用 LLM（管理员实时诊断限流每分钟一次）、配额改为数据库原子占用（`ON CONFLICT ... WHERE used < quota RETURNING` 单语句，杜绝并发超发）、预占-提交-返还三态（PDF 提取失败自动返还配额，不让系统故障扣用户次数）、兑换码表化（access_codes：哈希存储/次数上限/有效期/可撤销 + 每小时 5 次失败限流）、权益独立成表（user_entitlements 支持到期与撤销，不再借用 llm_usage）、统一身份函数 getRequestIdentity（消除三套 tier 判断）、Schema 补齐（connectionSchema/powerRailSchema 真校验、需求 type/priority/status/verification_method 枚举归一并容忍自由文本、BOM 数量无法解析记 null 并标记待定而非猜 1）、丢弃项在界面明示（模型返回 N 项/有效 M 项/剔除 K 项）、CI 新增 lint+typecheck+test+build+DOCX 可打开性验证(10 项)+E2E
- **一期补充 V（交付体验，已实现）**：报告预览/编辑/导出闭环（渲染式预览、可直接编辑正文并存为新版本可回溯、导出 Word .docx（自研 Markdown→DOCX：标题/表格/列表/代码块/中文字体）、PDF（浏览器打印视图，中文字体最可靠）、Markdown 三格式）、框图交互画布（节点可拖动摆位并随方案持久化、画布平移缩放、点击功能块弹出模块完整资料、一键恢复自动布局）、设计助手右栏吸顶常驻、账户与套餐页（能力矩阵/今日用量/兑换码升级付费）
- **一期补充 IV（安全与可信度治理，已实现）**：诊断端点鉴权（公开只返回 service/database/llm 三项 ok，Provider/模型/错误详情与耗费型自检 `?full` `?solution` 仅 admin）、PDF 接口治理（PDF 魔数校验 + 8MB 上限 + 按 tier 每日配额：免费 2 次/付费 20 次/实验室与管理员不限，用量记入 llm_usage 表）、LLM 输出运行时 Zod 校验（需求/方案/BOM/代码各有 schema，数量写成"很多"会被强制转型、结构异常行逐项剔除并报告 dropped 数）、截断修复结果标记 partial（`partial_output`/`repair_applied` 一路传到界面红色横幅，方案/BOM/代码三处均提示"确认前请核对完整性"）、需求上下文按优先级裁剪（不再字符硬切静默丢失，基本要求优先纳入，未纳入的 ID 明确列出并计入未覆盖需求，方案卡显示覆盖率）、未知功耗不按 0 处理（POWER_DATA_MISSING：功率类器件缺数据阻断、其余告警）、接口匹配改结构化 ID 优先（from_block_id/from_interface_id，字符串仅作显示回退）、Agent 不再修改传入对象、PDF 提取要求逐页标注【第N页】且需求 source 保留原文引用
- **一期补充 III（已实现）**：产物溯源与依赖图（source_artifact_ids/content_hash/change_reason/schema_version + artifact_dependencies 实例边；类型级 DAG 精确失效替代固定数组——需求变全链失效、接口检查变只影响代码之后、BOM 变不再误伤代码；内容哈希去重防抖保存不空刷版本）、项目快照（一键记录整套时点 manifest，可整套恢复而非单产物）、成员协作模型（project_members + 权限矩阵纯函数与单测，SSO 前过渡）、编译诚实阶梯（SOURCE_COMPILED / MINIMAL_LINKED / SDK_BUILD_PASSED / FIRMWARE_GENERATED 细分，最小链接不再伪装成 COMPILED；docker/ 提供 SDK 构建镜像脚手架）、编译护栏（路径逃逸/文件类型/数量/大小双端校验 + ulimit 沙箱限额 + 固件存储上限收紧）、任务策略（重试上限死信 dead、同项目同 Agent 并发去重）、`npm run e2e` 端到端冒烟（对部署环境验证持久化/级联/快照/权限隔离/任务幂等/编译护栏 14 项断言，不耗 LLM 可反复跑）
- **一期补充 II（已实现）**：全产物版本化持久化（requirements/solution/bom/接口检查/代码/测试计划/实测/得分/报告统一进 artifacts，版本递增；项目打开自动全量恢复，「我的项目」可查版本历史并一键恢复为最新）、方案变更自动级联失效（下游产物标 stale，各页横幅提醒重新生成）、build_jobs 真实编译（提交 MSPM0/STM32/ESP32 任务，GitHub Actions 每 30 分钟巡队列用 arm-none-eabi-gcc 真实编译，回写日志/Flash/RAM/ELF/BIN，成功自动晋级 COMPILED；本地 `BASE_URL=... ADMIN_API_KEY=... npm run build:runner` 亦可执行）、全 API owner 校验（项目/产物/报告/任务/编译均校验归属，legacy 无主项目已由迁移归属 admin:legacy 仅管理员可见）、agent_tasks 任务层（与 agent_runs 执行日志分离；幂等键防重复扣费、取消、重试、刷新页面自动续跑未完成任务）、评分口径分离（scoring_items 仅取自题面：官方分值按需求关联精确计算，无官方分值时明示为 60+40 估算口径）、lint 接入 CI
- **一期补充（已实现）**：Agent 异步任务（POST /api/agent-runs → run_id，waitUntil 后台执行 + 前端轮询，慢 Agent 不再受 120s 长请求限制）、版本化数据库迁移（lib/migrations.ts + schema_migrations 表，db:init 与运行时只补跑缺失迁移）、模块硬件版本拆分（module_revisions 独立表 + /api/modules/:id/revisions + 后台版本记录区）、参数证据等级（E0 AI 推断 → E6 多实验室复验；晋级 BENCHMARKED/COMPETITION_READY 强制要求 ≥1 条 E5 实测证据，推荐 Agent 优先引用高证据参数）、项目按用户隔离（ezPLM 传 X-User-Id 或匿名 cookie，各自只见自己的项目）、首页项目驾驶舱与比赛倒计时
- **二期**：真实编译流水线（CI 安装 arm-none-eabi-gcc/CCS CLI 编译后回写 `code_verifier` 的 external_status；ci.yml 已留注释位）、ezPLM SSO 正式账号体系（organization/membership/项目角色）、LabSight 仪器接入、SSE 推送替代轮询、报告分章节编辑
- **三期**：淘宝商品自动采集与 AI 芯片识别、模块知识图谱（依赖/替换/兼容/历届题目关系）、Word/PDF/LaTeX 报告导出、付费模块市场结算
