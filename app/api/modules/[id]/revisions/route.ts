import { NextRequest, NextResponse } from "next/server";
import { db, ensureSchema, uid } from "@/lib/db";
import { resolveTier, canReviewModules } from "@/lib/auth";
import { audit } from "@/lib/module-query";

export const runtime = "nodejs";

/** 模块硬件版本（诊断 4.2）：同一淘宝商品可能换板换芯片，
 *  版本记录与模块本体分表存放（module_revisions）。 */
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  await ensureSchema();
  const rs = await db().execute({
    sql: "SELECT revision_id, revision_code, identified_chip, changes, source_note, created_at FROM module_revisions WHERE module_id=? ORDER BY created_at DESC",
    args: [params.id],
  });
  return NextResponse.json({ revisions: rs.rows });
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const tier = resolveTier(req);
  if (!canReviewModules(tier)) return NextResponse.json({ error: "需要实验室或管理员账户" }, { status: 403 });
  await ensureSchema();
  const b = await req.json();
  if (!b.revision_code) return NextResponse.json({ error: "revision_code 必填（如 V2.1 / 2026-03 批次）" }, { status: 400 });
  const id = uid("REV");
  await db().execute({
    sql: "INSERT INTO module_revisions (revision_id, module_id, revision_code, identified_chip, changes, source_note) VALUES (?,?,?,?,?,?)",
    args: [id, params.id, b.revision_code, b.identified_chip || null, b.changes || null, b.source_note || null],
  });
  await audit(`revision:${b.revision_code}`, params.id, tier);
  return NextResponse.json({ revision_id: id }, { status: 201 });
}
