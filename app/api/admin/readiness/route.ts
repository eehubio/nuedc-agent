import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 压测前的就绪总览（管理员）。
 *
 *  把分散在各处的状态汇总到一个页面，避免"压测跑到一半才发现 Worker 是旧版本"。
 *  GET /api/admin/readiness
 *
 *  重点：Web SHA 与 Worker SHA 不一致时给出 warning —— 两者独立部署，
 *  很容易出现 Web 已更新而 Worker 还在跑旧代码的情况。 */
export async function GET(req: NextRequest) {
  const { resolveTier } = await import("@/lib/auth");
  if (resolveTier(req) !== "admin") {
    return NextResponse.json({ error: "仅管理员可查看" }, { status: 403 });
  }

  // errors 阻断压测/上线；warnings 仅提示。ready 只由 errors 决定。
  const errors: string[] = [];
  const warnings: string[] = [];
  const t0 = Date.now();

  // —— Web 侧数据库连通性 ——
  let dbOk = false;
  let dbError: string | null = null;
  try {
    const { db, ensureSchema } = await import("@/lib/db");
    await ensureSchema();
    await db().execute("SELECT 1");
    dbOk = true;
  } catch (e: any) {
    dbError = String(e?.message || e).slice(0, 200);
    errors.push("数据库不可达");
  }

  if (!dbOk) {
    return NextResponse.json({
      ready: false, database: { ok: false, error: dbError }, errors, warnings,
      latency_ms: Date.now() - t0,
    }, { status: 503 });
  }

  const { db } = await import("@/lib/db");

  // —— Worker 心跳 ——
  const wk = await db().execute({
    sql: `SELECT worker_id, host, heavy_slots, light_slots, in_flight, deployed_sha,
            EXTRACT(EPOCH FROM (now() - last_beat_at)) AS beat_age_sec
          FROM worker_heartbeats ORDER BY last_beat_at DESC`,
    args: [],
  }).catch(() => ({ rows: [] as any[] }));

  const staleMs = Number(process.env.WORKER_STALE_MS || 180_000) / 1000;
  const workers = (wk.rows as any[]).map((r) => ({
    worker_id: String(r.worker_id), host: r.host,
    heavy_slots: Number(r.heavy_slots || 0), light_slots: Number(r.light_slots || 0),
    in_flight: Number(r.in_flight || 0),
    heartbeat_age_sec: Math.round(Number(r.beat_age_sec || 0)),
    deployed_sha: r.deployed_sha ? String(r.deployed_sha) : null,
    stale: Number(r.beat_age_sec || 0) > staleMs,
  }));
  const liveWorkers = workers.filter((w) => !w.stale);
  if (liveWorkers.length === 0) errors.push("没有存活的 Worker —— 任务会一直排队不被执行");
  const staleCount = workers.filter((w) => w.stale).length;
  if (staleCount > 0) {
    // 至少有一个 Live Worker 时，历史 stale 记录只是残留，不阻断
    const msg = `${staleCount} 个 Worker 心跳超时`;
    if (liveWorkers.length > 0) warnings.push(msg); else errors.push(msg);
  }

  // —— 队列深度（按优先级） ——
  const q = await db().execute({
    sql: `SELECT priority, status, COUNT(*) n FROM agent_tasks
          WHERE status IN ('queued','running') GROUP BY priority, status ORDER BY priority`,
    args: [],
  }).catch(() => ({ rows: [] as any[] }));
  const queueByPriority: Record<string, { queued: number; running: number }> = {};
  for (const r of q.rows as any[]) {
    const p = String(r.priority);
    queueByPriority[p] ||= { queued: 0, running: 0 };
    queueByPriority[p][String(r.status) as "queued" | "running"] = Number(r.n);
  }
  const oldest = await db().execute({
    sql: `SELECT COALESCE(MAX(EXTRACT(EPOCH FROM (now() - created_at))), 0) sec
          FROM agent_tasks WHERE status='queued'`,
    args: [],
  }).catch(() => ({ rows: [{ sec: 0 }] as any[] }));
  const oldestQueuedSec = Math.round(Number((oldest.rows[0] as any)?.sec || 0));
  const totalQueued = Object.values(queueByPriority).reduce((a, v) => a + v.queued, 0);
  const backlogAlarm = Number(process.env.QUEUE_BACKLOG_ALARM || 200);
  const oldestHardSec = Number(process.env.QUEUE_OLDEST_HARD_SEC || 900);   // 最老任务硬阈值
  if (oldestQueuedSec >= oldestHardSec) {
    errors.push(`最老任务已排队 ${oldestQueuedSec}s，超过硬阈值 ${oldestHardSec}s`);
  }
  if (totalQueued >= backlogAlarm) errors.push(`队列积压 ${totalQueued}（阈值 ${backlogAlarm}）`);
  else if (totalQueued >= backlogAlarm * 0.7) warnings.push(`队列接近告警阈值：${totalQueued}/${backlogAlarm}`);

  // —— Provider 健康 ——
  let providerHealth: any = null;
  let taskHealth: any = null;
  try {
    const { healthSnapshot, taskHealthSnapshot } = await import("@/lib/model-gateway");
    providerHealth = await healthSnapshot();
    taskHealth = await taskHealthSnapshot();
  } catch (e: any) {
    errors.push("Provider 健康查询失败 —— 无法确认模型链路可用性");
  }
  // 主路由全部不可用 = 阻断；个别备用不健康 = 提示
  if (Array.isArray(providerHealth) && providerHealth.length) {
    const usable = providerHealth.filter((p: any) => p.enabled !== false && p.healthy !== false);
    if (usable.length === 0) errors.push("所有 Provider 均不可用（未配置或已熔断）");
    else if (usable.length < providerHealth.length) {
      const bad = providerHealth.filter((p: any) => p.enabled === false || p.healthy === false)
        .map((p: any) => p.provider || p.id).join("、");
      warnings.push(`备用 Provider 不健康：${bad}`);
    }
  }

  // —— 当日 token 用量与估算成本 ——
  const usage = await db().execute({
    sql: `SELECT COALESCE(SUM(input_tokens),0) inp, COALESCE(SUM(output_tokens),0) outp,
            COALESCE(SUM(estimated_cost),0) cost, COUNT(*) calls
          FROM llm_usage_events WHERE created_at >= CURRENT_DATE`,
    args: [],
  }).catch(() => ({ rows: [{}] as any[] }));
  const u: any = usage.rows[0] || {};

  // —— 版本一致性 ——
  const webSha = process.env.VERCEL_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA || null;
  const workerShas = Array.from(new Set(liveWorkers.map((w) => w.deployed_sha).filter(Boolean)));
  if (webSha && workerShas.length && !workerShas.every((s) => s === webSha)) {
    warnings.push(`Web 与 Worker 版本不一致：web=${String(webSha).slice(0, 7)}，worker=${workerShas.map((s) => String(s).slice(0, 7)).join(",")}`);
  }
  if (webSha && liveWorkers.length && workerShas.length === 0) {
    warnings.push("Worker 未上报 deployed_sha，无法校验版本一致性");
  }

  // —— 连接池 ——
  let pool: any = null;
  try {
    const { txPoolStats } = await import("@/lib/db");
    pool = txPoolStats();
  } catch { /* 未初始化 */ }

  return NextResponse.json({
    // ready 只由 errors 决定 —— warnings 不应阻断压测与上线
    ready: errors.length === 0,
    errors,
    warnings,
    database: { ok: true },
    tx_pool: pool,
    workers: {
      total: workers.length, live: liveWorkers.length,
      heavy_slots: liveWorkers.reduce((a, w) => a + w.heavy_slots, 0),
      light_slots: liveWorkers.reduce((a, w) => a + w.light_slots, 0),
      in_flight: liveWorkers.reduce((a, w) => a + w.in_flight, 0),
      detail: workers,
    },
    queue: { by_priority: queueByPriority, total_queued: totalQueued, oldest_queued_sec: oldestQueuedSec },
    provider_health: providerHealth,
    task_type_health: taskHealth,
    usage_today: {
      calls: Number(u.calls || 0),
      input_tokens: Number(u.inp || 0),
      output_tokens: Number(u.outp || 0),
      estimated_cost_usd: +Number(u.cost || 0).toFixed(4),
    },
    versions: { web_sha: webSha, worker_shas: workerShas, ci_sha: process.env.CI_COMMIT_SHA || null },
    latency_ms: Date.now() - t0,
    timestamp: new Date().toISOString(),
  });
}
