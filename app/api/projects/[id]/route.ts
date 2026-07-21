import { NextRequest, NextResponse } from "next/server";
import { db, ensureSchema } from "@/lib/db";
import { PROJECT_STAGES } from "@/lib/types";

export const runtime = "nodejs";
export async function OPTIONS() { return new NextResponse(null, { status: 204 }); }

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  await ensureSchema();
  const proj = await db().execute({ sql: "SELECT * FROM projects WHERE project_id=?", args: [params.id] });
  if (!proj.rows.length) return NextResponse.json({ error: "项目不存在" }, { status: 404 });
  const artifacts = await db().execute({
    sql: "SELECT artifact_id, type, version, status, created_by, content, created_at FROM artifacts WHERE project_id=? ORDER BY created_at DESC LIMIT 100",
    args: [params.id],
  });
  return NextResponse.json({
    project: proj.rows[0],
    artifacts: artifacts.rows.map((r) => ({ ...r, content: safeParse(String(r.content)) })),
  });
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  await ensureSchema();
  const body = await req.json();
  if (body.stage && !PROJECT_STAGES.includes(body.stage)) {
    return NextResponse.json({ error: `非法阶段，可选：${PROJECT_STAGES.join(" → ")}` }, { status: 400 });
  }
  await db().execute({
    sql: "UPDATE projects SET stage=COALESCE(?, stage), name=COALESCE(?, name), problem_text=COALESCE(?, problem_text), updated_at=datetime('now') WHERE project_id=?",
    args: [body.stage || null, body.name || null, body.problem_text || null, params.id],
  });
  return NextResponse.json({ ok: true });
}

function safeParse(s: string) { try { return JSON.parse(s); } catch { return s; } }
