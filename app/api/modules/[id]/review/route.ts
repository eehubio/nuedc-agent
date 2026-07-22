import { NextRequest, NextResponse } from "next/server";
import { audit } from "@/lib/module-query";
import { db, ensureSchema, uid } from "@/lib/db";
import { resolveTier, canReviewModules } from "@/lib/auth";
import { MODULE_CERT_STATES } from "@/lib/types";

export const runtime = "nodejs";
export async function OPTIONS() { return new NextResponse(null, { status: 204 }); }

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const tier = resolveTier(req);
  if (!canReviewModules(tier)) return NextResponse.json({ error: "审核需要实验室或管理员账户" }, { status: 403 });
  await ensureSchema();
  const body = await req.json(); // { result: approved|changes_required|rejected, to_status?, issues? }

  const rs = await db().execute({ sql: "SELECT certification_status, data FROM modules WHERE id=?", args: [params.id] });
  if (!rs.rows.length) return NextResponse.json({ error: "模块不存在" }, { status: 404 });
  const from = String(rs.rows[0].certification_status);

  let to = from;
  if (body.result === "approved") {
    // 只允许沿状态机逐级推进，或显式指定合法状态
    const idx = MODULE_CERT_STATES.indexOf(from as any);
    to = body.to_status && MODULE_CERT_STATES.includes(body.to_status)
      ? body.to_status
      : MODULE_CERT_STATES[Math.min(idx + 1, MODULE_CERT_STATES.length - 2)]; // 不自动进 DEPRECATED
  } else if (body.result === "rejected") {
    to = "DRAFT";
  }

  const data = JSON.parse(String(rs.rows[0].data));
  // 证据门禁（诊断 4.4/4.3）：高等级认证必须绑定实验室实测证据 —— 必须在任何写库之前拦截
  if (["BENCHMARKED", "COMPETITION_READY"].includes(to)) {
    const ev = (data.evidence_records || []).filter((e: any) => ["E5", "E6"].includes(e.evidence_level));
    if (!ev.length) {
      return NextResponse.json({
        error: `晋级到 ${to} 需要至少一条 E5（实验室实测）及以上的参数证据。请先在模块编辑页的「参数证据」区录入实测记录（含测试条件与来源编号）。`,
      }, { status: 422 });
    }
  }
  data.certification_status = to;
  await db().execute({
    sql: "UPDATE modules SET certification_status=?, data=?, updated_at=now() WHERE id=?",
    args: [to, JSON.stringify(data), params.id],
  });
  await db().execute({
    sql: "INSERT INTO module_reviews (review_id, module_id, reviewer, from_status, to_status, result, issues) VALUES (?, ?, ?, ?, ?, ?, ?)",
    args: [uid("REV"), params.id, tier, from, to, body.result || "approved", JSON.stringify(body.issues || [])],
  });
  await audit(`review:${String(body.result)}→${to}`, params.id, tier);
  return NextResponse.json({ from_status: from, to_status: to });
}
