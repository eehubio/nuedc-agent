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
import { runAgent } from "../lib/agents/base";
import { claimTask, heartbeat, reclaimExpired, completeTask, failTask, HEARTBEAT_MS, type ClaimedTask } from "../lib/task-queue";
import { db, ensureSchema } from "../lib/db";
import type { AgentType, ProjectStage } from "../lib/types";

const WORKER_ID = process.env.WORKER_ID || `${hostname()}:${process.pid}`;
const HEAVY_SLOTS = Number(process.env.WORKER_HEAVY_SLOTS || 2);
const LIGHT_SLOTS = Number(process.env.WORKER_LIGHT_SLOTS || 6);
const POLL_MS = Number(process.env.WORKER_POLL_MS || 1500);

let shuttingDown = false;
let inFlight = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function log(...args: any[]) {
  console.log(`[${new Date().toISOString()}] [${WORKER_ID}]`, ...args);
}

async function executeOne(task: ClaimedTask): Promise<void> {
  inFlight++;
  const hb = setInterval(async () => {
    const alive = await heartbeat(task.task_id, WORKER_ID);
    if (!alive) log(`⚠ ${task.task_id} 租约已失效（可能已被回收），本次结果将被丢弃`);
  }, HEARTBEAT_MS);

  try {
    const input = task.input ? JSON.parse(task.input) : {};
    let stage: ProjectStage = "PREPARATION";
    if (task.project_id) {
      const rs = await db().execute({ sql: "SELECT stage FROM projects WHERE project_id=?", args: [task.project_id] });
      if (rs.rows.length) stage = String(rs.rows[0].stage) as ProjectStage;
    }

    // 执行期间被请求取消 → 结果作废（LLM 调用无法中途打断，只能事后判定）
    const cancelCheck = await db().execute({
      sql: "SELECT cancel_requested FROM agent_tasks WHERE task_id=?", args: [task.task_id],
    }).catch(() => ({ rows: [] as any[] }));
    if (Number((cancelCheck.rows[0] as any)?.cancel_requested || 0) === 1) {
      await completeTask({ taskId: task.task_id, workerId: WORKER_ID, ok: false, canceled: true, result: null });
      log(`✋ ${task.task_id} 已取消`);
      return;
    }

    const result = await runAgent(task.agent_type as AgentType, input, {
      projectId: task.project_id,
      stage,
      tier: task.tier as any,
      owner: task.owner_ref,
      taskId: task.task_id,
    });

    const canceled = await db().execute({
      sql: "SELECT cancel_requested FROM agent_tasks WHERE task_id=?", args: [task.task_id],
    }).catch(() => ({ rows: [] as any[] }));
    const wasCanceled = Number((canceled.rows[0] as any)?.cancel_requested || 0) === 1;

    await completeTask({
      taskId: task.task_id, workerId: WORKER_ID,
      ok: result.ok, canceled: wasCanceled, result, runId: result.run_id,
      errorCode: result.ok ? null : "AGENT_FAILED",
    });
    log(`${result.ok ? "✓" : "✗"} ${task.task_id} ${task.agent_type} (${task.task_type || "-"})${result.ok ? "" : " · " + (result.message || "").slice(0, 60)}`);
  } catch (e: any) {
    const msg = String(e?.message || e);
    // 网络/超时类错误可重试；业务错误不重试
    const retryable = /timeout|ECONN|fetch failed|socket|502|503|504/i.test(msg);
    const outcome = await failTask({
      taskId: task.task_id, workerId: WORKER_ID, message: msg,
      errorCode: retryable ? "TRANSIENT" : "EXECUTION_ERROR", retryable,
    });
    log(`✗ ${task.task_id} 异常 → ${outcome}: ${msg.slice(0, 100)}`);
  } finally {
    clearInterval(hb);
    inFlight--;
  }
}

/** 回收循环：处理其他 Worker 崩溃遗留的任务 */
async function reclaimLoop() {
  while (!shuttingDown) {
    try {
      const { requeued, dead } = await reclaimExpired();
      if (requeued || dead) log(`回收：${requeued} 个重新入队，${dead} 个进入死信`);
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

async function main() {
  await ensureSchema();
  log(`启动：重型槽位 ${HEAVY_SLOTS} · 轻型槽位 ${LIGHT_SLOTS} · 轮询 ${POLL_MS}ms`);

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
    log("已优雅退出");
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  await Promise.all([
    consumeLoop(true, HEAVY_SLOTS),
    consumeLoop(false, LIGHT_SLOTS),
    reclaimLoop(),
  ]);
}

main().catch((e) => { console.error("Worker 致命错误:", e); process.exit(1); });
