import { NextRequest, NextResponse } from "next/server";
import { assertProjectAccess, resolveOwner, resolveTier } from "@/lib/auth";
import { db, ensureSchema } from "@/lib/db";

export const runtime = "nodejs";

/** 项目成员（轻量协作模型，ezPLM SSO 接入前的过渡）：
 *  仅项目所有者 / admin 可增删成员；成员对项目有完整读写（细粒度角色待 SSO）。 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await assertProjectAccess(req, params.id);
  if (denied) return denied;
  await ensureSchema();
  const rs = await db().execute({ sql: "SELECT user_ref, role, created_at FROM project_members WHERE project_id=?", args: [params.id] });
  return NextResponse.json({ members: rs.rows });
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  await ensureSchema();
  const tier = resolveTier(req);
  const { owner } = resolveOwner(req);
  const proj = await db().execute({ sql: "SELECT owner FROM projects WHERE project_id=?", args: [params.id] });
  if (!proj.rows.length) return NextResponse.json({ error: "项目不存在" }, { status: 404 });
  if (tier !== "admin" && String(proj.rows[0].owner) !== owner) {
    return NextResponse.json({ error: "仅项目所有者可管理成员" }, { status: 403 });
  }
  const b = await req.json().catch(() => ({}));
  if (!b.user_ref) return NextResponse.json({ error: "缺少 user_ref（ezPLM 用户为 ezplm:<id>）" }, { status: 400 });
  await db().execute({
    sql: "INSERT INTO project_members (project_id, user_ref, role) VALUES (?,?,?) ON CONFLICT (project_id, user_ref) DO UPDATE SET role=EXCLUDED.role",
    args: [params.id, b.user_ref, b.role || "member"],
  });
  return NextResponse.json({ ok: true }, { status: 201 });
}
