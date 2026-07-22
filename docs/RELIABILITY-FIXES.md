# 生产化整改 · 剩余可靠性问题定位与迁移方案

本轮聚焦四类残留缺陷：**任务重试链路断裂**、**跨用户去重泄漏**、**Partial 结果落库不统一**、**赛题版本事务缺失**。以下先给出根因定位，再给出数据库迁移方案，最后是代码改动（分三个提交）。

---

## 一、问题定位

### P0-A：Worker 无法真正重试 Agent 失败

`runAgent`（`lib/agents/base.ts`）用 `try/catch` 吞掉所有异常，统一返回 `{ ok:false }`。Worker（`scripts/agent-worker.mts`）拿到 `ok=false` 后走 `completeTask`（写 error 终态），**永远不会调用 `failTask`**。

后果：Provider 返回 429 / 503 / 超时时，Agent 层已把它降级成"业务失败"，任务直接进 `error` 终态并退款，不重新入队。用户看到的是"生成失败"，而实际上只要重试一次就能成功。可重试与不可重试的错误被一视同仁。

根因：`AgentResult` 缺少结构化错误字段（`error_code` / `retryable` / `provider_error_code`），Worker 无法区分"值得重试"和"重试也没用"。

### P0-B：跨用户任务去重（数据泄漏 + 越权）

`app/api/agent-tasks/route.ts` 的 `input_hash` 去重（第 53–61 行）只按 `input_hash + created_at` 匹配，**完全不限定 owner_ref / project_id / tier**：

```sql
SELECT task_id, status FROM agent_tasks
WHERE input_hash=? AND created_at > now() - interval '10 minutes'
  AND status IN ('queued','running','ok')
```

后果：用户 B 提交与用户 A 完全相同的输入时，直接拿到用户 A 的 `task_id`。B 能读到 A 的任务产物；A 的配额被 B 蹭用；不同 Tier（free/paid）也会互相命中。这是**跨租户数据泄漏 + 配额越权**。

同时 `idempotency_key` 的唯一索引是全局 `UNIQUE(idempotency_key)`（迁移 6），不同用户用相同 key（比如前端都用 `"submit"`）会相互覆盖。

设计原则修正：**公共结果复用只能走 `model_cache`（已按 provider+model+scope 隔离，且只存模型输出不含任务归属），绝不能复用他人的 `agent_task`**。

### P0-C：去重是 SELECT-then-INSERT，存在竞态

现有并发去重（同项目同 agent 活动任务）和 input_hash 去重都是"先查后插"。两个请求同时到达时都查到"无重复"，于是各插一条，去重失效 —— 连点两下仍会烧两次 LLM。必须改成数据库唯一约束 + `INSERT ... ON CONFLICT DO NOTHING RETURNING` 的原子幂等。

### P1-D：Partial 结果落库不统一

`runAgent` 已在 ALS 里维护 `partialSeen`（截断修复标记），但 `saveArtifact` 的调用（`base.ts` 第 115 行）**没有读取它**。是否 partial 完全依赖每个 Agent 自己在 `output` 里塞 `partial_output` 字段并自己设 `human_review_required` —— 只有 `solution_architect` 和 `bom_agent` 做了，其它 Agent 一旦截断就会把残缺结果当 `reviewed` 正式产物落库。

而且 `artifacts` 表没有 `metadata` 列，partial 语义无处安放。

### P1-E：任务重量靠 Token 阈值隐式推断

`task-policy.ts` 的 `concurrencyClass` 和 `costClass` 都由 `maxOutputTokens` 阈值算出（`> 3000 ? "heavy" : "light"`）。改一次 `maxOutputTokens`（纯粹是成本调优）就会意外改变任务的队列归属和配额类别。整改要求：**每个 TaskType 显式声明 `concurrencyClass` 与 `costClass`**，与 token 预算解耦。

### P1-F：无法真正取消 Provider 请求

`ProviderRequest` 没有 `AbortSignal`。取消只能"事后作废"——LLM 已经算完、token 已经烧掉，只是丢弃结果。要做到真正取消：Worker 建 `AbortController`，周期检查 `cancel_requested`，触发 `abort()`；Provider adapter 识别 `AbortError`；已用 token 照常计费，未开始部分退款。

### P1-G：Provider 健康只看 HTTP 传输层

`health.ts` 只按 `status='error'`（传输失败）和 429 熔断。一个 Provider 可能 HTTP 一直 200，但 JSON 解析不了 / schema 老是不过 —— 对某个 TaskType 实际不可用，却被判定"健康"，继续被选中。要按 `provider + model + task_type` 分别统计 `transport / parse / schema / timeout / 429` 五个维度，schema 长期失败的 Provider 不再承担该 TaskType。

### P1-H：赛题版本并发与发布无事务

`createDraftVersion`（`problem-center.ts`）用 `SELECT MAX(version_no)+1` 再 INSERT，两人同时建草稿会撞版本号（`UNIQUE(problem_id, version_no)` 已存在，会直接抛错而非重试）。`publishVersion` 是多条独立 UPDATE，没有事务：清单检查与实际发布之间存在 TOCTOU 窗口，且中途失败会留下"半发布"状态。

### P1-I：发布清单不够严

正式 Requirement 只要求"页码**或**原文引用"二选一。整改要求正式需求**同时**具备 `source_page` + `source_quote`；人工补充的要求可例外，但必须标 `source_type=STAFF_ADDED` + `reviewer` + `reason`。Contest 需要预期评分结构（`expected_total_score` 等）用于发布时核对。

### P2-J：Worker 部署与可观测性缺失

无 `Dockerfile.worker`、无 health/readiness endpoint、无 worker 心跳表、无积压/失联报警。Vercel 只跑 Web，Worker 必须独立部署这点 README 未明确。

---

## 二、数据库迁移方案

全部通过**追加新迁移**实现（迁移 16–19），不改动已发布的旧迁移，符合 `migrations.ts` 的约定。

### 迁移 16：任务去重与重试字段

```sql
-- 去重四元组显式落列（原本散落在 input_hash 里）
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS dedup_key TEXT;   -- owner+project+agent+input_hash 的复合摘要
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS retryable INTEGER;
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS provider_error_code TEXT;
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS cost_class TEXT;

-- 幂等键改为「按用户」唯一：不同用户可用相同 key，互不干扰
DROP INDEX IF EXISTS idx_tasks_idem;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_idem_owner
  ON agent_tasks(owner_ref, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- 活动任务并发去重：同一 dedup_key 同时只允许一条活动任务（queued/running）
-- 用部分唯一索引实现「原子去重」，替代 SELECT-then-INSERT
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_active_dedup
  ON agent_tasks(dedup_key) WHERE status IN ('queued','running') AND dedup_key IS NOT NULL;
```

**关键点**：`dedup_key` 由 `sha256(owner_ref | project_id | agent_type | tier | input_hash)` 生成，把去重严格限定到"同一用户、同一项目、同一 Tier、同一输入"。活动任务的部分唯一索引让 `INSERT ... ON CONFLICT DO NOTHING RETURNING` 成为原子幂等的唯一真相来源。

### 迁移 17：Partial 落库

```sql
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS metadata TEXT;              -- JSON：partial_output / repair_applied 等
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS human_review_required INTEGER DEFAULT 0;
```

### 迁移 18：Provider 分任务质量健康

```sql
CREATE TABLE IF NOT EXISTS provider_task_health (
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  task_type TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,   -- 按小时滚动
  transport_ok INTEGER DEFAULT 0, transport_total INTEGER DEFAULT 0,
  parse_ok INTEGER DEFAULT 0,     parse_total INTEGER DEFAULT 0,
  schema_ok INTEGER DEFAULT 0,    schema_total INTEGER DEFAULT 0,
  timeout_n INTEGER DEFAULT 0,    rate429_n INTEGER DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (provider, model, task_type, window_start)
);
CREATE INDEX IF NOT EXISTS idx_ptask_health ON provider_task_health(provider, model, task_type, window_start DESC);
```

`llm_usage_events` 已有 `status` / `error_code`，健康统计从事件流实时聚合；本表用于跨窗口累积与快速判定"某 Provider 对某 TaskType 的 schema 成功率"。

### 迁移 19：赛题发布加严 + 心跳表

```sql
-- 正式需求溯源类型（区分 AI 提取 / 工作人员补充）
ALTER TABLE problem_requirements ADD COLUMN IF NOT EXISTS source_type TEXT DEFAULT 'AI_EXTRACTED';
ALTER TABLE problem_requirements ADD COLUMN IF NOT EXISTS staff_reviewer TEXT;
ALTER TABLE problem_requirements ADD COLUMN IF NOT EXISTS staff_reason TEXT;

-- Contest 预期评分结构（发布时核对）
ALTER TABLE problem_versions ADD COLUMN IF NOT EXISTS expected_total_score NUMERIC(8,2);
ALTER TABLE problem_versions ADD COLUMN IF NOT EXISTS expected_report_score NUMERIC(8,2);
ALTER TABLE problem_versions ADD COLUMN IF NOT EXISTS expected_basic_score NUMERIC(8,2);
ALTER TABLE problem_versions ADD COLUMN IF NOT EXISTS expected_advanced_score NUMERIC(8,2);

-- Worker 心跳表（失联/积压报警）
CREATE TABLE IF NOT EXISTS worker_heartbeats (
  worker_id TEXT PRIMARY KEY,
  host TEXT, pid INTEGER,
  heavy_slots INTEGER, light_slots INTEGER,
  in_flight INTEGER DEFAULT 0,
  last_beat_at TIMESTAMPTZ DEFAULT now(),
  started_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_worker_beat ON worker_heartbeats(last_beat_at);
```

`UNIQUE(problem_id, version_no)` 已存在（迁移 14），无需重复。`createDraftVersion` 改为在唯一冲突时重试即可。

---

## 三、提交划分

- **Commit 1**：任务重试（结构化错误 + Worker 分流）、原子去重（dedup_key + 按用户幂等键 + ON CONFLICT）、Partial 统一落库。迁移 16、17。
- **Commit 2**：任务重量显式化（concurrency/cost class）、真正取消（AbortSignal 全链路）、Provider 分任务健康指标。迁移 18。
- **Commit 3**：赛题版本并发与发布事务、发布清单加严、Worker 部署（Dockerfile/health/readiness/心跳/报警）与 CI。迁移 19。

每个提交都附带对应的 mock 数据库集成测试。
