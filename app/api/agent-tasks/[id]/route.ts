import { NextRequest, NextResponse } from "next/server";
import { db, ensureSchema } from "@/lib/db";
import { assertProjectAccess } from "@/lib/auth";

export const runtime = "nodejs";

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  await ensureSchema();
  const rs = await db().execute({
    sql: "SELECT task_id, project_id, agent_type, status, output, error, model, attempts, cancel_requested, updated_at FROM agent_tasks WHERE task_id=?",
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
  return NextResponse.json({
    task_id: r.task_id, agent: r.agent_type, status: r.status, model: r.model,
    attempts: r.attempts, result, error: r.error || null,
  });
}
