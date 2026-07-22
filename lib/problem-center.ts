import { createHash } from "node:crypto";
import { db, ensureSchema, uid } from "./db";

/** 赛题中心：官方题目只解析一次，用户项目引用发布版本，不再重复调用模型。 */

export const PROBLEM_STATUSES = ["draft", "extracted", "reviewing", "published", "archived"] as const;
export type ProblemStatus = (typeof PROBLEM_STATUSES)[number];

export interface OfficialProblem {
  problem_id: string;
  year: number;
  code: string;
  title: string;
  group_name?: string | null;
  status: ProblemStatus;
  problem_version: number;
  requirements: any[];
  scoring_items: any[];
  notes?: string | null;
  report_requirements?: string | null;
}

export function pdfHash(base64: string): string {
  return createHash("sha256").update(base64.slice(0, 500_000)).digest("hex").slice(0, 40);
}

export async function findByPdfHash(hash: string) {
  await ensureSchema();
  const rs = await db().execute({
    sql: "SELECT problem_id, status, problem_version, title FROM official_problems WHERE source_pdf_hash=?",
    args: [hash],
  });
  return rs.rows[0] || null;
}

export async function createProblem(input: {
  year: number; code: string; title: string; groupName?: string;
  rawText?: string; pdfHash?: string; createdBy: string;
}): Promise<string> {
  await ensureSchema();
  const id = uid("PROB");
  await db().execute({
    sql: `INSERT INTO official_problems (problem_id, year, code, title, group_name, status, raw_text, source_pdf_hash, created_by)
          VALUES (?,?,?,?,?,?,?,?,?)`,
    args: [id, input.year, input.code, input.title, input.groupName || null,
      input.rawText ? "extracted" : "draft", input.rawText || null, input.pdfHash || null, input.createdBy],
  });
  return id;
}

export async function getProblem(problemId: string) {
  await ensureSchema();
  const rs = await db().execute({ sql: "SELECT * FROM official_problems WHERE problem_id=?", args: [problemId] });
  if (!rs.rows.length) return null;
  const r: any = rs.rows[0];
  const parse = (v: any, d: any) => { try { return v ? JSON.parse(String(v)) : d; } catch { return d; } };
  return {
    ...r,
    requirements: parse(r.requirements, []),
    scoring_items: parse(r.scoring_items, []),
  };
}

export async function listProblems(opts: { status?: string; year?: number; publishedOnly?: boolean } = {}) {
  await ensureSchema();
  const where: string[] = [];
  const args: any[] = [];
  if (opts.publishedOnly) where.push("status='published'");
  else if (opts.status) { where.push("status=?"); args.push(opts.status); }
  if (opts.year) { where.push("year=?"); args.push(opts.year); }
  const rs = await db().execute({
    sql: `SELECT problem_id, year, code, title, group_name, status, problem_version, published_at,
            (SELECT COUNT(*) FROM problem_review_diffs d WHERE d.problem_id = p.problem_id AND d.resolved = 0) AS open_diffs
          FROM official_problems p
          ${where.length ? "WHERE " + where.join(" AND ") : ""}
          ORDER BY year DESC, code ASC LIMIT 200`,
    args,
  });
  return rs.rows;
}

export async function saveExtraction(problemId: string, data: {
  requirements?: any[]; scoringItems?: any[]; rawText?: string; notes?: string; reportRequirements?: string;
}) {
  const sets: string[] = [];
  const args: any[] = [];
  if (data.requirements) { sets.push("requirements=?"); args.push(JSON.stringify(data.requirements)); }
  if (data.scoringItems) { sets.push("scoring_items=?"); args.push(JSON.stringify(data.scoringItems)); }
  if (data.rawText !== undefined) { sets.push("raw_text=?"); args.push(data.rawText); }
  if (data.notes !== undefined) { sets.push("notes=?"); args.push(data.notes); }
  if (data.reportRequirements !== undefined) { sets.push("report_requirements=?"); args.push(data.reportRequirements); }
  if (!sets.length) return;
  sets.push("updated_at=now()");
  await db().execute({ sql: `UPDATE official_problems SET ${sets.join(", ")} WHERE problem_id=?`, args: [...args, problemId] });
}

/** 双模复核差异：程序对比两个 Provider 的提取结果 */
export function diffExtractions(a: { requirements: any[]; scoring_items: any[] }, b: { requirements: any[]; scoring_items: any[] }) {
  const diffs: { field_path: string; value_a: string; value_b: string; severity: string }[] = [];
  const norm = (s: any) => String(s ?? "").replace(/\s+/g, "").toLowerCase();

  // 需求条数差异
  if (a.requirements.length !== b.requirements.length) {
    diffs.push({
      field_path: "requirements.count",
      value_a: String(a.requirements.length), value_b: String(b.requirements.length),
      severity: "warning",
    });
  }
  // 逐条比对描述与指标（按顺序对齐，简单但对赛题这类结构化文本够用）
  const n = Math.max(a.requirements.length, b.requirements.length);
  for (let i = 0; i < n; i++) {
    const ra = a.requirements[i], rb = b.requirements[i];
    if (!ra || !rb) {
      diffs.push({
        field_path: `requirements[${i}]`,
        value_a: ra ? String(ra.description || "").slice(0, 120) : "（缺失）",
        value_b: rb ? String(rb.description || "").slice(0, 120) : "（缺失）",
        severity: "warning",
      });
      continue;
    }
    if (norm(ra.description) !== norm(rb.description)) {
      diffs.push({
        field_path: `requirements[${i}].description`,
        value_a: String(ra.description || "").slice(0, 160),
        value_b: String(rb.description || "").slice(0, 160),
        severity: "info",
      });
    }
    // 量化指标不一致是高危：直接影响测试判定
    if (norm(ra.target) !== norm(rb.target) || norm(ra.unit) !== norm(rb.unit) || norm(ra.tolerance) !== norm(rb.tolerance)) {
      diffs.push({
        field_path: `requirements[${i}].target`,
        value_a: `${ra.target ?? "—"}${ra.unit ?? ""} ${ra.tolerance ?? ""}`.trim(),
        value_b: `${rb.target ?? "—"}${rb.unit ?? ""} ${rb.tolerance ?? ""}`.trim(),
        severity: "critical",
      });
    }
  }
  // 评分项：分值不一致同样高危
  const sa = a.scoring_items || [], sb = b.scoring_items || [];
  if (sa.length !== sb.length) {
    diffs.push({ field_path: "scoring_items.count", value_a: String(sa.length), value_b: String(sb.length), severity: "warning" });
  }
  const sn = Math.max(sa.length, sb.length);
  for (let i = 0; i < sn; i++) {
    const x = sa[i], y = sb[i];
    if (!x || !y) continue;
    if (Number(x.points ?? -1) !== Number(y.points ?? -1)) {
      diffs.push({
        field_path: `scoring_items[${i}].points`,
        value_a: `${x.item ?? ""}: ${x.points ?? "—"}`,
        value_b: `${y.item ?? ""}: ${y.points ?? "—"}`,
        severity: "critical",
      });
    }
  }
  return diffs;
}

export async function saveDiffs(problemId: string, diffs: any[], providerA: string, providerB: string) {
  await db().execute({ sql: "DELETE FROM problem_review_diffs WHERE problem_id=? AND resolved=0", args: [problemId] }).catch(() => {});
  for (const d of diffs) {
    await db().execute({
      sql: `INSERT INTO problem_review_diffs (problem_id, field_path, provider_a, provider_b, value_a, value_b, severity)
            VALUES (?,?,?,?,?,?,?)`,
      args: [problemId, d.field_path, providerA, providerB, d.value_a?.slice(0, 500), d.value_b?.slice(0, 500), d.severity],
    }).catch(() => {});
  }
}

export async function publishProblem(problemId: string, publishedBy: string) {
  await ensureSchema();
  const open = await db().execute({
    sql: "SELECT COUNT(*) n FROM problem_review_diffs WHERE problem_id=? AND resolved=0 AND severity='critical'",
    args: [problemId],
  });
  if (Number(open.rows[0]?.n || 0) > 0) {
    return { ok: false, error: `还有 ${open.rows[0].n} 处关键差异（指标/分值）未确认，不能发布` };
  }
  const p = await getProblem(problemId);
  if (!p) return { ok: false, error: "题目不存在" };
  if (!p.requirements?.length) return { ok: false, error: "尚未提取出需求，不能发布" };

  await db().execute({
    sql: `UPDATE official_problems SET status='published', published_by=?, published_at=now(),
            problem_version = problem_version + 1, updated_at=now() WHERE problem_id=?`,
    args: [publishedBy, problemId],
  });
  return { ok: true };
}
