import { NextRequest, NextResponse } from "next/server";
import { assertProjectAccess, resolveOwner } from "@/lib/auth";
import { latestArtifacts } from "@/lib/artifacts";
import { db, ensureSchema, uid } from "@/lib/db";

export const runtime = "nodejs";

/** 项目快照：记录当前每类产物的最新版本 id（manifest），可整套恢复。 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await assertProjectAccess(req, params.id);
  if (denied) return denied;
  await ensureSchema();
  const body = await req.json().catch(() => ({}));
  const latest = await latestArtifacts(params.id);
  if (!latest.length) return NextResponse.json({ error: "项目还没有任何产物" }, { status: 400 });
  const manifest = Object.fromEntries(latest.map((a) => [a.type, { artifact_id: a.artifact_id, version: a.version, content_hash: a.content_hash }]));
  const id = uid("SNAP");
  const { owner } = resolveOwner(req);
  await db().execute({
    sql: "INSERT INTO project_snapshots (snapshot_id, project_id, name, manifest, created_by) VALUES (?,?,?,?,?)",
    args: [id, params.id, body.name || `快照 ${new Date().toLocaleString("zh-CN")}`, JSON.stringify(manifest), owner],
  });
  return NextResponse.json({ snapshot_id: id, types: Object.keys(manifest) }, { status: 201 });
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await assertProjectAccess(req, params.id);
  if (denied) return denied;
  await ensureSchema();
  const rs = await db().execute({
    sql: "SELECT snapshot_id, name, manifest, created_by, created_at FROM project_snapshots WHERE project_id=? ORDER BY created_at DESC LIMIT 20",
    args: [params.id],
  });
  return NextResponse.json({ snapshots: rs.rows.map((r) => ({ ...r, manifest: JSON.parse(String(r.manifest)) })) });
}
