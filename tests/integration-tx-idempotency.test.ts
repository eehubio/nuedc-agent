import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { setupMockDb, teardownMockDb, type MockDbContext } from "./helpers/mock-db";

/** Commit 1 集成测试：
 *  一、赛题发布全程使用同一事务连接（读写同一快照）
 *  二、saveExtraction 单一事务，中途失败原数据完整保留
 *  三、idempotency_key 并发冲突不返回 500、不泄漏配额 */

let ctx: MockDbContext;
beforeEach(async () => { ctx = await setupMockDb(); await ctx.reset(); });
afterAll(teardownMockDb);

async function seedVersion(opts: { reviewers?: number; expectedTotal?: number | null; officialPoints?: number } = {}) {
  const { createProblem, createDraftVersion, addReview } = await import("@/lib/problem-center");
  const pid = await createProblem({ year: 2025, code: "A", title: "测试题", createdBy: "staff:1" });
  const vid = await createDraftVersion(pid);
  await ctx.raw(
    `INSERT INTO problem_requirements (req_id, version_id, requirement_no, description, status,
        source_page, source_quote, source_type, sort_order)
     VALUES ('R1',$1,'REQ-001','需求一','CONFIRMED',3,'原文引用','AI_EXTRACTED',1)`,
    [vid],
  );
  await ctx.raw(
    `INSERT INTO problem_scoring_items (item_id, version_id, item, points, points_type, requirement_refs, sort_order)
     VALUES ('S1',$1,'基本要求',$2,'official','["REQ-001"]',1)`,
    [vid, opts.officialPoints ?? 50],
  );
  if (opts.expectedTotal != null) {
    await ctx.raw("UPDATE problem_versions SET expected_total_score=$1 WHERE version_id=$2", [opts.expectedTotal, vid]);
  }
  for (let i = 1; i <= (opts.reviewers ?? 2); i++) await addReview(vid, `staff:${i}`, "approve");
  return { pid, vid };
}

describe("一、发布使用同一事务连接", () => {
  it("getVersionContent / publicationChecklist 接受 executor 参数", async () => {
    const pc = await import("@/lib/problem-center");
    // 函数签名必须支持第二个 executor 参数（事务中由 publishVersion 传入 tx）
    expect(pc.getVersionContent.length).toBeGreaterThanOrEqual(2);
    expect(pc.publicationChecklist.length).toBeGreaterThanOrEqual(2);
  });

  it("publishVersion 内部把 tx 透传给清单与内容读取（源码约束）", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("lib/problem-center.ts", "utf8");
    const body = src.slice(src.indexOf("export async function publishVersion"));
    // 事务内的两处读取都必须带 tx，否则会走另一条连接读到事务外的快照
    expect(body).toMatch(/publicationChecklist\(versionId,\s*tx\)/);
    expect(body).toMatch(/getVersionContent\(versionId,\s*tx\)/);
    // 且不得再出现不带 executor 的裸调用
    expect(body).not.toMatch(/publicationChecklist\(versionId\)/);
    expect(body).not.toMatch(/getVersionContent\(versionId\)/);
  });

  it("发布读取保持一致快照：hash 基于事务内看到的数据", async () => {
    const { publishVersion } = await import("@/lib/problem-center");
    const { vid } = await seedVersion();
    const r = await publishVersion(vid, "staff:1");
    expect(r.ok).toBe(true);
    const v = await ctx.raw("SELECT content_hash FROM problem_versions WHERE version_id=$1", [vid]);
    const hash = String(v.rows[0].content_hash);
    expect(hash).toBeTruthy();

    // 同样内容重新计算应得到同一 hash（证明 hash 来自确定的一致快照）
    const { createHash } = await import("node:crypto");
    const { getVersionContent } = await import("@/lib/problem-center");
    const content = await getVersionContent(vid);
    const recomputed = createHash("sha256")
      .update(JSON.stringify({ r: content!.requirements, s: content!.scoring_items }))
      .digest("hex").slice(0, 32);
    expect(recomputed).toBe(hash);
  });

  it("发布中任一步失败 → 全部回滚，不留半发布状态", async () => {
    const { publishVersion } = await import("@/lib/problem-center");
    const { vid, pid } = await seedVersion();
    // 注入故障：让 official_problems 的更新失败（发布事务的最后一步写入）
    ctx.failOn({ match: /UPDATE official_problems/i, nth: 1, message: "注入：official_problems 更新失败" });
    const r = await publishVersion(vid, "staff:1");
    ctx.failOn(null);

    expect(r.ok).toBe(false);
    expect(r.error).toContain("已回滚");
    // version 必须回滚：既没 published，也没写 hash / immutable
    const v = await ctx.raw("SELECT status, immutable, content_hash FROM problem_versions WHERE version_id=$1", [vid]);
    expect(v.rows[0].status).not.toBe("published");
    expect(Number(v.rows[0].immutable || 0)).toBe(0);
    expect(v.rows[0].content_hash).toBeNull();
    const p = await ctx.raw("SELECT status FROM official_problems WHERE problem_id=$1", [pid]);
    expect(p.rows[0].status).not.toBe("published");
  });
});

describe("二、saveExtraction 单一事务", () => {
  async function draftWithData() {
    const { createProblem, createDraftVersion } = await import("@/lib/problem-center");
    const pid = await createProblem({ year: 2025, code: "B", title: "T", createdBy: "s" });
    const vid = await createDraftVersion(pid);
    // 先放一批原始数据，用于验证失败后是否被保留
    await ctx.raw(
      `INSERT INTO problem_requirements (req_id, version_id, requirement_no, description, status, sort_order)
       VALUES ('OLD1',$1,'OLD-001','原始需求一','CONFIRMED',1), ('OLD2',$1,'OLD-002','原始需求二','CONFIRMED',2)`,
      [vid],
    );
    await ctx.raw(
      `INSERT INTO problem_scoring_items (item_id, version_id, item, points, points_type, requirement_refs, sort_order)
       VALUES ('OLDS',$1,'原始评分',20,'official','[]',1)`,
      [vid],
    );
    return vid;
  }

  it("正常写入：全部替换成功", async () => {
    const { saveExtraction } = await import("@/lib/problem-center");
    const vid = await draftWithData();
    await saveExtraction(vid, {
      requirements: Array.from({ length: 6 }, (_, i) => ({ id: `REQ-${i + 1}`, description: `新需求${i + 1}` })),
      scoringItems: [{ item: "新评分", points: 40, points_type: "official" }],
    });
    const reqs = await ctx.raw("SELECT requirement_no FROM problem_requirements WHERE version_id=$1 ORDER BY sort_order", [vid]);
    expect(reqs.rows.length).toBe(6);
    expect(reqs.rows.map((r: any) => r.requirement_no)).not.toContain("OLD-001");
  });

  it("第 5 条 Requirement 插入失败 → 原数据完整保留，无半套结果", async () => {
    const { saveExtraction } = await import("@/lib/problem-center");
    const vid = await draftWithData();
    // 注入：第 5 次 INSERT problem_requirements 失败
    ctx.failOn({ match: /INSERT INTO problem_requirements/i, nth: 5, message: "注入：第5条需求插入失败" });
    await expect(saveExtraction(vid, {
      requirements: Array.from({ length: 8 }, (_, i) => ({ id: `REQ-${i + 1}`, description: `新需求${i + 1}` })),
      scoringItems: [{ item: "新评分", points: 40, points_type: "official" }],
    })).rejects.toThrow();
    ctx.failOn(null);

    // 原始两条必须还在，且没有任何新数据残留
    const reqs = await ctx.raw("SELECT requirement_no FROM problem_requirements WHERE version_id=$1 ORDER BY sort_order", [vid]);
    const nos = reqs.rows.map((r: any) => String(r.requirement_no));
    expect(nos).toEqual(["OLD-001", "OLD-002"]);      // 原数据完整保留
    expect(nos.some((n) => n.startsWith("REQ-"))).toBe(false);  // 无半套新结果

    // 评分项也不能被改（DELETE 也在同一事务里）
    const items = await ctx.raw("SELECT item_id FROM problem_scoring_items WHERE version_id=$1", [vid]);
    expect(items.rows.map((r: any) => r.item_id)).toEqual(["OLDS"]);
  });

  it("已发布版本不可写入", async () => {
    const { saveExtraction, publishVersion } = await import("@/lib/problem-center");
    const { vid } = await seedVersion();
    expect((await publishVersion(vid, "staff:1")).ok).toBe(true);
    await expect(saveExtraction(vid, { requirements: [{ id: "X", description: "d" }] }))
      .rejects.toThrow(/已发布版本不可修改/);
  });
});

describe("三、idempotency_key 并发", () => {
  // 直接压数据库层：模拟 N 个并发请求走「SELECT → INSERT」路径
  async function attempt(owner: string, idemKey: string, taskId: string) {
    const exist = await ctx.raw(
      "SELECT task_id FROM agent_tasks WHERE owner_ref=$1 AND idempotency_key=$2", [owner, idemKey],
    );
    if (exist.rows.length) return { taskId: String(exist.rows[0].task_id), inserted: false };
    try {
      const ins = await ctx.raw(
        `INSERT INTO agent_tasks (task_id, owner_ref, agent_type, status, tier, idempotency_key, priority, scheduled_at)
         VALUES ($1,$2,'solution_architect','queued','free',$3,5, now()) RETURNING task_id`,
        [taskId, owner, idemKey],
      );
      return { taskId: String(ins.rows[0].task_id), inserted: true };
    } catch (e: any) {
      // 唯一冲突：查已有任务返回（对应路由里的 catch 分支）
      const again = await ctx.raw(
        "SELECT task_id FROM agent_tasks WHERE owner_ref=$1 AND idempotency_key=$2", [owner, idemKey],
      );
      if (again.rows.length) return { taskId: String(again.rows[0].task_id), inserted: false, conflict: true };
      throw e;
    }
  }

  it("50 并发同一 idempotency_key：只生成一个任务，所有请求返回同一 task_id", async () => {
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => attempt("owner:A", "same-key", `T-${i}`)),
    );
    const ids = new Set(results.map((r) => r.taskId));
    expect(ids.size).toBe(1);                                   // 所有请求同一个 task_id
    expect(results.filter((r) => r.inserted).length).toBe(1);    // 只有一条真正插入
    const rows = await ctx.raw("SELECT COUNT(*) n FROM agent_tasks WHERE idempotency_key='same-key'");
    expect(Number(rows.rows[0].n)).toBe(1);                     // 数据库里只有一条
  });

  it("UNIQUE(owner_ref, idempotency_key) 约束存在且按用户隔离", async () => {
    const idx = await ctx.raw("SELECT indexdef FROM pg_indexes WHERE tablename='agent_tasks'");
    const defs = idx.rows.map((r: any) => String(r.indexdef)).join("\n");
    expect(defs).toMatch(/UNIQUE.*owner_ref.*idempotency_key/s);
    // 不同用户可用相同 key
    const a = await attempt("owner:A", "k", "TA");
    const b = await attempt("owner:B", "k", "TB");
    expect(a.taskId).toBe("TA");
    expect(b.taskId).toBe("TB");
  });

  it("路由在唯一冲突时退还配额并返回既有任务（源码约束）", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("app/api/agent-tasks/route.ts", "utf8");
    expect(src).toContain("23505");                     // 捕获 unique_violation
    expect(src).toMatch(/IDEMPOTENCY_CONFLICT/);
    // 冲突分支必须退款且返回已有 task_id，不能 500
    const branch = src.slice(src.indexOf('if (conflictKind === "IDEMPOTENCY_CONFLICT")'));
    expect(branch).toMatch(/refundQuota/);
    expect(branch).toMatch(/idempotency_key/);
  });

  it("配额只扣一次：并发下只有插入成功的那条持有预占", async () => {
    const { reserveQuota, refundQuota } = await import("@/lib/usage");
    // 模拟 10 个并发：各自预占，冲突者退还
    const outcomes = await Promise.all(Array.from({ length: 10 }, async (_, i) => {
      const { reservation } = await reserveQuota("owner:Q", "heavy_task", "free");
      const r = await attempt("owner:Q", "qkey", `Q-${i}`);
      if (!r.inserted && reservation) {
        await refundQuota("owner:Q", "heavy_task", reservation.ref);
        return "refunded";
      }
      return "kept";
    }));
    expect(outcomes.filter((o) => o === "kept").length).toBe(1);
    const q = await ctx.raw("SELECT used FROM quota_counters WHERE owner='owner:Q' AND kind='heavy_task' AND day=CURRENT_DATE");
    expect(Number(q.rows[0].used)).toBe(1);   // 净扣一次
  });
});

describe("七、清单分级", () => {
  it("未配置 expected_total_score：总分范围只做 warning", async () => {
    const { publicationChecklist } = await import("@/lib/problem-center");
    const { vid } = await seedVersion({ expectedTotal: null });
    const { items } = await publicationChecklist(vid);
    const st = items.find((i) => i.key === "scoring_total");
    expect(st?.severity).toBe("warning");
  });

  it("配置 expected_total_score：不一致为阻断性 error", async () => {
    const { publicationChecklist, publishVersion } = await import("@/lib/problem-center");
    const { vid } = await seedVersion({ expectedTotal: 100, officialPoints: 50 });
    const { items, passed } = await publicationChecklist(vid);
    const m = items.find((i) => i.key === "expected_score_match");
    expect(m?.severity).toBe("error");
    expect(m?.passed).toBe(false);
    expect(passed).toBe(false);
    // 且必须真的阻断发布
    const r = await publishVersion(vid, "staff:1");
    expect(r.ok).toBe(false);
  });

  it("warning 项未通过不阻断发布", async () => {
    const { publicationChecklist } = await import("@/lib/problem-center");
    const { vid } = await seedVersion({ expectedTotal: null, officialPoints: 500 });  // 超 200，总分范围不合理
    const { items, passed } = await publicationChecklist(vid);
    const st = items.find((i) => i.key === "scoring_total");
    expect(st?.passed).toBe(false);
    expect(st?.severity).toBe("warning");
    expect(passed).toBe(true);      // warning 不阻断
  });
});
