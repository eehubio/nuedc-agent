import { NextRequest, NextResponse } from "next/server";
import { assertProjectAccess, resolveOwner } from "@/lib/auth";
import { restoreArtifact } from "@/lib/artifacts";
import { db, ensureSchema } from "@/lib/db";

export const runtime = "nodejs";

/** 整套恢复：按 manifest 逐类把该时点版本复制为新最高版本。
 *  恢复顺序按依赖自然发生 —— 恢复方案会经依赖图自动 stale 其下游，
 *  随后下游各类被本次快照内容覆盖为新版本，最终状态即快照时点。 */
export async function POST(req: NextRequest, { params }: { params: { id: string; snapshotId: string } }) {
  const denied = await assertProjectAccess(req, params.id);
  if (denied) return denied;
  await ensureSchema();
  const rs = await db().execute({
    sql: "SELECT manifest FROM project_snapshots WHERE snapshot_id=? AND project_id=?",
    args: [params.snapshotId, params.id],
  });
  if (!rs.rows.length) return NextResponse.json({ error: "快照不存在" }, { status: 404 });
  const manifest: Record<string, { artifact_id: string }> = JSON.parse(String(rs.rows[0].manifest));
  const { owner } = resolveOwner(req);
  // 恢复顺序：上游类型在前（requirements → solution → 下游），保证 stale 被后续覆盖
  const ORDER = ["requirements", "solution_proposal", "solution", "integration_report", "bom", "procurement_plan",
    "code_bundle", "code_verification", "test_plan", "test_record", "score", "test_report", "report"];
  const restored: Record<string, number> = {};
  for (const type of ORDER) {
    const entry = manifest[type];
    if (!entry) continue;
    const r = await restoreArtifact(params.id, entry.artifact_id, `snapshot:${owner}`);
    if (r) restored[type] = r.version;
  }
  return NextResponse.json({ restored }, { status: 201 });
}
