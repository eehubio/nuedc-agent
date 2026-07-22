import { NextRequest, NextResponse } from "next/server";
import { db, ensureSchema } from "@/lib/db";
import { assertProjectAccess } from "@/lib/auth";

export const runtime = "nodejs";

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  await ensureSchema();
  const rs = await db().execute({
    sql: `SELECT task_id, project_id, agent_type, task_type, status, output, error, model, attempts,
            cancel_requested, updated_at, created_at, priority, token_input, token_output,
            estimated_cost, fallback_count FROM agent_tasks WHERE task_id=?`,
    args: [params.id],
  });
  if (!rs.rows.length) return NextResponse.json({ error: "任务不存在" }, { status: 404 });
  const r = rs.rows[0];
  if (r.project_id) {
    const denied = await assertProjectAccess(req, String(r.project_id));
    if (denied) return denied;
  }
  // 僵尸回收：queued/running 且 6 分钟无心跳 → 失败（可重试）
  if (["queued", "running"].includes(String(r.status)) && Date.now() - new Date(String(r.updated_at)).getTime() > 6 * 60_000) {
    await db().execute({ sql: "UPDATE agent_tasks SET status='error', error='执行超时或被平台回收，可重试', updated_at=now() WHERE task_id=?", args: [params.id] });
    return NextResponse.json({ task_id: r.task_id, agent: r.agent_type, status: "error", error: "执行超时或被平台回收，可重试", result: null });
  }
  let result: any = null;
  if (!["queued", "running"].includes(String(r.status)) && r.output) {
    try { result = JSON.parse(String(r.output)); } catch { result = { ok: false, output: null, message: "结果解析失败" }; }
  }
  // 排队位置与预计等待（同优先级中比自己早的任务数 × 近期平均耗时）
  let queue: any = null;
  if (String(r.status) === "queued") {
    const q = await db().execute({
      sql: `SELECT COUNT(*) n FROM agent_tasks
            WHERE status='queued' AND (priority < ? OR (priority = ? AND created_at < ?))`,
      args: [r.priority ?? 5, r.priority ?? 5, r.created_at],
    }).catch(() => ({ rows: [{ n: 0 }] as any[] }));
    const avg = await db().execute({
      sql: `SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (completed_at - started_at))), 45) s
            FROM agent_tasks WHERE completed_at IS NOT NULL AND completed_at > now() - interval '30 minutes'`,
      args: [],
    }).catch(() => ({ rows: [{ s: 45 }] as any[] }));
    const ahead = Number(q.rows[0]?.n || 0);
    queue = { position: ahead + 1, ahead, estimated_wait_seconds: Math.round(ahead * Number(avg.rows[0]?.s || 45)) };
  }

  return NextResponse.json({
    task_id: r.task_id, agent: r.agent_type, task_type: r.task_type, status: r.status, model: r.model,
    attempts: r.attempts, result, error: r.error || null, queue,
    tokens: { input: Number(r.token_input || 0), output: Number(r.token_output || 0) },
    cost: Number(r.estimated_cost || 0),
    fallback_used: Number(r.fallback_count || 0) > 0,
  });
}
