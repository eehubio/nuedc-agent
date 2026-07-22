import { db, ensureSchema, uid } from "./db";

/** 产物服务层：版本递增保存 / 最新读取 / 版本恢复 / 失效级联。 */

// 方案是上游：方案变更后这些下游产物标记 stale
export const DOWNSTREAM_OF_SOLUTION = [
  "integration_report", "bom", "procurement_plan", "code_bundle",
  "code_verification", "test_plan", "test_record", "score", "test_report", "report",
];

export async function saveArtifact(opts: {
  projectId: string | null;
  type: string;
  content: any;
  createdBy: string;
  status?: string;
}): Promise<{ artifact_id: string; version: number }> {
  await ensureSchema();
  const vr = await db().execute({
    sql: "SELECT COALESCE(MAX(version), 0) AS v FROM artifacts WHERE project_id=? AND type=?",
    args: [opts.projectId, opts.type],
  });
  const version = Number(vr.rows[0]?.v || 0) + 1;
  const id = uid("ART");
  await db().execute({
    sql: "INSERT INTO artifacts (artifact_id, project_id, type, version, status, created_by, content) VALUES (?,?,?,?,?,?,?)",
    args: [id, opts.projectId, opts.type, version, opts.status || "reviewed", opts.createdBy, JSON.stringify(opts.content)],
  });
  // 失效级联：方案（候选或确认版）更新 → 下游全部 stale
  if (opts.projectId && (opts.type === "solution" || opts.type === "solution_proposal")) {
    await markStale(opts.projectId, DOWNSTREAM_OF_SOLUTION);
  }
  return { artifact_id: id, version };
}

export async function markStale(projectId: string, types: string[]): Promise<void> {
  if (!types.length) return;
  const placeholders = types.map(() => "?").join(",");
  await db().execute({
    sql: `UPDATE artifacts SET status='stale' WHERE project_id=? AND type IN (${placeholders}) AND status != 'stale'`,
    args: [projectId, ...types],
  });
}

/** 每种类型的最新版本（含状态，用于前端恢复与 stale 横幅） */
export async function latestArtifacts(projectId: string) {
  await ensureSchema();
  const rs = await db().execute({
    sql: `SELECT a.artifact_id, a.type, a.version, a.status, a.created_by, a.content, a.created_at
          FROM artifacts a
          JOIN (SELECT type, MAX(version) AS v FROM artifacts WHERE project_id=? GROUP BY type) m
            ON a.type=m.type AND a.version=m.v
          WHERE a.project_id=?`,
    args: [projectId, projectId],
  });
  return rs.rows.map((r) => ({
    artifact_id: r.artifact_id, type: String(r.type), version: Number(r.version),
    status: String(r.status), created_by: r.created_by, created_at: r.created_at,
    content: (() => { try { return JSON.parse(String(r.content)); } catch { return null; } })(),
  }));
}

export async function listVersions(projectId: string, type: string) {
  const rs = await db().execute({
    sql: "SELECT artifact_id, version, status, created_by, created_at FROM artifacts WHERE project_id=? AND type=? ORDER BY version DESC LIMIT 50",
    args: [projectId, type],
  });
  return rs.rows;
}

/** 恢复：把历史版本内容复制为新的最高版本（不可变历史，恢复即新版本） */
export async function restoreArtifact(projectId: string, artifactId: string, actor: string) {
  const rs = await db().execute({
    sql: "SELECT type, content FROM artifacts WHERE artifact_id=? AND project_id=?",
    args: [artifactId, projectId],
  });
  if (!rs.rows.length) return null;
  const type = String(rs.rows[0].type);
  const content = JSON.parse(String(rs.rows[0].content));
  const saved = await saveArtifact({ projectId, type, content, createdBy: `restore:${actor}`, status: "reviewed" });
  return { ...saved, type, content };
}
