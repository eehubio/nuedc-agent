import { createHash } from "node:crypto";
import { db, ensureSchema, uid } from "./db";
import { downstreamOf } from "./artifact-graph";

export const ARTIFACT_SCHEMA_VERSION = 2;

/** 产物服务层：版本递增保存 / 最新读取 / 版本恢复 / 失效级联。 */

export function contentHash(content: any): string {
  return createHash("sha256").update(JSON.stringify(content)).digest("hex").slice(0, 32);
}

export async function saveArtifact(opts: {
  projectId: string | null;
  type: string;
  content: any;
  createdBy: string;
  status?: string;
  sourceArtifactIds?: string[];    // 实例级溯源：本产物基于哪些具体版本生成
  changeReason?: string;
}): Promise<{ artifact_id: string; version: number; content_hash: string; unchanged?: boolean }> {
  await ensureSchema();
  const hash = contentHash(opts.content);
  // 内容未变则不产生新版本（避免防抖保存刷版本号）
  const last = await db().execute({
    sql: "SELECT artifact_id, version, content_hash FROM artifacts WHERE project_id=? AND type=? ORDER BY version DESC LIMIT 1",
    args: [opts.projectId, opts.type],
  });
  if (last.rows.length && String(last.rows[0].content_hash) === hash) {
    return { artifact_id: String(last.rows[0].artifact_id), version: Number(last.rows[0].version), content_hash: hash, unchanged: true };
  }
  const version = Number(last.rows[0]?.version || 0) + 1;
  const id = uid("ART");
  await db().execute({
    sql: `INSERT INTO artifacts (artifact_id, project_id, type, version, status, created_by, content,
          source_artifact_ids, schema_version, content_hash, change_reason) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    args: [id, opts.projectId, opts.type, version, opts.status || "reviewed", opts.createdBy,
      JSON.stringify(opts.content), JSON.stringify(opts.sourceArtifactIds || []),
      ARTIFACT_SCHEMA_VERSION, hash, opts.changeReason || null],
  });
  // 实例级依赖边
  for (const src of opts.sourceArtifactIds || []) {
    await db().execute({
      sql: "INSERT INTO artifact_dependencies (project_id, artifact_id, source_artifact_id) VALUES (?,?,?)",
      args: [opts.projectId, id, src],
    }).catch(() => {});
  }
  // 精确失效：只失效本类型在依赖图上的传递下游
  if (opts.projectId) {
    await markStale(opts.projectId, downstreamOf(opts.type));
  }
  return { artifact_id: id, version, content_hash: hash };
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
    sql: `SELECT a.artifact_id, a.type, a.version, a.status, a.created_by, a.content, a.created_at, a.content_hash, a.source_artifact_ids, a.change_reason
          FROM artifacts a
          JOIN (SELECT type, MAX(version) AS v FROM artifacts WHERE project_id=? GROUP BY type) m
            ON a.type=m.type AND a.version=m.v
          WHERE a.project_id=?`,
    args: [projectId, projectId],
  });
  return rs.rows.map((r) => ({
    artifact_id: r.artifact_id, type: String(r.type), version: Number(r.version),
    status: String(r.status), created_by: r.created_by, created_at: r.created_at,
    content_hash: r.content_hash, change_reason: r.change_reason,
    source_artifact_ids: (() => { try { return JSON.parse(String(r.source_artifact_ids || "[]")); } catch { return []; } })(),
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
  const vr = await db().execute({ sql: "SELECT version FROM artifacts WHERE artifact_id=?", args: [artifactId] });
  const fromV = vr.rows[0]?.version;
  const saved = await saveArtifact({
    projectId, type, content, createdBy: `restore:${actor}`, status: "reviewed",
    sourceArtifactIds: [artifactId], changeReason: `restore from v${fromV}`,
  });
  return { ...saved, type, content };
}
