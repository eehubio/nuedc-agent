/** 后台 Worker：常驻进程消费 agent_tasks 队列。
 *
 *  部署方式（本项目选定常驻模式）：
 *    npm run worker                      # 本地或服务器直接跑
 *    pm2 start npm --name nuedc-worker -- run worker
 *    docker run ... npm run worker       # 容器常驻
 *
 *  环境变量：
 *    DATABASE_URL            必填，与 Web 同一个库
 *    WORKER_ID               可选，默认 hostname:pid
 *    WORKER_HEAVY_SLOTS      重型任务并发（默认 2）
 *    WORKER_LIGHT_SLOTS      轻型任务并发（默认 6）
 *    WORKER_POLL_MS          空闲轮询间隔（默认 1500）
 *
 *  可靠性：租约 90 秒、心跳 30 秒续租；进程崩溃后租约到期，
 *  任务由任意 Worker 的回收循环重新入队，不会永久卡死也不会重复扣费。 */

import { hostname } from "node:os";
import "../lib/agents/index";
import { runAgent, isRetryable, classifyAgentError } from "../lib/agents/base";
import { claimTask, heartbeat, reclaimExpired, completeTask, failTask, workerHeartbeat, workerDeregister, pruneStaleHeartbeats, HEARTBEAT_MS, type ClaimedTask } from "../lib/task-queue";
import { db, ensureSchema, closeTxPool } from "../lib/db";
import { metrics } from "../lib/worker-metrics";
import type { AgentType, ProjectStage } from "../lib/types";

const WORKER_ID = process.env.WORKER_ID || `${hostname()}:${process.pid}`;
const HEAVY_SLOTS = Number(process.env.WORKER_HEAVY_SLOTS || 2);
const LIGHT_SLOTS = Number(process.env.WORKER_LIGHT_SLOTS || 6);
const POLL_MS = Number(process.env.WORKER_POLL_MS || 1500);
/** 取消轮询间隔：独立于 30 秒的租约心跳。
 *  取消需要尽快 abort 掉正在进行的 Provider 请求，否则会继续烧 token。 */
const CANCEL_POLL_MS = Number(process.env.WORKER_CANCEL_POLL_MS || 3000);

let shuttingDown = false;
let inFlight = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function log(...args: any[]) {
  console.log(`[${new Date().toISOString()}] [${WORKER_ID}]`, ...args);
}

async function executeOne(task: ClaimedTask): Promise<void> {
  inFlight++;
  metrics.taskStarted();
  const abort = new AbortController();
  let canceledByPoll = false;

  // 租约心跳：30 秒续租一次，仅维持任务归属
  const hb = setInterval(async () => {
    metrics.heartbeat();
    const alive = await heartbeat(task.task_id, WORKER_ID);
    if (!alive) log(`⚠ ${task.task_id} 租约已失效（可能已被回收），本次结果将被丢弃`);
  }, HEARTBEAT_MS);

  // 取消轮询：独立于心跳，默认 3 秒一次。
  // 与心跳合并会让取消最坏延迟 30 秒才生效，Provider 请求白烧那么久的 token。
  const cancelPoll = setInterval(async () => {
    if (abort.signal.aborted) return;
    metrics.cancelPoll();
    const c = await db().execute({
      sql: "SELECT cancel_requested FROM agent_tasks WHERE task_id=?", args: [task.task_id],
    }).catch(() => { metrics.cancelPollError(); return { rows: [] as any[] }; });
    if (Number((c.rows[0] as any)?.cancel_requested || 0) === 1) {
      const detectedAt = Date.now();
      canceledByPoll = true;
      metrics.cancelRequested();
      abort.abort();
      metrics.cancelAbortLatency(Date.now() - detectedAt);
      log(`✋ ${task.task_id} 收到取消请求，正在中断 Provider 调用`);
    }
  }, CANCEL_POLL_MS);

  try {
    const input = task.input ? JSON.parse(task.input) : {};
    let stage: ProjectStage = "PREPARATION";
    if (task.project_id) {
      const rs = await db().execute({ sql: "SELECT stage FROM projects WHERE project_id=?", args: [task.project_id] });
      if (rs.rows.length) stage = String(rs.rows[0].stage) as ProjectStage;
    }

    // 执行前已被请求取消 → 直接作废，不发起任何 Provider 调用
    const cancelCheck = await db().execute({
      sql: "SELECT cancel_requested FROM agent_tasks WHERE task_id=?", args: [task.task_id],
    }).catch(() => ({ rows: [] as any[] }));
    if (Number((cancelCheck.rows[0] as any)?.cancel_requested || 0) === 1) {
      await completeTask({ taskId: task.task_id, workerId: WORKER_ID, ok: false, canceled: true, result: null });
      log(`✋ ${task.task_id} 已取消（未开始，全额退款）`);
      return;
    }

    const result = await runAgent(task.agent_type as AgentType, input, {
      projectId: task.project_id,
      stage,
      tier: task.tier as any,
      owner: task.owner_ref,
      taskId: task.task_id,
      signal: abort.signal,
    });

    const canceled = await db().execute({
      sql: "SELECT cancel_requested FROM agent_tasks WHERE task_id=?", args: [task.task_id],
    }).catch(() => ({ rows: [] as any[] }));
    const wasCanceled = canceledByPoll || Number((canceled.rows[0] as any)?.cancel_requested || 0) === 1
      || result.error_code === "CANCELED";

    if (wasCanceled) {
      // 取消：canceled 终态。completeTask 会按实际用量计费、未用部分退款（配额 refund）。
      await completeTask({
        taskId: task.task_id, workerId: WORKER_ID,
        ok: false, canceled: true, result, runId: result.run_id, errorCode: "CANCELED",
      });
      log(`✋ ${task.task_id} ${task.agent_type} 已取消（已用 token 计费，未用部分退款）`);
    } else if (result.ok) {
      await completeTask({
        taskId: task.task_id, workerId: WORKER_ID,
        ok: true, canceled: false, result, runId: result.run_id, errorCode: null,
      });
      log(`✓ ${task.task_id} ${task.agent_type} (${task.task_type || "-"})`);
    } else {
      // Agent 失败：结构化错误决定重试还是终态
      const retryable = result.retryable === true || isRetryable(result.error_code);
      if (retryable) {
        const outcome = await failTask({
          taskId: task.task_id, workerId: WORKER_ID,
          message: result.message || "agent failed",
          errorCode: result.error_code || "UNKNOWN", retryable: true,
        });
        log(`↻ ${task.task_id} ${task.agent_type} 失败(${result.error_code}) → ${outcome}: ${(result.message || "").slice(0, 60)}`);
      } else {
        await completeTask({
          taskId: task.task_id, workerId: WORKER_ID,
          ok: false, canceled: false, result, runId: result.run_id,
          errorCode: result.error_code || "UNKNOWN",
        });
        log(`✗ ${task.task_id} ${task.agent_type} 不可重试(${result.error_code}): ${(result.message || "").slice(0, 60)}`);
      }
    }
  } catch (e: any) {
    // 取消触发的异常：按取消处理，而非重试
    if (canceledByPoll || abort.signal.aborted) {
      await completeTask({ taskId: task.task_id, workerId: WORKER_ID, ok: false, canceled: true, result: null, errorCode: "CANCELED" }).catch(() => {});
      log(`✋ ${task.task_id} 取消中断`);
    } else {
      const msg = String(e?.message || e);
      const code = classifyAgentError(msg);
      const retryable = isRetryable(code) || /timeout|ECONN|fetch failed|socket|502|503|504/i.test(msg);
      const outcome = await failTask({
        taskId: task.task_id, workerId: WORKER_ID, message: msg,
        errorCode: code, retryable,
      });
      log(`✗ ${task.task_id} 异常(${code}) → ${outcome}: ${msg.slice(0, 100)}`);
    }
  } finally {
    clearInterval(hb);
    clearInterval(cancelPoll);
    metrics.taskEnded();
    inFlight--;
  }
}

/** 回收循环：处理其他 Worker 崩溃遗留的任务 */
async function reclaimLoop() {
  while (!shuttingDown) {
    try {
      const { requeued, dead } = await reclaimExpired();
      if (requeued || dead) log(`回收：${requeued} 个重新入队，${dead} 个进入死信`);
      // 顺带清理 24 小时以上的僵尸心跳（容器重建会留下永不更新的行）
      const pruned = await pruneStaleHeartbeats(24);
      if (pruned) log(`清理僵尸心跳 ${pruned} 条`);
    } catch (e: any) {
      log("回收循环异常:", String(e?.message || e).slice(0, 120));
    }
    await sleep(30_000);
  }
}

/** 消费循环：按并发槽位认领任务 */
async function consumeLoop(heavy: boolean, slots: number) {
  const running = new Set<Promise<void>>();
  while (!shuttingDown) {
    if (running.size >= slots) {
      await Promise.race(running);
      continue;
    }
    let task: ClaimedTask | null = null;
    try {
      task = await claimTask(WORKER_ID, { heavy });
    } catch (e: any) {
      log("认领异常:", String(e?.message || e).slice(0, 120));
      await sleep(3000);
      continue;
    }
    if (!task) { await sleep(POLL_MS); continue; }

    const p = executeOne(task).finally(() => running.delete(p));
    running.add(p);
  }
  await Promise.allSettled([...running]);
}

/** Worker 存活心跳循环：上报槽位与在途数，供 readiness 与失联报警使用 */
async function workerBeatLoop() {
  while (!shuttingDown) {
    try {
      await workerHeartbeat({
        workerId: WORKER_ID, host: hostname(), pid: process.pid,
        heavySlots: HEAVY_SLOTS, lightSlots: LIGHT_SLOTS, inFlight,
      });
    } catch (e: any) {
      log("心跳上报异常:", String(e?.message || e).slice(0, 120));
    }
    await sleep(HEARTBEAT_MS);
  }
}

async function main() {
  await ensureSchema();
  log(`启动：重型槽位 ${HEAVY_SLOTS} · 轻型槽位 ${LIGHT_SLOTS} · 轮询 ${POLL_MS}ms`);
  // 启动即上报一次，避免 readiness 在首个心跳周期前误判无 Worker
  await workerHeartbeat({
    workerId: WORKER_ID, host: hostname(), pid: process.pid,
    heavySlots: HEAVY_SLOTS, lightSlots: LIGHT_SLOTS, inFlight: 0,
  });

  const shutdown = async (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`收到 ${sig}，停止认领新任务，等待 ${inFlight} 个在途任务完成…`);
    const deadline = Date.now() + 120_000;
    while (inFlight > 0 && Date.now() < deadline) await sleep(500);
    // 未完成的任务释放租约，让其他 Worker 立刻接管
    await db().execute({
      sql: `UPDATE agent_tasks SET status='queued', worker_id=NULL, lease_expires_at=NULL, updated_at=now()
            WHERE worker_id=? AND status='running'`,
      args: [WORKER_ID],
    }).catch(() => {});
    // 注销心跳，避免被误判为「失联 Worker」
    await workerDeregister(WORKER_ID);
    // 关闭共享事务连接池，释放 Neon 连接
    await closeTxPool();
    log("已优雅退出");
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  await Promise.all([
    consumeLoop(true, HEAVY_SLOTS),
    consumeLoop(false, LIGHT_SLOTS),
    reclaimLoop(),
    workerBeatLoop(),
  ]);
}

main().catch((e) => { console.error("Worker 致命错误:", e); process.exit(1); });
