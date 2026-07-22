import { NextRequest, NextResponse } from "next/server";
import { db, ensureSchema } from "@/lib/db";

export const runtime = "nodejs";

/** 轮询异步运行状态：running → ok/error（output 为 runAgent 完整结果） */
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  await ensureSchema();
  const rs = await db().execute({
    sql: "SELECT run_id, agent_type, status, output, error, model, created_at FROM agent_runs WHERE run_id=?",
    args: [params.id],
  });
  if (!rs.rows.length) return NextResponse.json({ error: "运行不存在" }, { status: 404 });
  const r = rs.rows[0];
  const out = r.status !== "running" && r.output ? JSON.parse(String(r.output)) : null;
  return NextResponse.json({
    run_id: r.run_id, agent: r.agent_type, status: r.status, model: r.model,
    result: out, error: r.error || null,
  });
}
