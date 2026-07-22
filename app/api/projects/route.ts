import { NextRequest, NextResponse } from "next/server";
import { db, ensureSchema, uid } from "@/lib/db";
import { resolveOwner, withOwnerCookie, resolveTier } from "@/lib/auth";

export const runtime = "nodejs";
export async function OPTIONS() { return new NextResponse(null, { status: 204 }); }

export async function GET(req: NextRequest) {
  await ensureSchema();
  const { owner, isNew } = resolveOwner(req);
  const tier = resolveTier(req);
  // 严格按 owner 隔离；admin 可见全部（存量无主项目已由迁移 005 归属 admin:legacy）
  const rs = tier === "admin"
    ? await db().execute("SELECT project_id, name, stage, note, archived, ezplm_project_id, owner, updated_at FROM projects ORDER BY archived, updated_at DESC LIMIT 100")
    : await db().execute({
        sql: "SELECT project_id, name, stage, note, archived, ezplm_project_id, updated_at FROM projects WHERE owner=? ORDER BY archived, updated_at DESC LIMIT 50",
        args: [owner],
      });
  return withOwnerCookie(NextResponse.json({ projects: rs.rows }), owner, isNew);
}

export async function POST(req: NextRequest) {
  await ensureSchema();
  const body = await req.json();
  const { owner, isNew } = resolveOwner(req);
  const id = uid("P");
  await db().execute({
    sql: "INSERT INTO projects (project_id, name, problem_text, ezplm_project_id, owner) VALUES (?, ?, ?, ?, ?)",
    args: [id, body.name || "未命名电赛项目", body.problem_text || null, body.ezplm_project_id || null, owner],
  });
  return withOwnerCookie(NextResponse.json({ project_id: id }, { status: 201 }), owner, isNew);
}
