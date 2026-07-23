import { createHash } from "node:crypto";
import { db, ensureSchema, uid, withTransaction, type Executor } from "./db";

/** 赛题中心（规范化模型）。
 *  official_problems 只存题目主体；每次发布产生不可变的 problem_versions，
 *  需求/评分项/说明/审核记录各自成表，可按条查询、确认与追溯。 */

export const PROBLEM_STATUSES = ["draft", "extracted", "reviewing", "published", "archived"] as const;
export type ProblemStatus = (typeof PROBLEM_STATUSES)[number];

/** 对完整 PDF 二进制计算 SHA-256。
 *  绝不能只取前缀：赛题 PDF 往往共用模板，前若干字节高度相似，
 *  截断哈希会把不同题目误判为同一份。 */
export function pdfSha256(base64: string): string {
  return createHash("sha256").update(Buffer.from(base64, "base64")).digest("hex");
}

/* ============ 题目与版本 ============ */

export async function createProblem(input: {
  year: number; code: string; title: string; groupName?: string; createdBy: string;
}): Promise<string> {
  await ensureSchema();
  const id = uid("PROB");
  await db().execute({
    sql: `INSERT INTO official_problems (problem_id, year, code, title, group_name, status, created_by)
          VALUES (?,?,?,?,?, 'draft', ?)`,
    args: [id, input.year, String(input.code).toUpperCase(), input.title, input.groupName || null, input.createdBy],
  });
  return id;
}

/** 创建可编辑的草稿版本（已发布版本不可改，修订必须开新版本）。
 *  并发下多人同时建草稿会争抢同一 version_no，靠 UNIQUE(problem_id, version_no)
 *  拦截并重试：每次重试都重新取 MAX+1，直到插入成功或超过重试上限。
 *  重试上限取较大值并带抖动退避 —— N 个并发创建时最坏需要 N 轮才能全部落位。 */
export async function createDraftVersion(problemId: string, opts: { rawText?: string; pdfSha?: string } = {}): Promise<string> {
  await ensureSchema();
  const MAX_RETRY = Number(process.env.DRAFT_VERSION_MAX_RETRY || 25);
  for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
    const rs = await db().execute({
      sql: "SELECT COALESCE(MAX(version_no), 0) v FROM problem_versions WHERE problem_id=?",
      args: [problemId],
    });
    const next = Number(rs.rows[0]?.v || 0) + 1;
    const vid = uid("PVER");
    try {
      const ins = await db().execute({
        sql: `INSERT INTO problem_versions (version_id, problem_id, version_no, status, raw_text, source_pdf_sha256, immutable)
              VALUES (?,?,?, 'draft', ?, ?, 0)
              ON CONFLICT (problem_id, version_no) DO NOTHING
              RETURNING version_id`,
        args: [vid, problemId, next, opts.rawText || null, opts.pdfSha || null],
      });
      if (ins.rows.length) return String(ins.rows[0].version_id);
      // 冲突：version_no 被别人抢先，抖动退避后重试取新的 MAX+1
    } catch {
      // 唯一冲突或瞬时错误，重试
    }
    await new Promise((r) => setTimeout(r, 5 + Math.random() * 15));
  }
  throw new Error("创建草稿版本失败：版本号并发冲突，请重试");
}

/** 按 PDF 哈希查已有版本（同一份 PDF 不重复解析） */
export async function findVersionByPdf(sha: string) {
  await ensureSchema();
  const rs = await db().execute({
    sql: `SELECT v.version_id, v.problem_id, v.version_no, v.status, p.title, p.year, p.code
          FROM problem_versions v JOIN official_problems p ON p.problem_id = v.problem_id
          WHERE v.source_pdf_sha256=? ORDER BY v.version_no DESC LIMIT 1`,
    args: [sha],
  });
  return rs.rows[0] || null;
}

export async function getDraftVersion(problemId: string) {
  await ensureSchema();
  const rs = await db().execute({
    sql: `SELECT version_id, version_no, status, raw_text FROM problem_versions
          WHERE problem_id=? AND status != 'published' ORDER BY version_no DESC LIMIT 1`,
    args: [problemId],
  });
  return rs.rows[0] || null;
}

export async function getPublishedVersion(problemId: string) {
  await ensureSchema();
  const rs = await db().execute({
    sql: `SELECT version_id, version_no, published_at FROM problem_versions
          WHERE problem_id=? AND status='published' ORDER BY version_no DESC LIMIT 1`,
    args: [problemId],
  });
  return rs.rows[0] || null;
}

/** 读取某版本的完整内容。
 *  executor 默认走全局 db()；在事务中必须由调用方传入 tx，
 *  否则读取会走另一条连接，看不到事务内的改动、也不在 FOR UPDATE 的一致快照里。 */
export async function getVersionContent(versionId: string, executor?: Executor) {
  // 传入 executor（事务）时由外层保证 schema ready：此处再调 ensureSchema 会走全局
  // db 连接，既在事务外产生额外往返，也可能在事务持锁期间引发迁移写入
  if (!executor) await ensureSchema();
  const ex = executor ?? db();
  // 事务内是单条连接，不能并发多路复用，因此顺序执行（非事务下这点开销可忽略）
  const ver = await ex.execute({
    sql: `SELECT v.*, p.year, p.code, p.title, p.group_name FROM problem_versions v
          JOIN official_problems p ON p.problem_id=v.problem_id WHERE v.version_id=?`, args: [versionId] });
  if (!ver.rows.length) return null;
  const reqs = await ex.execute({ sql: "SELECT * FROM problem_requirements WHERE version_id=? ORDER BY sort_order, requirement_no", args: [versionId] });
  const items = await ex.execute({ sql: "SELECT * FROM problem_scoring_items WHERE version_id=? ORDER BY sort_order", args: [versionId] });
  const notes = await ex.execute({ sql: "SELECT * FROM problem_notes WHERE version_id=? ORDER BY created_at", args: [versionId] });
  const reviews = await ex.execute({ sql: "SELECT * FROM problem_reviews WHERE version_id=? ORDER BY created_at", args: [versionId] });
  return {
    version: ver.rows[0] as any,
    requirements: (reqs.rows as any[]).map((r) => ({ ...r, id: r.requirement_no })),
    scoring_items: (items.rows as any[]).map((r) => ({
      ...r,
      requirement_ids: (() => { try { return JSON.parse(String(r.requirement_refs || "[]")); } catch { return []; } })(),
    })),
    notes: notes.rows as any[],
    reviews: reviews.rows as any[],
  };
}

/** 写入提取结果（仅草稿版本可写）。
 *  全程单一事务：任一条插入失败则整批回滚，绝不会留下「半套提取结果」
 *  （旧实现是多条独立 SQL：先 DELETE 再逐条 INSERT，中途失败会把原数据删光）。 */
export async function saveExtraction(versionId: string, data: {
  requirements?: any[]; scoringItems?: any[]; ambiguities?: any[]; rawText?: string;
}) {
  await ensureSchema();
  await withTransaction(async (tx) => {
    // 锁定版本行，阻止并发写入与「检查后被发布」的竞态
    const v = await tx.execute({
      sql: "SELECT immutable, status FROM problem_versions WHERE version_id=? FOR UPDATE",
      args: [versionId],
    });
    if (!v.rows.length) throw new Error("版本不存在");
    if (Number((v.rows[0] as any).immutable) === 1 || String((v.rows[0] as any).status) === "published") {
      throw new Error("已发布版本不可修改，请创建新版本后再编辑");
    }

    if (data.rawText !== undefined) {
      await tx.execute({ sql: "UPDATE problem_versions SET raw_text=? WHERE version_id=?", args: [data.rawText, versionId] });
    }
    if (data.requirements) {
      await tx.execute({ sql: "DELETE FROM problem_requirements WHERE version_id=?", args: [versionId] });
      let i = 0;
      for (const r of data.requirements) {
        i++;
        await tx.execute({
          sql: `INSERT INTO problem_requirements (req_id, version_id, requirement_no, type, description, target, unit,
                  tolerance, priority, verification_method, source_page, source_quote, status, sort_order)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          args: [uid("PRQ"), versionId, r.id || r.requirement_no || `REQ-${String(i).padStart(3, "0")}`,
            r.type || null, r.description || "", r.target != null ? String(r.target) : null, r.unit || null,
            r.tolerance || null, r.priority || "mandatory", r.verification_method || null,
            r.source_page != null ? Number(r.source_page) : null, r.source_quote || r.source || null,
            r.status || "AI_EXTRACTED", i],
        });
      }
    }
    if (data.scoringItems) {
      await tx.execute({ sql: "DELETE FROM problem_scoring_items WHERE version_id=?", args: [versionId] });
      let i = 0;
      for (const s of data.scoringItems) {
        i++;
        await tx.execute({
          sql: `INSERT INTO problem_scoring_items (item_id, version_id, item, points, points_type,
                  requirement_refs, source_page, source_quote, sort_order)
                VALUES (?,?,?,?,?,?,?,?,?)`,
          args: [uid("PSI"), versionId, s.item || "", s.points != null ? Number(s.points) : null,
            s.points_type || "estimated", JSON.stringify(s.requirement_ids || []),
            s.source_page != null ? Number(s.source_page) : null, s.source_quote || null, i],
        });
      }
    }
    if (data.ambiguities) {
      await tx.execute({ sql: "DELETE FROM problem_notes WHERE version_id=? AND kind='ambiguity'", args: [versionId] });
      for (const a of data.ambiguities) {
        const text = typeof a === "string" ? a : (a?.description || JSON.stringify(a));
        await tx.execute({
          sql: "INSERT INTO problem_notes (note_id, version_id, kind, content) VALUES (?,?,'ambiguity',?)",
          args: [uid("PN"), versionId, String(text).slice(0, 1000)],
        });
      }
    }
    await tx.execute({ sql: "UPDATE problem_versions SET status='extracted' WHERE version_id=? AND status='draft'", args: [versionId] });
  });
}

/* ============ 双模复核差异匹配 ============ */

const norm = (s: any) => String(s ?? "").replace(/\s+/g, "").toLowerCase();

/** 字符二元组 Dice 相似度：对中文短句效果好且计算快 */
export function similarity(a: string, b: string): number {
  const x = norm(a), y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const bigrams = (s: string) => {
    const out = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      out.set(g, (out.get(g) || 0) + 1);
    }
    return out;
  };
  const bx = bigrams(x), by = bigrams(y);
  let inter = 0;
  for (const [g, n] of bx) inter += Math.min(n, by.get(g) || 0);
  const total = (x.length - 1) + (y.length - 1);
  return total > 0 ? (2 * inter) / total : 0;
}

export interface MatchedPair {
  a: any | null;
  b: any | null;
  method: "requirement_no" | "source_page" | "source_quote" | "unmatched";
  confidence: number;
}

/** 多策略配对：编号 → 页码+描述 → 原文相似度 → 未匹配。
 *  绝不按数组下标对齐 —— 一方多提取一条会导致后续全部错位、产生大量假差异。 */
export function matchRequirements(listA: any[], listB: any[]): MatchedPair[] {
  const pairs: MatchedPair[] = [];
  const usedB = new Set<number>();
  const idOf = (r: any) => r?.id || r?.requirement_no;
  const quoteOf = (r: any) => r?.source_quote || r?.source || "";

  for (const a of listA) {
    let idx = listB.findIndex((b, i) => !usedB.has(i) && idOf(b) && idOf(a) && norm(idOf(b)) === norm(idOf(a)));
    if (idx >= 0) { usedB.add(idx); pairs.push({ a, b: listB[idx], method: "requirement_no", confidence: 1 }); continue; }

    const samePage = listB
      .map((b, i) => ({ b, i }))
      .filter(({ b, i }) => !usedB.has(i) && a.source_page != null && b.source_page != null
        && Number(a.source_page) === Number(b.source_page));
    if (samePage.length) {
      const best = samePage
        .map(({ b, i }) => ({ i, b, s: similarity(a.description, b.description) }))
        .sort((x, y) => y.s - x.s)[0];
      if (best && best.s >= 0.5) {
        usedB.add(best.i);
        pairs.push({ a, b: best.b, method: "source_page", confidence: best.s });
        continue;
      }
    }

    const byQuote = listB
      .map((b, i) => ({ b, i, s: Math.max(similarity(quoteOf(a), quoteOf(b)), similarity(a.description, b.description)) }))
      .filter(({ i }) => !usedB.has(i))
      .sort((x, y) => y.s - x.s)[0];
    if (byQuote && byQuote.s >= 0.6) {
      usedB.add(byQuote.i);
      pairs.push({ a, b: byQuote.b, method: "source_quote", confidence: byQuote.s });
      continue;
    }

    pairs.push({ a, b: null, method: "unmatched", confidence: 0 });
  }

  listB.forEach((b, i) => {
    if (!usedB.has(i)) pairs.push({ a: null, b, method: "unmatched", confidence: 0 });
  });
  return pairs;
}

export interface Diff {
  field_path: string; requirement_no?: string | null;
  value_a: string; value_b: string; severity: "critical" | "warning" | "info";
  match_method: string; match_confidence: number;
}

export function diffExtractions(
  a: { requirements: any[]; scoring_items: any[] },
  b: { requirements: any[]; scoring_items: any[] },
): Diff[] {
  const diffs: Diff[] = [];
  const pairs = matchRequirements(a.requirements || [], b.requirements || []);

  for (const p of pairs) {
    const no = (p.a?.id || p.a?.requirement_no || p.b?.id || p.b?.requirement_no) ?? null;
    if (!p.a || !p.b) {
      diffs.push({
        field_path: `requirements[${no ?? "?"}]`, requirement_no: no,
        value_a: p.a ? String(p.a.description || "").slice(0, 160) : "（未提取到）",
        value_b: p.b ? String(p.b.description || "").slice(0, 160) : "（未提取到）",
        severity: "warning", match_method: p.method, match_confidence: p.confidence,
      });
      continue;
    }
    if (norm(p.a.description) !== norm(p.b.description)) {
      const sim = similarity(p.a.description, p.b.description);
      diffs.push({
        field_path: `requirements[${no}].description`, requirement_no: no,
        value_a: String(p.a.description || "").slice(0, 160),
        value_b: String(p.b.description || "").slice(0, 160),
        severity: sim >= 0.8 ? "info" : "warning",
        match_method: p.method, match_confidence: p.confidence,
      });
    }
    // 量化指标不一致 = 高危：直接影响测试判定与得分
    if (norm(p.a.target) !== norm(p.b.target) || norm(p.a.unit) !== norm(p.b.unit) || norm(p.a.tolerance) !== norm(p.b.tolerance)) {
      diffs.push({
        field_path: `requirements[${no}].target`, requirement_no: no,
        value_a: `${p.a.target ?? "—"}${p.a.unit ?? ""} ${p.a.tolerance ?? ""}`.trim(),
        value_b: `${p.b.target ?? "—"}${p.b.unit ?? ""} ${p.b.tolerance ?? ""}`.trim(),
        severity: "critical", match_method: p.method, match_confidence: p.confidence,
      });
    }
    if (norm(p.a.priority) !== norm(p.b.priority)) {
      diffs.push({
        field_path: `requirements[${no}].priority`, requirement_no: no,
        value_a: String(p.a.priority ?? ""), value_b: String(p.b.priority ?? ""),
        severity: "warning", match_method: p.method, match_confidence: p.confidence,
      });
    }
  }

  const sa = a.scoring_items || [], sb = b.scoring_items || [];
  const usedB = new Set<number>();
  for (const x of sa) {
    const best = sb.map((y, i) => ({ y, i, s: similarity(x.item, y.item) }))
      .filter(({ i }) => !usedB.has(i)).sort((m, n) => n.s - m.s)[0];
    if (!best || best.s < 0.5) {
      diffs.push({ field_path: `scoring_items[${x.item}]`, value_a: `${x.item}: ${x.points ?? "—"}`,
        value_b: "（未提取到）", severity: "warning", match_method: "unmatched", match_confidence: 0 });
      continue;
    }
    usedB.add(best.i);
    if (Number(x.points ?? -1) !== Number(best.y.points ?? -1)) {
      diffs.push({
        field_path: `scoring_items[${x.item}].points`,
        value_a: `${x.item}: ${x.points ?? "—"}`, value_b: `${best.y.item}: ${best.y.points ?? "—"}`,
        severity: "critical", match_method: "source_quote", match_confidence: best.s,
      });
    }
  }
  sb.forEach((y, i) => {
    if (!usedB.has(i)) diffs.push({ field_path: `scoring_items[${y.item}]`, value_a: "（未提取到）",
      value_b: `${y.item}: ${y.points ?? "—"}`, severity: "warning", match_method: "unmatched", match_confidence: 0 });
  });

  return diffs;
}

export async function saveDiffs(versionId: string, problemId: string, diffs: Diff[], providerA: string, providerB: string) {
  // 差异写入同样受版本锁保护；不再 .catch 吞掉错误（静默失败会让差异清单看起来"无差异"）
  await withVersionWriteLock(versionId, async (tx) => {
    await tx.execute({ sql: "DELETE FROM problem_review_diffs WHERE version_id=? AND resolved=0", args: [versionId] });
    for (const d of diffs) {
      await tx.execute({
        sql: `INSERT INTO problem_review_diffs (problem_id, version_id, requirement_no, field_path,
                provider_a, provider_b, value_a, value_b, severity, match_method, match_confidence)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        args: [problemId, versionId, d.requirement_no ?? null, d.field_path, providerA, providerB,
          d.value_a?.slice(0, 500), d.value_b?.slice(0, 500), d.severity, d.match_method, d.match_confidence],
      });
    }
  });
}

/* ============ 发布清单与不可变版本 ============ */

/** 清单项。severity=error 阻断发布；severity=warning 仅提示，不阻断。 */
export interface ChecklistItem { key: string; label: string; passed: boolean; detail: string; severity: "error" | "warning" }

/** 发布前检查。所有 severity=error 的项通过（或 admin 显式 override）才允许发布。
 *  executor 默认走全局 db()；在事务中必须传入 tx，保证与发布写入同一快照。 */
export async function publicationChecklist(versionId: string, executor?: Executor): Promise<{ items: ChecklistItem[]; passed: boolean }> {
  // 同 getVersionContent：传入 tx 时不得再访问全局 db
  if (!executor) await ensureSchema();
  const ex = executor ?? db();
  const content = await getVersionContent(versionId, ex);
  const items: ChecklistItem[] = [];
  if (!content) return { items: [{ key: "exists", label: "版本存在", passed: false, detail: "版本不存在", severity: "error" }], passed: false };

  const reqs = content.requirements;
  const scoring = content.scoring_items;

  items.push({ key: "has_requirements", label: "已提取需求", passed: reqs.length > 0, detail: `${reqs.length} 条`, severity: "error" });

  const pending = reqs.filter((r) => !["CONFIRMED", "REJECTED"].includes(String(r.status)));
  items.push({
    key: "all_confirmed", label: "需求全部确认或驳回",
    passed: pending.length === 0,
    detail: pending.length ? `${pending.length} 条待确认：${pending.slice(0, 3).map((r) => r.requirement_no).join("、")}` : "全部已处理",
    severity: "error",
  });

  // 正式需求必须「同时」有 source_page 与 source_quote。
  // 人工补充要求可例外，但须 source_type=STAFF_ADDED 且有 reviewer + reason。
  const badSource = reqs.filter((r) => {
    if (String(r.status) === "REJECTED") return false;
    const isStaff = String((r as any).source_type) === "STAFF_ADDED";
    if (isStaff) {
      // 工作人员补充：必须有审核人与理由
      return !((r as any).staff_reviewer && (r as any).staff_reason);
    }
    // AI 提取的正式需求：页码与原文引用缺一不可
    return !(r.source_quote && r.source_page != null);
  });
  items.push({
    key: "has_source", label: "每条正式需求同时具备页码与原文引用（人工补充需审核人+理由）",
    passed: badSource.length === 0,
    detail: badSource.length ? `${badSource.length} 条溯源不完整：${badSource.slice(0, 3).map((r) => r.requirement_no).join("、")}` : "全部满足",
    severity: "error",
  });

  const diffs = await ex.execute({
    sql: "SELECT COUNT(*) n FROM problem_review_diffs WHERE version_id=? AND resolved=0 AND severity='critical'",
    args: [versionId],
  }).catch(() => ({ rows: [{ n: 0 }] as any[] }));
  const crit = Number((diffs.rows[0] as any)?.n || 0);
  items.push({ key: "no_critical_diff", label: "无未确认的关键差异", passed: crit === 0, detail: crit ? `${crit} 处指标/分值差异待确认` : "无", severity: "error" });

  const amb = content.notes.filter((n) => String(n.kind) === "ambiguity" && Number(n.resolved) === 0);
  items.push({ key: "ambiguity_resolved", label: "题面歧义已处理", passed: amb.length === 0, detail: amb.length ? `${amb.length} 条未处理` : "无", severity: "error" });

  const official = scoring.filter((s) => String(s.points_type) === "official" && s.points != null);
  const total = official.reduce((a, s) => a + Number(s.points), 0);
  const sane = official.length === 0 || (total > 0 && total <= 200);
  // 预期总分未配置时，总分范围只是启发式判断（不同赛题总分口径不同），仅告警不阻断
  const ver: any = content.version;
  const expectedTotal = ver.expected_total_score != null ? Number(ver.expected_total_score) : null;
  items.push({
    key: "scoring_total", label: "官方评分总分合理",
    passed: sane, detail: official.length ? `官方分值 ${official.length} 项，合计 ${total}` : "题面未给官方分值（按估算口径）",
    severity: expectedTotal != null ? "error" : "warning",
  });

  const unbound = official.filter((s) => !(s.requirement_ids || []).length);
  items.push({
    key: "scoring_bound", label: "官方评分项已绑定需求",
    passed: unbound.length === 0,
    detail: unbound.length ? `${unbound.length} 项未绑定` : official.length ? "全部已绑定" : "无官方分值项",
    severity: "error",
  });

  const reviewers = new Set(content.reviews.filter((r) => String(r.decision) === "approve").map((r) => String(r.reviewer)));
  items.push({
    key: "two_reviewers", label: "至少两名工作人员审核通过",
    passed: reviewers.size >= 2, detail: `${reviewers.size} 人已通过`, severity: "error",
  });

  // 预期评分结构核对：配置了 expected_total_score 时，精确不一致为阻断性错误
  if (expectedTotal != null) {
    const officialTotal = official.reduce((a, s) => a + Number(s.points || 0), 0);
    const parts = [
      ver.expected_report_score, ver.expected_basic_score, ver.expected_advanced_score,
    ].filter((x) => x != null).map(Number);
    const partsSum = parts.reduce((a, b) => a + b, 0);
    const totalOk = officialTotal === expectedTotal;
    const partsOk = parts.length === 0 || partsSum === expectedTotal;
    items.push({
      key: "expected_score_match", label: "评分结构与预期总分精确一致",
      passed: totalOk && partsOk,
      detail: totalOk && partsOk
        ? `预期 ${expectedTotal} 分，官方分值合计 ${officialTotal} 分`
        : `预期 ${expectedTotal}，官方合计 ${officialTotal}${parts.length ? `，分项合计 ${partsSum}` : ""}（不一致）`,
      severity: "error",
    });
  }

  // 只有 error 级未通过才阻断发布；warning 级仅提示
  return { items, passed: items.every((i) => i.passed || i.severity === "warning") };
}

/** 赛题子表写入统一守卫。
 *
 *  problem_requirements / problem_scoring_items / problem_notes /
 *  problem_reviews / problem_review_diffs 都从属于某个 problem_version，
 *  任何修改都必须：
 *    事务内 SELECT problem_versions FOR UPDATE
 *    → 检查 immutable=0 且 status != 'published'
 *    → 执行修改 → commit
 *
 *  否则会出现：发布事务正在冻结版本的同时，另一条连接仍在改子表 ——
 *  content_hash 与实际内容对不上，已发布版本的"不可变"承诺被破坏。
 *
 *  用法：
 *    await withVersionWriteLock(versionId, async (tx) => { ...修改子表... });
 */
export async function withVersionWriteLock<T>(
  versionId: string,
  fn: (tx: Executor) => Promise<T>,
): Promise<T> {
  await ensureSchema();
  return withTransaction(async (tx) => {
    const v = await tx.execute({
      sql: "SELECT immutable, status FROM problem_versions WHERE version_id=? FOR UPDATE",
      args: [versionId],
    });
    if (!v.rows.length) throw new VersionWriteError("版本不存在", "NOT_FOUND");
    const row: any = v.rows[0];
    if (Number(row.immutable) === 1 || String(row.status) === "published") {
      throw new VersionWriteError("已发布版本不可修改，请创建新版本后再编辑", "IMMUTABLE");
    }
    return fn(tx);
  });
}

/** 子表写入被拒绝的结构化错误（便于 API 层映射为 409） */
export class VersionWriteError extends Error {
  constructor(message: string, readonly code: "NOT_FOUND" | "IMMUTABLE") {
    super(message);
    this.name = "VersionWriteError";
  }
}

/** 由子表行反查其所属 version_id（API 层只拿到 note_id / diff id 时使用） */
export async function versionIdOf(table: "problem_notes" | "problem_review_diffs" | "problem_requirements", idCol: string, idVal: string): Promise<string | null> {
  await ensureSchema();
  const allowed: Record<string, string> = {
    problem_notes: "note_id", problem_review_diffs: "id", problem_requirements: "req_id",
  };
  if (allowed[table] !== idCol) throw new Error("非法的子表主键列");
  const rs = await db().execute({
    sql: `SELECT version_id FROM ${table} WHERE ${idCol}=?`, args: [idVal],
  });
  return rs.rows.length ? String(rs.rows[0].version_id) : null;
}

export async function addReview(versionId: string, reviewer: string, decision: "approve" | "reject", note?: string) {
  // 审核记录同样受版本锁保护：不能给已发布版本追加审核
  await withVersionWriteLock(versionId, async (tx) => {
    await tx.execute({
      sql: "INSERT INTO problem_reviews (review_id, version_id, reviewer, decision, note) VALUES (?,?,?,?,?)",
      args: [uid("PRV"), versionId, reviewer, decision, note || null],
    });
  });
}

/** 发布版本：通过清单后冻结为不可变版本。
 *  整个过程在单一事务内完成，任一步失败全部回滚：
 *    1. 锁定 version 行（FOR UPDATE）
 *    2. 事务内重新执行 publicationChecklist（避免检查与发布之间的 TOCTOU）
 *    3. 确认仍未发布
 *    4. 生成 content_hash
 *    5. immutable=1、status=published
 *    6. 更新 official_problems
 *    7. commit */
export async function publishVersion(versionId: string, publishedBy: string, override = false):
  Promise<{ ok: boolean; error?: string; checklist?: ChecklistItem[] }> {
  await ensureSchema();

  try {
    return await withTransaction(async (tx) => {
      // 1) 锁定版本行，阻止并发发布
      const locked = await tx.execute({
        sql: "SELECT version_id, status, immutable FROM problem_versions WHERE version_id=? FOR UPDATE",
        args: [versionId],
      });
      if (!locked.rows.length) return { ok: false, error: "版本不存在" };
      // 3)（提前）确认仍未发布
      if (String(locked.rows[0].status) === "published" || Number(locked.rows[0].immutable) === 1) {
        return { ok: false, error: "该版本已发布，无需重复发布" };
      }

      // 2) 事务内重新执行发布清单 —— 必须传入 tx，否则读取会走另一条连接，
      //    看不到锁内快照，检查与写入之间仍存在 TOCTOU
      const { items, passed } = await publicationChecklist(versionId, tx);
      if (!passed && !override) {
        // 只有 error 级阻断；warning 级不计入失败原因
        const failed = items.filter((i) => !i.passed && i.severity === "error").map((i) => i.label).join("、");
        return { ok: false, error: `发布清单未通过：${failed}`, checklist: items };
      }

      const content = await getVersionContent(versionId, tx);
      if (!content) return { ok: false, error: "版本不存在" };

      // 4) 生成不可变内容哈希
      const hash = createHash("sha256")
        .update(JSON.stringify({ r: content.requirements, s: content.scoring_items }))
        .digest("hex").slice(0, 32);

      // 5) 冻结版本
      const upd = await tx.execute({
        sql: `UPDATE problem_versions SET status='published', published_by=?, published_at=now(),
                immutable=1, content_hash=? WHERE version_id=? AND status != 'published'
              RETURNING version_id`,
        args: [publishedBy + (override ? " (override)" : ""), hash, versionId],
      });
      // 竞态兜底：若被并发抢先发布则回滚
      if (!upd.rows.length) return { ok: false, error: "版本状态已变化，请重试" };

      // 6) 同步 official_problems
      await tx.execute({
        sql: `UPDATE official_problems SET status='published', updated_at=now()
              WHERE problem_id=(SELECT problem_id FROM problem_versions WHERE version_id=?)`,
        args: [versionId],
      });

      return { ok: true, checklist: items };
    });
  } catch (e: any) {
    return { ok: false, error: `发布失败（已回滚）：${e?.message || e}` };
  }
}

export async function listProblems(opts: { publishedOnly?: boolean; year?: number } = {}) {
  await ensureSchema();
  const where: string[] = [];
  const args: any[] = [];
  if (opts.year) { where.push("p.year=?"); args.push(opts.year); }
  const rs = await db().execute({
    sql: `SELECT p.problem_id, p.year, p.code, p.title, p.group_name, p.status,
            (SELECT version_no FROM problem_versions v WHERE v.problem_id=p.problem_id AND v.status='published' ORDER BY version_no DESC LIMIT 1) published_version,
            (SELECT version_id FROM problem_versions v WHERE v.problem_id=p.problem_id AND v.status='published' ORDER BY version_no DESC LIMIT 1) published_version_id,
            (SELECT COUNT(*) FROM problem_review_diffs d
               JOIN problem_versions v2 ON v2.version_id = d.version_id
               WHERE v2.problem_id = p.problem_id AND d.resolved = 0 AND d.severity='critical') open_critical
          FROM official_problems p
          ${where.length ? "WHERE " + where.join(" AND ") : ""}
          ORDER BY p.year DESC, p.code ASC LIMIT 200`,
    args,
  });
  const rows = rs.rows as any[];
  return opts.publishedOnly ? rows.filter((r) => r.published_version_id) : rows;
}
