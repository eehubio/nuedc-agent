import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 就绪探针（readiness）+ 队列/Worker 告警。
 *
 *  与 /api/health 的区别：health 只看进程存活；ready 要求依赖可用。
 *  返回 503 的情形：数据库不可达。
 *  Worker 失联 / 队列积压不返回 503（Web 本身仍可服务），但会在 alarms 中列出，
 *  供监控系统（Uptime Kuma / Prometheus blackbox / 云监控）抓取告警。
 *
 *  GET /api/ready */
export async function GET() {
  const started = Date.now();
  let dbOk = false;
  let dbError: string | null = null;

  try {
    const { db, ensureSchema } = await import("@/lib/db");
    await ensureSchema();
    await db().execute("SELECT 1");
    dbOk = true;
  } catch (e: any) {
    dbError = String(e?.message || e).slice(0, 200);
  }

  if (!dbOk) {
    return NextResponse.json({
      status: "unavailable",
      ready: false,
      database: { ok: false, error: dbError },
      latency_ms: Date.now() - started,
    }, { status: 503 });
  }

  // 队列与 Worker 健康（数据库可用时才有意义）
  let queue: any = null;
  let alarms: string[] = [];
  try {
    const { queueHealth } = await import("@/lib/task-queue");
    const h = await queueHealth({
      backlogThreshold: Number(process.env.QUEUE_BACKLOG_ALARM || 200),
      workerStaleMs: Number(process.env.WORKER_STALE_MS || 0) || undefined,
    });
    queue = {
      active_workers: h.activeWorkers,
      stale_workers: h.staleWorkers,
      queued: h.queuedTasks,
      running: h.runningTasks,
      oldest_queued_sec: h.oldestQueuedSec,
      dead_last_hour: h.deadRecent,
    };
    alarms = h.alarms;
  } catch (e: any) {
    alarms = [`队列健康查询失败：${String(e?.message || e).slice(0, 120)}`];
  }

  return NextResponse.json({
    status: alarms.length ? "degraded" : "ok",
    ready: true,
    database: { ok: true },
    queue,
    alarms,
    latency_ms: Date.now() - started,
    timestamp: new Date().toISOString(),
  });
}
