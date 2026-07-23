import { NextRequest, NextResponse } from "next/server";
import { db, ensureSchema } from "@/lib/db";

export const runtime = "nodejs";

export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  await ensureSchema();
  // queued 直接取消；running 打取消标记，Worker 轮询到后 abort 正在进行的 Provider 调用
  const q = await db().execute({
    sql: "UPDATE agent_tasks SET status='canceled', updated_at=now() WHERE task_id=? AND status='queued' RETURNING task_id", args: [params.id] });
  if (q.rows.length) return NextResponse.json({ task_id: params.id, status: "canceled" });
  await db().execute({ sql: "UPDATE agent_tasks SET cancel_requested=1, updated_at=now() WHERE task_id=? AND status='running'", args: [params.id] });
  const rs = await db().execute({ sql: "SELECT status FROM agent_tasks WHERE task_id=?", args: [params.id] });
  if (!rs.rows.length) return NextResponse.json({ error: "任务不存在" }, { status: 404 });
  return NextResponse.json({ task_id: params.id, status: rs.rows[0].status, cancel_requested: true });
}
