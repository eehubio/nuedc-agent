import { db, ensureSchema } from "./db";
import { commitQuota, refundQuota } from "./usage";

/** 任务队列：原子认领、租约续期、崩溃回收、死信。
 *  设计要点：
 *  - 认领用 FOR UPDATE SKIP LOCKED，多 Worker 并发不会抢到同一条
 *  - lease_expires_at 到期即视为 Worker 失联，任务重新入队（崩溃自愈）
 *  - 配额预占与任务绑定（quota_ref），终态时统一 commit/refund，不重复扣费 */

export const LEASE_MS = 90_000;        // 租约时长：超过即认定 Worker 失联
export const HEARTBEAT_MS = 30_000;    // 心跳间隔：每次续租

export interface ClaimedTask {
  task_id: string;
  agent_type: string;
  task_type: string | null;
  project_id: string | null;
  owner_ref: string | null;
  input: string | null;
  tier: string;
  priority: number;
  attempts: number;
  max_attempts: number;
  quota_ref: string | null;
  quota_kind: string | null;
}

/** 原子认领一个任务。concurrencyClass 为空时不限类型。 */
export async function claimTask(workerId: string, opts: { heavy?: boolean } = {}): Promise<ClaimedTask | null> {
  await ensureSchema();
  // queue_name 记录的是 concurrencyClass（light/heavy）
  const filter = opts.heavy === undefined ? "" : "AND queue_name = ?";
  const args: any[] = [];
  if (opts.heavy !== undefined) args.push(opts.heavy ? "heavy" : "light");

  const rs = await db().execute({
    sql: `UPDATE agent_tasks SET
            status='running', worker_id=?, started_at=COALESCE(started_at, now()),
            lease_expires_at = now() + interval '${LEASE_MS} milliseconds',
            heartbeat_at = now(), attempts = attempts + 1, updated_at = now()
          WHERE task_id = (
            SELECT task_id FROM agent_tasks
            WHERE status='queued' AND (scheduled_at IS NULL OR scheduled_at <= now()) ${filter}
            ORDER BY priority ASC, scheduled_at ASC NULLS FIRST, created_at ASC
            LIMIT 1 FOR UPDATE SKIP LOCKED
          )
          RETURNING task_id, agent_type, task_type, project_id, owner_ref, input, tier,
                    priority, attempts, max_attempts, quota_ref, quota_kind`,
    args: [workerId, ...args],
  });
  return (rs.rows[0] as any) || null;
}

/** 心跳续租。返回 false 表示任务已被回收（Worker 应放弃继续写结果）。 */
export async function heartbeat(taskId: string, workerId: string): Promise<boolean> {
  const rs = await db().execute({
    sql: `UPDATE agent_tasks SET heartbeat_at = now(),
            lease_expires_at = now() + interval '${LEASE_MS} milliseconds', updated_at = now()
          WHERE task_id=? AND worker_id=? AND status='running' RETURNING task_id`,
    args: [taskId, workerId],
  }).catch(() => ({ rows: [] as any[] }));
  return rs.rows.length > 0;
}

/** 回收失联任务：租约过期的 running 任务重新入队；超过重试上限进死信。 */
export async function reclaimExpired(): Promise<{ requeued: number; dead: number }> {
  await ensureSchema();
  const requeue = await db().execute({
    sql: `UPDATE agent_tasks SET status='queued', worker_id=NULL, lease_expires_at=NULL,
            scheduled_at = now() + interval '5 seconds', updated_at=now()
          WHERE status='running' AND lease_expires_at < now()
            AND attempts < max_attempts
          RETURNING task_id`,
    args: [],
  }).catch(() => ({ rows: [] as any[] }));

  const dead = await db().execute({
    sql: `UPDATE agent_tasks SET status='dead', worker_id=NULL, lease_expires_at=NULL,
            dead_reason='Worker 失联且已达最大重试次数', completed_at=now(), updated_at=now()
          WHERE status='running' AND lease_expires_at < now() AND attempts >= max_attempts
          RETURNING task_id, owner_ref, quota_ref, quota_kind`,
    args: [],
  }).catch(() => ({ rows: [] as any[] }));

  // 死信任务返还未完成的配额预占
  for (const r of dead.rows as any[]) {
    if (r.quota_ref && r.owner_ref && r.quota_kind) {
      await refundQuota(String(r.owner_ref), String(r.quota_kind), String(r.quota_ref));
    }
  }
  return { requeued: requeue.rows.length, dead: dead.rows.length };
}

/** 任务完成：写结果 + 结算配额（幂等，重复调用无副作用） */
export async function completeTask(opts: {
  taskId: string; workerId: string; ok: boolean; canceled?: boolean;
  result: any; runId?: string | null; errorCode?: string | null;
}): Promise<void> {
  const usage = await db().execute({
    sql: `SELECT COALESCE(SUM(input_tokens),0) ti, COALESCE(SUM(output_tokens),0) to_,
                 COALESCE(SUM(estimated_cost),0) cost, COALESCE(SUM(fallback_used),0) fb,
                 MAX(provider) provider, MAX(model) model
          FROM llm_usage_events WHERE task_id=?`,
    args: [opts.taskId],
  }).catch(() => ({ rows: [{}] as any[] }));
  const u: any = usage.rows[0] || {};

  const status = opts.canceled ? "canceled" : opts.ok ? "ok" : "error";
  const claimed = await db().execute({
    sql: `UPDATE agent_tasks SET status=?, output=?, error=?, error_code=?, last_run_id=?,
            token_input=?, token_output=?, estimated_cost=?, fallback_count=?,
            model=COALESCE(?, model), provider_hint=COALESCE(?, provider_hint),
            lease_expires_at=NULL, completed_at=now(), updated_at=now()
          WHERE task_id=? AND status='running' AND worker_id=?
          RETURNING owner_ref, quota_ref, quota_kind`,
    args: [status, JSON.stringify(opts.result ?? null),
      opts.ok ? null : (opts.result?.message || "failed"), opts.errorCode ?? null, opts.runId ?? null,
      Number(u.ti || 0), Number(u.to_ || 0), Number(u.cost || 0), Number(u.fb || 0),
      u.model ? String(u.model) : null, u.provider ? String(u.provider) : null,
      opts.taskId, opts.workerId],
  }).catch(() => ({ rows: [] as any[] }));

  // 任务已被回收（租约过期）时不结算，避免重复扣费
  if (!claimed.rows.length) return;

  const row: any = claimed.rows[0];
  if (row.quota_ref && row.owner_ref && row.quota_kind) {
    // 成功才扣，失败/取消一律返还
    if (opts.ok && !opts.canceled) await commitQuota(String(row.quota_ref));
    else await refundQuota(String(row.owner_ref), String(row.quota_kind), String(row.quota_ref));
  }
}

/** 执行失败后按退避重新入队；超过上限进死信并返还配额 */
export async function failTask(opts: {
  taskId: string; workerId: string; message: string; errorCode?: string | null; retryable: boolean;
}): Promise<"requeued" | "dead"> {
  const rs = await db().execute({
    sql: "SELECT attempts, max_attempts, owner_ref, quota_ref, quota_kind FROM agent_tasks WHERE task_id=?",
    args: [opts.taskId],
  }).catch(() => ({ rows: [] as any[] }));
  const t: any = rs.rows[0] || {};
  const attempts = Number(t.attempts || 0);
  const max = Number(t.max_attempts || 3);

  if (opts.retryable && attempts < max) {
    // 指数退避 + 抖动
    const delaySec = Math.min(60, 2 ** attempts) + Math.floor(Math.random() * 5);
    await db().execute({
      sql: `UPDATE agent_tasks SET status='queued', worker_id=NULL, lease_expires_at=NULL,
              error=?, error_code=?, scheduled_at = now() + (? || ' seconds')::interval, updated_at=now()
            WHERE task_id=? AND worker_id=?`,
      args: [opts.message.slice(0, 500), opts.errorCode ?? null, String(delaySec), opts.taskId, opts.workerId],
    }).catch(() => {});
    return "requeued";
  }

  await db().execute({
    sql: `UPDATE agent_tasks SET status='dead', worker_id=NULL, lease_expires_at=NULL,
            error=?, error_code=?, dead_reason=?, completed_at=now(), updated_at=now()
          WHERE task_id=? AND worker_id=?`,
    args: [opts.message.slice(0, 500), opts.errorCode ?? null,
      opts.retryable ? `已达最大重试次数（${max}）` : "不可重试的错误", opts.taskId, opts.workerId],
  }).catch(() => {});

  if (t.quota_ref && t.owner_ref && t.quota_kind) {
      await refundQuota(String(t.owner_ref), String(t.quota_kind), String(t.quota_ref));
  }
  return "dead";
}

/** 队列概览 */
export async function queueStats() {
  await ensureSchema();
  const rs = await db().execute({
    sql: `SELECT status, priority, COUNT(*) n,
            COALESCE(AVG(EXTRACT(EPOCH FROM (COALESCE(started_at, now()) - created_at))), 0) avg_wait
          FROM agent_tasks WHERE created_at > now() - interval '2 hours'
          GROUP BY status, priority ORDER BY priority`,
    args: [],
  });
  return rs.rows.map((r: any) => ({
    status: String(r.status), priority: Number(r.priority),
    count: Number(r.n), avgWaitSec: Math.round(Number(r.avg_wait)),
  }));
}

/** Worker 心跳上报（每次心跳/轮询时调用，upsert 一行） */
export async function workerHeartbeat(opts: {
  workerId: string; host: string; pid: number; heavySlots: number; lightSlots: number; inFlight: number;
}): Promise<void> {
  await db().execute({
    sql: `INSERT INTO worker_heartbeats (worker_id, host, pid, heavy_slots, light_slots, in_flight, last_beat_at, started_at)
          VALUES (?,?,?,?,?,?, now(), now())
          ON CONFLICT (worker_id) DO UPDATE SET
            host=EXCLUDED.host, pid=EXCLUDED.pid, heavy_slots=EXCLUDED.heavy_slots,
            light_slots=EXCLUDED.light_slots, in_flight=EXCLUDED.in_flight, last_beat_at=now()`,
    args: [opts.workerId, opts.host, opts.pid, opts.heavySlots, opts.lightSlots, opts.inFlight],
  }).catch(() => {});
}

/** Worker 退出时注销心跳 */
export async function workerDeregister(workerId: string): Promise<void> {
  await db().execute({ sql: "DELETE FROM worker_heartbeats WHERE worker_id=?", args: [workerId] }).catch(() => {});
}

export interface QueueHealth {
  activeWorkers: number;      // 心跳新鲜的 Worker 数
  staleWorkers: number;       // 心跳超时的 Worker 数
  queuedTasks: number;
  runningTasks: number;
  oldestQueuedSec: number;    // 最久排队任务的等待秒数
  deadRecent: number;         // 近 1 小时死信数
  alarms: string[];           // 触发的报警项
}

/** 队列与 Worker 健康：供 readiness / 告警使用。
 *  报警条件：无活动 Worker、队列积压、有任务排队但无人消费、死信激增。 */
export async function queueHealth(opts: {
  workerStaleMs?: number; backlogThreshold?: number; oldestQueuedAlarmSec?: number;
} = {}): Promise<QueueHealth> {
  await ensureSchema();
  const staleMs = opts.workerStaleMs ?? 3 * LEASE_MS;      // 默认 3 个租约周期无心跳即失联
  const backlog = opts.backlogThreshold ?? 200;
  const oldestAlarm = opts.oldestQueuedAlarmSec ?? 300;    // 排队 5 分钟仍未开始即告警

  const [workers, tasks, dead] = await Promise.all([
    db().execute({
      sql: `SELECT
              SUM(CASE WHEN last_beat_at > now() - (? || ' milliseconds')::interval THEN 1 ELSE 0 END) active,
              SUM(CASE WHEN last_beat_at <= now() - (? || ' milliseconds')::interval THEN 1 ELSE 0 END) stale
            FROM worker_heartbeats`,
      args: [String(staleMs), String(staleMs)],
    }).catch(() => ({ rows: [{ active: 0, stale: 0 }] as any[] })),
    db().execute({
      sql: `SELECT
              SUM(CASE WHEN status='queued' THEN 1 ELSE 0 END) queued,
              SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) running,
              COALESCE(MAX(CASE WHEN status='queued' THEN EXTRACT(EPOCH FROM (now() - created_at)) END), 0) oldest
            FROM agent_tasks`,
      args: [],
    }).catch(() => ({ rows: [{ queued: 0, running: 0, oldest: 0 }] as any[] })),
    db().execute({
      sql: "SELECT COUNT(*) n FROM agent_tasks WHERE status='dead' AND completed_at > now() - interval '1 hour'",
      args: [],
    }).catch(() => ({ rows: [{ n: 0 }] as any[] })),
  ]);

  const w: any = workers.rows[0] || {};
  const t: any = tasks.rows[0] || {};
  const activeWorkers = Number(w.active || 0);
  const staleWorkers = Number(w.stale || 0);
  const queuedTasks = Number(t.queued || 0);
  const runningTasks = Number(t.running || 0);
  const oldestQueuedSec = Math.round(Number(t.oldest || 0));
  const deadRecent = Number((dead.rows[0] as any)?.n || 0);

  const alarms: string[] = [];
  if (activeWorkers === 0 && (queuedTasks > 0 || runningTasks > 0)) alarms.push("无活动 Worker，但队列有任务待处理");
  if (queuedTasks >= backlog) alarms.push(`队列积压：${queuedTasks} 个任务排队（阈值 ${backlog}）`);
  if (oldestQueuedSec >= oldestAlarm && activeWorkers === 0) alarms.push(`最久任务已排队 ${oldestQueuedSec}s 且无 Worker 消费`);
  if (staleWorkers > 0) alarms.push(`${staleWorkers} 个 Worker 心跳超时`);
  if (deadRecent >= 20) alarms.push(`近 1 小时死信 ${deadRecent} 个，疑似系统性故障`);

  return { activeWorkers, staleWorkers, queuedTasks, runningTasks, oldestQueuedSec, deadRecent, alarms };
}
