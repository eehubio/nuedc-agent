import { NextRequest, NextResponse } from "next/server";
import { audit } from "@/lib/module-query";
import { db, ensureSchema } from "@/lib/db";
import { moduleUpdateSchema, zodMessage } from "@/lib/module-schema";
import { resolveTier, canDownloadAssets, canReviewModules, stripPaidFields } from "@/lib/auth";
import type { ModuleCertState } from "@/lib/types";

export const runtime = "nodejs";
export async function OPTIONS() { return new NextResponse(null, { status: 204 }); }

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  await ensureSchema();
  const tier = resolveTier(req);
  const rs = await db().execute({ sql: "SELECT data, certification_status, downloads FROM modules WHERE id=?", args: [params.id] });
  if (!rs.rows.length) return NextResponse.json({ error: "模块不存在" }, { status: 404 });
  const data = JSON.parse(String(rs.rows[0].data));
  const cert = String(rs.rows[0].certification_status) as ModuleCertState;
  const unlocked = canDownloadAssets(tier, cert);
  if (unlocked) {
    await db().execute({ sql: "UPDATE modules SET downloads = downloads + 1 WHERE id=?", args: [params.id] });
  }
  await audit("edit", params.id, tier);
  return NextResponse.json({ module: unlocked ? data : stripPaidFields(data), tier });
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const tier = resolveTier(req);
  if (!canReviewModules(tier)) return NextResponse.json({ error: "修改模块需要实验室或管理员账户" }, { status: 403 });
  await ensureSchema();
  const body = await req.json();
  const parsed = moduleUpdateSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
  const rs = await db().execute({ sql: "SELECT data FROM modules WHERE id=?", args: [params.id] });
  if (!rs.rows.length) return NextResponse.json({ error: "模块不存在" }, { status: 404 });
  const merged = { ...JSON.parse(String(rs.rows[0].data)), ...parsed.data };
  await db().execute({
    sql: "UPDATE modules SET name=?, category=?, version=?, price=?, data=?, updated_at=now() WHERE id=?",
    args: [merged.name, merged.category, merged.version, merged.price ?? 0, JSON.stringify(merged), params.id],
  });
  return NextResponse.json({ ok: true });
}
