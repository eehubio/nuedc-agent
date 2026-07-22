import { NextRequest, NextResponse } from "next/server";
import { db, ensureSchema } from "@/lib/db";

export const runtime = "nodejs";

export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  await ensureSchema();
  // 重试上限 → 死信（dead），不再进入队列
  const meta = await db().execute({ sql: "SELECT attempts, max_attempts, status FROM agent_tasks WHERE task_id=?", args: [params.id] });
  if (!meta.rows.length) return NextResponse.json({ error: "任务不存在" }, { status: 404 });
  if (Number(meta.rows[0].attempts) >= Number(meta.rows[0].max_attempts || 3)) {
    await db().execute({ sql: "UPDATE agent_tasks SET status='dead', updated_at=now() WHERE task_id=?", args: [params.id] });
    return NextResponse.json({ error: `已达最大重试次数（${meta.rows[0].max_attempts}），任务进入死信，请检查失败原因后新建任务` }, { status: 409 });
  }
  const rs = await db().execute({
    sql: "UPDATE agent_tasks SET status='queued', cancel_requested=0, error=NULL, updated_at=now() WHERE task_id=? AND status IN ('error','canceled') RETURNING task_id",
    args: [params.id],
  });
  if (!rs.rows.length) return NextResponse.json({ error: "任务不可重试（当前状态不是 error/canceled）" }, { status: 409 });
  return NextResponse.json({ task_id: params.id, status: "queued" });
}
