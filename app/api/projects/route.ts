import { NextRequest, NextResponse } from "next/server";
import { db, ensureSchema, uid } from "@/lib/db";
import { resolveOwner, withOwnerCookie } from "@/lib/auth";

export const runtime = "nodejs";
export async function OPTIONS() { return new NextResponse(null, { status: 204 }); }

export async function GET(req: NextRequest) {
  await ensureSchema();
  const { owner, isNew } = resolveOwner(req);
  // 只看自己的项目；owner 为空的历史项目仍可见（存量兼容）
  const rs = await db().execute({
    sql: "SELECT project_id, name, stage, ezplm_project_id, updated_at FROM projects WHERE owner=? OR owner IS NULL ORDER BY updated_at DESC LIMIT 50",
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
