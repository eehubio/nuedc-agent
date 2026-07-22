import { NextRequest, NextResponse } from "next/server";
import { db, ensureSchema } from "@/lib/db";

export const runtime = "nodejs";

export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  await ensureSchema();
  const rs = await db().execute({
    sql: "UPDATE agent_tasks SET status='queued', cancel_requested=0, error=NULL, updated_at=now() WHERE task_id=? AND status IN ('error','canceled') RETURNING task_id",
    args: [params.id],
  });
  if (!rs.rows.length) return NextResponse.json({ error: "任务不存在或不可重试" }, { status: 409 });
  return NextResponse.json({ task_id: params.id, status: "queued" });
}
