# 压测与部署验证手册

本轮的完成标准不是代码量，而是**可重复的验证过程**和**真实压测数据**。
代码侧的准备已完成（见下方"已就绪"），但**真实数据必须在你的部署环境上跑出来** ——
沙箱连不到 Vercel / Railway / Neon，任何在本地编造的"压测报告"都是假的。

---

## 零、前置检查（每次压测前必做）

```bash
export BASE=https://nuedc-agent.vercel.app
export ADMIN=你的ADMIN_API_KEY

curl -s -H "X-Api-Key: $ADMIN" "$BASE/api/admin/readiness" | python3 -m json.tool
```

必须确认：

| 字段 | 期望 | 不满足的后果 |
| --- | --- | --- |
| `ready` | `true` | 有 warnings 时先解决 |
| `workers.live` | ≥ 1 | 为 0 则任务永远排队不执行 |
| `workers.detail[].heartbeat_age_sec` | < 60 | 过大说明 Worker 卡死或失联 |
| `versions.web_sha` vs `worker_shas` | 一致 | **不一致说明两边跑不同代码，压测结果无意义** |
| `queue.total_queued` | 接近 0 | 有存量任务会污染延迟统计 |
| `usage_today.estimated_cost_usd` | 记下基线 | 用于事后核算本次压测花费 |

版本不一致时 `warnings` 会明确列出。Web 在 Vercel、Worker 在 Railway，
**两边是独立部署，很容易出现只更新了一边的情况**。

---

## 一、四种压测模式

### 1. queue-only（零成本，先跑这个）

只验证入队、去重、配额、队列深度，不调用模型。

```bash
LOAD_MODE=queue-only LOAD_USERS=300 LOAD_RAMP_SEC=30 \
BASE_URL=$BASE ADMIN_API_KEY=$ADMIN \
LOAD_OUT=reports/queue-only.json \
npx tsx scripts/load-test.mts
```

关注：`enqueue.success_rate`、`enqueue.dedup_correct`、`db_query_errors`。

### 2. mock-provider（零成本，端到端）

300 用户走完整调度链路，Provider 返回固定假数据。

**前提**：服务端必须已设 `ENABLE_MOCK_PROVIDER=1` 并重新部署。
脚本会调用 `/api/routing-preview` 向服务端确认，**未确认则拒绝执行**
（只看本地环境变量不可靠 —— 变量在你机器上，Provider 在服务端）。

```bash
LOAD_MODE=mock-provider LOAD_USERS=300 LOAD_RAMP_SEC=60 \
BASE_URL=$BASE ADMIN_API_KEY=$ADMIN \
LOAD_OUT=reports/mock.json \
npx tsx scripts/load-test.mts
```

关注：`latency_ms.queue_wait_p95/p99`、`execution_p95/p99`、`execution.by_status`。

### 3. real-provider-light（**产生真实费用**）

30 个真实低成本模型任务，验证真实 Provider 链路。

```bash
LOAD_MODE=real-provider-light LOAD_USERS=30 \
CONFIRM_REAL_COST=1 \
BASE_URL=$BASE ADMIN_API_KEY=$ADMIN \
LOAD_OUT=reports/real-light.json \
npx tsx scripts/load-test.mts
```

关注：`cost.per_task_usd`、`cost.per_task_input/output`、`execution.error_codes`。
**先用 `LOAD_USERS=5` 试跑一次核对单价，再放大到 30。**

### 4. fallback-drill（**产生真实费用**）

验证主 Provider 故障时切换到备用模型。

先人工制造故障，二选一：
- 在 `/admin` 里禁用主 Provider（`disableProvider`）
- 或把主 Provider 的 Key 临时改错

```bash
LOAD_MODE=fallback-drill LOAD_USERS=20 \
CONFIRM_REAL_COST=1 \
BASE_URL=$BASE ADMIN_API_KEY=$ADMIN \
LOAD_OUT=reports/fallback.json \
npx tsx scripts/load-test.mts
```

关注：`provider.fallback_count` > 0、`provider.by_provider` 出现备用模型、
`execution.ok` 仍接近总数（说明切换成功而非直接失败）。

**跑完记得把 Provider 恢复。**

---

## 二、取消轮询负载观测

判断 3 秒轮询是否需要换成 Redis / 事件推送，**先拿数据再决定**。

保持 100 个任务运行 5 分钟：

```bash
LOAD_MODE=mock-provider LOAD_USERS=100 LOAD_HOLD_SEC=300 \
BASE_URL=$BASE ADMIN_API_KEY=$ADMIN \
npx tsx scripts/load-test.mts
```

同时在 Railway 的 Worker 日志里观察，或查 Neon 的连接数与 QPS。

理论值：100 个在途任务 × (1/3s) ≈ **33 QPS** 取消轮询。
判断标准：

- 若取消轮询 QPS < 总 DB QPS 的 20%，且任务认领 / 心跳 / 业务查询延迟无明显上升 → **维持现状，不引入 Redis**
- 若明显挤占，再考虑：调大 `WORKER_CANCEL_POLL_MS`、或改用 Postgres `LISTEN/NOTIFY`（比 Redis 更省一个组件）

`lib/worker-metrics.ts` 已记录 `cancel_poll_queries`、`cancel_poll_db_errors`、
`cancel_abort_latency_p50/p95` 与各类 QPS。

---

## 三、GitHub Actions 真实状态验证

**这一步只能你做** —— 我没有仓库访问权，看不到 Actions 运行状态。

推送后到 commit 页面确认出现两个 Check：

```
CI / build-and-test (20)
CI / build-and-test (22)
```

若没有出现，按顺序排查：

1. **Settings → Actions → General** —— 是否为 Disabled
2. **Settings → Actions → General → Workflow permissions** —— 是否为 restricted
   （workflow 已声明 `checks: write` / `statuses: write`，但仓库级限制会覆盖它）
3. **组织策略** —— 组织可能禁用了 fork/私有仓库的 Actions
4. **手工触发**：Actions 页签 → CI → Run workflow
   （已加 `workflow_dispatch`，这是判断"Actions 本身能不能跑"的最快方式）

跑起来后，每次运行会上传 artifact：`junit.xml`、`worker-startup.log`、
`load-test-summary.txt`，在运行页面底部下载。

---

## 四、压测后清理

压测项目统一使用 `__loadtest_` 前缀：

```sql
-- 先确认范围
SELECT COUNT(*) FROM projects WHERE name LIKE '__loadtest_%';

-- 关联数据
DELETE FROM artifacts   WHERE project_id IN (SELECT project_id FROM projects WHERE name LIKE '__loadtest_%');
DELETE FROM agent_runs  WHERE project_id IN (SELECT project_id FROM projects WHERE name LIKE '__loadtest_%');
DELETE FROM agent_tasks WHERE project_id IN (SELECT project_id FROM projects WHERE name LIKE '__loadtest_%');
DELETE FROM events      WHERE project_id IN (SELECT project_id FROM projects WHERE name LIKE '__loadtest_%');
DELETE FROM projects    WHERE name LIKE '__loadtest_%';

-- 配额计数（压测会占满当日配额）
DELETE FROM quota_counters WHERE day = CURRENT_DATE;
```

---

## 五、压测报告模板

四种模式各跑一次后，填这张表：

| 指标 | queue-only | mock-provider | real-light | fallback-drill |
| --- | --- | --- | --- | --- |
| 用户数 | 300 | 300 | 30 | 20 |
| 入队成功率 | | | | |
| 去重正确 | | | | |
| queue wait p50 / p95 / p99 | | | | |
| execution p50 / p95 / p99 | | | | |
| 配额净扣次数 | | | | |
| DB query errors | | | | |
| lease reclaim 数 | | | | |
| duplicate artifact 数 | | | | |
| Provider fallback 数 | — | — | | |
| 单任务 token（in/out） | — | | | |
| 单任务成本 | — | — | | |
| 本次总成本 | 0 | 0 | | |

`lease reclaim` 与 `duplicate artifact` 需要单独查库：

```sql
-- 压测期间的租约回收（任务被重新入队的次数）
SELECT COUNT(*) FROM agent_tasks
WHERE attempts > 1 AND created_at > now() - interval '1 hour';

-- 重复产物（同项目同类型同版本应唯一）
SELECT project_id, type, version, COUNT(*) c FROM artifacts
GROUP BY project_id, type, version HAVING COUNT(*) > 1;
```

---

## 已就绪（代码侧）

- 事务内不再访问全局 db，读写同一快照
- 进程级共享连接池，可配置 max / idle / connection timeout
- 唯一冲突按约束名精确分流，未知冲突退款 + 409
- 五处赛题子表写入全部收口到 `withVersionWriteLock`
- 取消轮询指标齐备
- readiness 总览含三个 SHA 与版本漂移告警
- CI 含 `workflow_dispatch` 与三类 artifact
- 四模式压测脚本，含服务端 mock 预检与真实成本安全阀

## 待你完成（需要真实环境）

- 四种模式各跑一次，填写上方报告表
- 取消轮询 QPS 实测，据此决定是否需要 Redis
- 确认 GitHub Actions 真实产出两个 Check
