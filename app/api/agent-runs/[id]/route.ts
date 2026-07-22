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
  // 僵尸任务回收：running 超过 6 分钟视为后台被平台终止，标记失败让前端解脱
  if (r.status === "running" && Date.now() - new Date(String(r.created_at)).getTime() > 6 * 60_000) {
    await db().execute({ sql: "UPDATE agent_runs SET status='error', error=? WHERE run_id=?",
      args: ["后台执行被平台回收（超过 6 分钟未完成）。请重试；若反复出现，检查 Vercel 函数日志与 LLM API Key。", params.id] });
    return NextResponse.json({ run_id: r.run_id, agent: r.agent_type, status: "error", model: r.model, result: null, error: "后台执行被平台回收，请重试" });
  }
  let out: any = null;
  if (r.status !== "running" && r.output) {
    try { out = JSON.parse(String(r.output)); } catch { out = { ok: r.status === "ok", output: null, message: "结果解析失败" }; }
  }
  return NextResponse.json({
    run_id: r.run_id, agent: r.agent_type, status: r.status, model: r.model,
    result: out, error: r.error || null,
  });
}
