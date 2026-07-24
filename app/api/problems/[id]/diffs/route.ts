import { NextRequest, NextResponse } from "next/server";
import { resolveTier } from "@/lib/auth";
import { db, ensureSchema } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  if (!["admin", "lab"].includes(resolveTier(req))) return NextResponse.json({ error: "仅工作人员可查看" }, { status: 403 });
  await ensureSchema();
  const rs = await db().execute({
    sql: `SELECT id, field_path, provider_a, provider_b, value_a, value_b, severity, resolved, resolution
          FROM problem_review_diffs WHERE problem_id=? ORDER BY
            CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, id`,
    args: [params.id],
  });
  return NextResponse.json({ diffs: rs.rows });
}

/** 人工确认差异：resolution 记录采信哪一方 */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  if (!["admin", "lab"].includes(resolveTier(req))) return NextResponse.json({ error: "仅工作人员可确认" }, { status: 403 });
  const b = await req.json().catch(() => ({}));
  if (!b.diff_id) return NextResponse.json({ error: "需要 diff_id" }, { status: 400 });
  await ensureSchema();
  await db().execute({
    sql: "UPDATE problem_review_diffs SET resolved=1, resolution=? WHERE id=? AND problem_id=?",
    args: [String(b.resolution || "已人工确认").slice(0, 200), b.diff_id, params.id],
  });
  return NextResponse.json({ ok: true });
}
