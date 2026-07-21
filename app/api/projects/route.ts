import { NextRequest, NextResponse } from "next/server";
import { db, ensureSchema, uid } from "@/lib/db";

export const runtime = "nodejs";
export async function OPTIONS() { return new NextResponse(null, { status: 204 }); }

export async function GET() {
  await ensureSchema();
  const rs = await db().execute("SELECT project_id, name, stage, ezplm_project_id, updated_at FROM projects ORDER BY updated_at DESC LIMIT 50");
  return NextResponse.json({ projects: rs.rows });
}

export async function POST(req: NextRequest) {
  await ensureSchema();
  const body = await req.json();
  const id = uid("P");
  await db().execute({
    sql: "INSERT INTO projects (project_id, name, problem_text, ezplm_project_id) VALUES (?, ?, ?, ?)",
    args: [id, body.name || "未命名电赛项目", body.problem_text || null, body.ezplm_project_id || null],
  });
  return NextResponse.json({ project_id: id }, { status: 201 });
}
