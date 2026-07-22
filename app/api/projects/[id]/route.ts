import { NextRequest, NextResponse } from "next/server";
import { db, ensureSchema } from "@/lib/db";
import { assertProjectAccess } from "@/lib/auth";
import { latestArtifacts } from "@/lib/artifacts";
import { PROJECT_STAGES } from "@/lib/types";

export const runtime = "nodejs";
export async function OPTIONS() { return new NextResponse(null, { status: 204 }); }

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await assertProjectAccess(req, params.id);
  if (denied) return denied;
  await ensureSchema();
  const proj = await db().execute({ sql: "SELECT * FROM projects WHERE project_id=?", args: [params.id] });
  if (!proj.rows.length) return NextResponse.json({ error: "项目不存在" }, { status: 404 });
  // latest：每种产物类型的最新版本（前端刷新恢复用）；artifacts：完整历史
  const latest = await latestArtifacts(params.id);
  const history = await db().execute({
    sql: "SELECT artifact_id, type, version, status, created_by, created_at FROM artifacts WHERE project_id=? ORDER BY created_at DESC LIMIT 200",
    args: [params.id],
  });
  return NextResponse.json({ project: proj.rows[0], latest, artifacts: history.rows });
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await assertProjectAccess(req, params.id);
  if (denied) return denied;
  await ensureSchema();
  const body = await req.json();
  if (body.stage && !PROJECT_STAGES.includes(body.stage)) {
    return NextResponse.json({ error: `非法阶段，可选：${PROJECT_STAGES.join(" → ")}` }, { status: 400 });
  }
  await db().execute({
    sql: "UPDATE projects SET stage=COALESCE(?, stage), name=COALESCE(?, name), problem_text=COALESCE(?, problem_text), updated_at=now() WHERE project_id=?",
    args: [body.stage || null, body.name || null, body.problem_text || null, params.id],
  });
  return NextResponse.json({ ok: true });
}

function safeParse(s: string) { try { return JSON.parse(s); } catch { return s; } }
