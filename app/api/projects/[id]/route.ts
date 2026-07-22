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
  const b = await req.json().catch(() => ({}));
  const sets: string[] = [];
  const args: any[] = [];
  // 允许更新的字段：名称 / 备注 / 归档 / 阶段 / 题面
  if (typeof b.name === "string" && b.name.trim()) { sets.push("name=?"); args.push(b.name.trim().slice(0, 80)); }
  if (typeof b.note === "string") { sets.push("note=?"); args.push(b.note.slice(0, 500)); }
  if (b.archived !== undefined) { sets.push("archived=?"); args.push(b.archived ? 1 : 0); }
  if (typeof b.stage === "string") { sets.push("stage=?"); args.push(b.stage); }
  if (typeof b.problem_text === "string") { sets.push("problem_text=?"); args.push(b.problem_text); }
  if (!sets.length) return NextResponse.json({ error: "没有可更新的字段" }, { status: 400 });
  sets.push("updated_at=now()");
  await db().execute({ sql: `UPDATE projects SET ${sets.join(", ")} WHERE project_id=?`, args: [...args, params.id] });
  return NextResponse.json({ ok: true });
}

function safeParse(s: string) { try { return JSON.parse(s); } catch { return s; } }

/** 删除项目及其全部关联数据（产物/快照/任务/编译/成员），不可恢复。 */
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await assertProjectAccess(req, params.id);
  if (denied) return denied;
  await ensureSchema();
  for (const sql of [
    "DELETE FROM artifact_dependencies WHERE project_id=?",
    "DELETE FROM artifacts WHERE project_id=?",
    "DELETE FROM project_snapshots WHERE project_id=?",
    "DELETE FROM project_members WHERE project_id=?",
    "DELETE FROM agent_tasks WHERE project_id=?",
    "DELETE FROM agent_runs WHERE project_id=?",
    "DELETE FROM build_jobs WHERE project_id=?",
    "DELETE FROM projects WHERE project_id=?",
  ]) {
    await db().execute({ sql, args: [params.id] }).catch(() => {});
  }
  return NextResponse.json({ ok: true, deleted: params.id });
}
