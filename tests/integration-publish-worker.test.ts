import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { setupMockDb, teardownMockDb, type MockDbContext } from "./helpers/mock-db";

/** Commit 3 集成测试：
 *  - 赛题版本号并发（UNIQUE + 冲突重试）
 *  - 发布事务（全成功或全回滚、并发只有一个成功）
 *  - 发布清单加严（页码+原文引用同时具备；STAFF_ADDED 例外；预期分值核对）
 *  - Worker 心跳与队列积压报警
 *  - 100 并发 mock 压测 */

let ctx: MockDbContext;
beforeEach(async () => { ctx = await setupMockDb(); await ctx.reset(); });
afterAll(teardownMockDb);

// —— 建一个题目 + 一个可发布的草稿版本 ——
async function seedPublishableVersion(opts: {
  sourceComplete?: boolean; staffAdded?: boolean; expectedTotal?: number | null; officialPoints?: number;
} = {}) {
  const { createProblem, createDraftVersion, addReview } = await import("@/lib/problem-center");
  const pid = await createProblem({ year: 2025, code: "A", title: "测试题", createdBy: "staff:1" });
  const vid = await createDraftVersion(pid);

  const sourceComplete = opts.sourceComplete ?? true;
  const staff = opts.staffAdded ?? false;
  await ctx.raw(
    `INSERT INTO problem_requirements (req_id, version_id, requirement_no, description, status,
        source_page, source_quote, source_type, staff_reviewer, staff_reason, sort_order)
     VALUES ('R1',$1,'REQ-001','需求一','CONFIRMED',$2,$3,$4,$5,$6,1)`,
    [vid,
      sourceComplete ? 3 : null,
      sourceComplete ? "原文引用" : null,
      staff ? "STAFF_ADDED" : "AI_EXTRACTED",
      staff ? "staff:2" : null,
      staff ? "题面遗漏，人工补充" : null],
  );
  const pts = opts.officialPoints ?? 50;
  await ctx.raw(
    `INSERT INTO problem_scoring_items (item_id, version_id, item, points, points_type, requirement_refs, sort_order)
     VALUES ('S1',$1,'基本要求',$2,'official','["REQ-001"]',1)`,
    [vid, pts],
  );
  if (opts.expectedTotal !== undefined && opts.expectedTotal !== null) {
    await ctx.raw("UPDATE problem_versions SET expected_total_score=$1 WHERE version_id=$2", [opts.expectedTotal, vid]);
  }
  await addReview(vid, "staff:1", "approve");
  await addReview(vid, "staff:2", "approve");
  return { pid, vid };
}

describe("赛题版本号并发", () => {
  it("串行创建草稿版本号递增", async () => {
    const { createProblem, createDraftVersion } = await import("@/lib/problem-center");
    const pid = await createProblem({ year: 2025, code: "B", title: "T", createdBy: "s" });
    await createDraftVersion(pid);
    await createDraftVersion(pid);
    const rs = await ctx.raw("SELECT version_no FROM problem_versions WHERE problem_id=$1 ORDER BY version_no", [pid]);
    expect(rs.rows.map((r: any) => Number(r.version_no))).toEqual([1, 2]);
  });

  it("并发创建 8 个草稿：版本号唯一且连续，无冲突丢失", async () => {
    const { createProblem, createDraftVersion } = await import("@/lib/problem-center");
    const pid = await createProblem({ year: 2025, code: "C", title: "T", createdBy: "s" });
    const ids = await Promise.all(Array.from({ length: 8 }, () => createDraftVersion(pid)));
    expect(new Set(ids).size).toBe(8);              // 8 个不同版本
    const rs = await ctx.raw("SELECT version_no FROM problem_versions WHERE problem_id=$1 ORDER BY version_no", [pid]);
    const nos = rs.rows.map((r: any) => Number(r.version_no));
    expect(nos).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);  // 唯一且连续
  });

  it("UNIQUE(problem_id, version_no) 约束存在", async () => {
    const rs = await ctx.raw(
      `SELECT indexdef FROM pg_indexes WHERE tablename='problem_versions'`,
    );
    const defs = rs.rows.map((r: any) => String(r.indexdef)).join("\n");
    expect(defs).toMatch(/UNIQUE.*problem_id.*version_no/s);
  });
});

describe("发布事务", () => {
  it("清单通过 → 发布成功，版本冻结且题目状态同步", async () => {
    const { publishVersion } = await import("@/lib/problem-center");
    const { vid, pid } = await seedPublishableVersion();
    const r = await publishVersion(vid, "staff:1");
    expect(r.ok).toBe(true);

    const v = await ctx.raw("SELECT status, immutable, content_hash, published_by FROM problem_versions WHERE version_id=$1", [vid]);
    expect(v.rows[0].status).toBe("published");
    expect(Number(v.rows[0].immutable)).toBe(1);
    expect(v.rows[0].content_hash).toBeTruthy();
    const p = await ctx.raw("SELECT status FROM official_problems WHERE problem_id=$1", [pid]);
    expect(p.rows[0].status).toBe("published");
  });

  it("清单未通过 → 不发布，且不留下半发布状态（全回滚）", async () => {
    const { publishVersion } = await import("@/lib/problem-center");
    // 溯源不完整 → has_source 不通过
    const { vid, pid } = await seedPublishableVersion({ sourceComplete: false });
    const r = await publishVersion(vid, "staff:1");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("发布清单未通过");

    const v = await ctx.raw("SELECT status, immutable, content_hash FROM problem_versions WHERE version_id=$1", [vid]);
    expect(v.rows[0].status).not.toBe("published");
    expect(Number(v.rows[0].immutable || 0)).toBe(0);
    expect(v.rows[0].content_hash).toBeNull();      // 未生成哈希
    const p = await ctx.raw("SELECT status FROM official_problems WHERE problem_id=$1", [pid]);
    expect(p.rows[0].status).not.toBe("published");  // official_problems 未被改
  });

  it("重复发布被拒绝（已发布版本不可再发）", async () => {
    const { publishVersion } = await import("@/lib/problem-center");
    const { vid } = await seedPublishableVersion();
    expect((await publishVersion(vid, "staff:1")).ok).toBe(true);
    const again = await publishVersion(vid, "staff:2");
    expect(again.ok).toBe(false);
    expect(again.error).toContain("已发布");
  });

  it("并发发布同一版本：只有一个成功", async () => {
    const { publishVersion } = await import("@/lib/problem-center");
    const { vid } = await seedPublishableVersion();
    const results = await Promise.all([
      publishVersion(vid, "staff:1"),
      publishVersion(vid, "staff:2"),
      publishVersion(vid, "staff:3"),
    ]);
    expect(results.filter((r) => r.ok).length).toBe(1);
    const v = await ctx.raw("SELECT COUNT(*) n FROM problem_versions WHERE version_id=$1 AND status='published'", [vid]);
    expect(Number(v.rows[0].n)).toBe(1);
  });
});

describe("发布清单加严", () => {
  it("正式需求缺原文引用 → has_source 不通过", async () => {
    const { publicationChecklist } = await import("@/lib/problem-center");
    const { vid } = await seedPublishableVersion({ sourceComplete: false });
    const { items } = await publicationChecklist(vid);
    const src = items.find((i) => i.key === "has_source");
    expect(src?.passed).toBe(false);
  });

  it("人工补充要求（STAFF_ADDED + reviewer + reason）可豁免溯源", async () => {
    const { publicationChecklist } = await import("@/lib/problem-center");
    // 无 page/quote，但标记为工作人员补充且有审核人与理由
    const { vid } = await seedPublishableVersion({ sourceComplete: false, staffAdded: true });
    const { items } = await publicationChecklist(vid);
    const src = items.find((i) => i.key === "has_source");
    expect(src?.passed).toBe(true);
  });

  it("预期总分与官方分值不符 → 核对不通过", async () => {
    const { publicationChecklist } = await import("@/lib/problem-center");
    const { vid } = await seedPublishableVersion({ expectedTotal: 100, officialPoints: 50 });
    const { items } = await publicationChecklist(vid);
    const chk = items.find((i) => i.key === "expected_score_match");
    expect(chk?.passed).toBe(false);
  });

  it("预期总分与官方分值一致 → 核对通过", async () => {
    const { publicationChecklist } = await import("@/lib/problem-center");
    const { vid } = await seedPublishableVersion({ expectedTotal: 50, officialPoints: 50 });
    const { items } = await publicationChecklist(vid);
    const chk = items.find((i) => i.key === "expected_score_match");
    expect(chk?.passed).toBe(true);
  });
});

describe("Worker 心跳与队列报警", () => {
  it("心跳上报后视为活动 Worker", async () => {
    const { workerHeartbeat, queueHealth } = await import("@/lib/task-queue");
    await workerHeartbeat({ workerId: "w1", host: "h", pid: 1, heavySlots: 2, lightSlots: 6, inFlight: 0 });
    const h = await queueHealth();
    expect(h.activeWorkers).toBe(1);
    expect(h.alarms).toEqual([]);
  });

  it("有任务排队但无 Worker → 触发报警", async () => {
    const { queueHealth } = await import("@/lib/task-queue");
    await ctx.raw(
      `INSERT INTO agent_tasks (task_id, owner_ref, agent_type, status, tier, priority, created_at, scheduled_at)
       VALUES ('T1','o','solution_architect','queued','free',5, now(), now())`,
    );
    const h = await queueHealth();
    expect(h.queuedTasks).toBe(1);
    expect(h.alarms.join()).toContain("无活动 Worker");
  });

  it("队列积压超阈值 → 触发积压报警", async () => {
    const { workerHeartbeat, queueHealth } = await import("@/lib/task-queue");
    await workerHeartbeat({ workerId: "w1", host: "h", pid: 1, heavySlots: 2, lightSlots: 6, inFlight: 0 });
    for (let i = 0; i < 12; i++) {
      await ctx.raw(
        `INSERT INTO agent_tasks (task_id, owner_ref, agent_type, status, tier, priority, created_at, scheduled_at)
         VALUES ($1,'o','solution_architect','queued','free',5, now(), now())`,
        [`T-${i}`],
      );
    }
    const h = await queueHealth({ backlogThreshold: 10 });
    expect(h.alarms.join()).toContain("队列积压");
  });

  it("心跳过期 → 计入失联 Worker 并报警", async () => {
    const { queueHealth } = await import("@/lib/task-queue");
    await ctx.raw(
      `INSERT INTO worker_heartbeats (worker_id, host, pid, heavy_slots, light_slots, in_flight, last_beat_at)
       VALUES ('old','h',1,2,6,0, now() - interval '1 hour')`,
    );
    const h = await queueHealth();
    expect(h.staleWorkers).toBe(1);
    expect(h.alarms.join()).toContain("心跳超时");
  });
});

describe("并发压测", () => {
  it("100 个并发任务入队 + 认领：无重复认领、无丢失", async () => {
    const { claimTask } = await import("@/lib/task-queue");
    const N = 100;
    // 入队 100 条
    await Promise.all(Array.from({ length: N }, (_, i) =>
      ctx.raw(
        `INSERT INTO agent_tasks (task_id, owner_ref, project_id, agent_type, status, tier, queue_name, priority, created_at, scheduled_at)
         VALUES ($1,$2,$3,'solution_architect','queued','free','light',5, now(), now())`,
        [`L-${i}`, `owner:${i}`, `PRJ-${i}`],
      ),
    ));

    // 10 个并发 Worker 各认领，直到取空
    const claimed: string[] = [];
    await Promise.all(Array.from({ length: 10 }, async (_, w) => {
      for (;;) {
        const t = await claimTask(`w${w}`, { heavy: false });
        if (!t) break;
        claimed.push(t.task_id);
      }
    }));

    expect(claimed.length).toBe(N);                  // 全部被认领，无丢失
    expect(new Set(claimed).size).toBe(N);           // 无重复认领（SKIP LOCKED 生效）
    const left = await ctx.raw("SELECT COUNT(*) n FROM agent_tasks WHERE status='queued'");
    expect(Number(left.rows[0].n)).toBe(0);
  });

  it("100 并发 ALS 上下文隔离 + 去重键互不串扰", async () => {
    const { withAgentContext, currentAgentContext } = await import("@/lib/agents/base");
    const { modelGateway } = await import("@/lib/model-gateway");
    const keys = await Promise.all(Array.from({ length: 100 }, (_, i) =>
      withAgentContext({ owner: `u${i}`, projectId: `p${i}` }, async () => {
        await new Promise((r) => setTimeout(r, Math.random() * 20));
        const c = currentAgentContext();
        return modelGateway.taskDedupKey({
          ownerRef: c.owner!, projectId: c.projectId!, agentType: "solution_architect",
          tier: "free", inputHash: "same-input",
        });
      }),
    ));
    // 输入完全相同，但 owner/project 不同 → 100 个互不相同的去重键
    expect(new Set(keys).size).toBe(100);
  });
});
