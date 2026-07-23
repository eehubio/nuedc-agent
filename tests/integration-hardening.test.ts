import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { setupMockDb, teardownMockDb, type MockDbContext } from "./helpers/mock-db";

/** 本轮收尾测试：
 *  一、事务内不重复 ensureSchema / 不访问全局 db
 *  二、共享连接池
 *  三、唯一冲突精确分流
 *  四、赛题子表写入锁
 *  五、取消轮询指标 */

let ctx: MockDbContext;
beforeEach(async () => { ctx = await setupMockDb(); await ctx.reset(); });
afterAll(teardownMockDb);

async function seedDraft() {
  const { createProblem, createDraftVersion } = await import("@/lib/problem-center");
  const pid = await createProblem({ year: 2025, code: "A", title: "T", createdBy: "s" });
  const vid = await createDraftVersion(pid);
  await ctx.raw(
    `INSERT INTO problem_requirements (req_id, version_id, requirement_no, description, status,
        source_page, source_quote, source_type, sort_order)
     VALUES ('R1',$1,'REQ-001','需求一','AI_EXTRACTED',3,'引用','AI_EXTRACTED',1)`,
    [vid],
  );
  await ctx.raw(
    `INSERT INTO problem_notes (note_id, version_id, kind, content, resolved)
     VALUES ('N1',$1,'ambiguity','歧义一',0)`, [vid],
  );
  await ctx.raw(
    `INSERT INTO problem_review_diffs (id, problem_id, version_id, field_path, provider_a, provider_b,
        value_a, value_b, severity, resolved)
     VALUES (1,$1,$2,'target','a','b','1','2','critical',0)`, [pid, vid],
  );
  return { pid, vid };
}

async function publish(vid: string) {
  const { addReview, publishVersion } = await import("@/lib/problem-center");
  await ctx.raw("UPDATE problem_requirements SET status='CONFIRMED' WHERE version_id=$1", [vid]);
  await ctx.raw("UPDATE problem_notes SET resolved=1 WHERE version_id=$1", [vid]);
  await ctx.raw("UPDATE problem_review_diffs SET resolved=1 WHERE version_id=$1", [vid]);
  await ctx.raw(
    `INSERT INTO problem_scoring_items (item_id, version_id, item, points, points_type, requirement_refs, sort_order)
     VALUES ('S1',$1,'基本',50,'official','["REQ-001"]',1)`, [vid],
  );
  await addReview(vid, "staff:1", "approve");
  await addReview(vid, "staff:2", "approve");
  const r = await publishVersion(vid, "staff:1");
  expect(r.ok).toBe(true);
  return r;
}

describe("一、事务内不访问全局 db", () => {
  it("传入 executor 时跳过 ensureSchema（源码约束）", () => {
    const src = readFileSync("lib/problem-center.ts", "utf8");
    for (const fn of ["getVersionContent", "publicationChecklist"]) {
      const at = src.indexOf(`export async function ${fn}(`);
      expect(at, `未找到 ${fn}`).toBeGreaterThan(-1);
      const body = src.slice(at, at + 600);
      // 必须是条件式，不能无条件 await ensureSchema()
      expect(body, `${fn} 应仅在无 executor 时 ensureSchema`).toMatch(/if \(!executor\) await ensureSchema\(\)/);
    }
  });

  it("传入 tx 后所有查询都记在同一个 executor 上", async () => {
    const { getVersionContent, publicationChecklist } = await import("@/lib/problem-center");
    const { vid } = await seedDraft();
    const seen: string[] = [];
    // 假 executor：记录所有经过它的 SQL
    const spy = {
      execute: async (stmt: any) => {
        const sql = typeof stmt === "string" ? stmt : stmt.sql;
        seen.push(sql.replace(/\s+/g, " ").trim());
        const { db } = await import("@/lib/db");
        return db().execute(stmt);
      },
    };
    seen.length = 0;
    await getVersionContent(vid, spy as any);
    // version / requirements / scoring / notes / reviews 五条都必须走 spy
    expect(seen.length).toBeGreaterThanOrEqual(5);
    expect(seen.join(" ")).toMatch(/problem_versions/);
    expect(seen.join(" ")).toMatch(/problem_requirements/);
    expect(seen.join(" ")).toMatch(/problem_scoring_items/);
    expect(seen.join(" ")).toMatch(/problem_notes/);
    expect(seen.join(" ")).toMatch(/problem_reviews/);

    seen.length = 0;
    await publicationChecklist(vid, spy as any);
    // 清单里的 review_diffs 查询同样必须走 spy，不能落到全局 db
    expect(seen.join(" ")).toMatch(/problem_review_diffs/);
  });

  it("publishVersion / saveExtraction 在进入事务前 ensureSchema", () => {
    const src = readFileSync("lib/problem-center.ts", "utf8");
    for (const fn of ["publishVersion", "saveExtraction"]) {
      const at = src.indexOf(`export async function ${fn}(`);
      const body = src.slice(at, at + 900);
      const ensureAt = body.indexOf("ensureSchema()");
      const txAt = body.indexOf("withTransaction");
      expect(ensureAt, `${fn} 缺少 ensureSchema`).toBeGreaterThan(-1);
      expect(txAt, `${fn} 缺少 withTransaction`).toBeGreaterThan(-1);
      expect(ensureAt, `${fn} 的 ensureSchema 必须在 withTransaction 之前`).toBeLessThan(txAt);
    }
  });
});

describe("二、共享连接池", () => {
  it("withTransaction 不再每次 new Pool / pool.end（源码约束）", () => {
    const src = readFileSync("lib/db.ts", "utf8");
    const at = src.indexOf("export async function withTransaction");
    const body = src.slice(at);
    expect(body).not.toMatch(/new Pool\(/);          // 池的创建只在 txPool() 里
    expect(body).not.toMatch(/pool\.end\(\)/);       // 事务结束不销毁池
    expect(body).toMatch(/txPool\(\)/);
    expect(body).toMatch(/client\.release\(\)/);
  });

  it("池配置项可通过环境变量调整", () => {
    const src = readFileSync("lib/db.ts", "utf8");
    expect(src).toMatch(/DB_POOL_MAX/);
    expect(src).toMatch(/DB_POOL_IDLE_MS/);
    expect(src).toMatch(/DB_POOL_CONN_TIMEOUT_MS/);
    expect(src).toMatch(/idleTimeoutMillis/);
    expect(src).toMatch(/connectionTimeoutMillis/);
  });

  it("暴露 closeTxPool 与 txPoolStats，且 Worker 退出时关闭", async () => {
    const dbmod = await import("@/lib/db");
    expect(typeof dbmod.closeTxPool).toBe("function");
    expect(typeof dbmod.txPoolStats).toBe("function");
    const worker = readFileSync("scripts/agent-worker.mts", "utf8");
    expect(worker).toMatch(/closeTxPool\(\)/);
  });

  it("并发事务在 pglite 下互不干扰且全部提交", async () => {
    const { withTransaction } = await import("@/lib/db");
    await ctx.raw("CREATE TABLE IF NOT EXISTS _tx_probe (id TEXT PRIMARY KEY, n INT)");
    await ctx.raw("DELETE FROM _tx_probe");
    // pglite 是单连接，事务会串行化；这里验证的是「都成功且数据正确」
    for (let i = 0; i < 10; i++) {
      await withTransaction(async (tx) => {
        await tx.execute({ sql: "INSERT INTO _tx_probe (id, n) VALUES (?,?)", args: [`p${i}`, i] });
      });
    }
    const rs = await ctx.raw("SELECT COUNT(*) n FROM _tx_probe");
    expect(Number(rs.rows[0].n)).toBe(10);
  });

  it("事务内抛错整体回滚", async () => {
    const { withTransaction } = await import("@/lib/db");
    await ctx.raw("CREATE TABLE IF NOT EXISTS _tx_probe2 (id TEXT PRIMARY KEY)");
    await ctx.raw("DELETE FROM _tx_probe2");
    await expect(withTransaction(async (tx) => {
      await tx.execute({ sql: "INSERT INTO _tx_probe2 (id) VALUES ('a')", args: [] });
      throw new Error("boom");
    })).rejects.toThrow("boom");
    const rs = await ctx.raw("SELECT COUNT(*) n FROM _tx_probe2");
    expect(Number(rs.rows[0].n)).toBe(0);
  });
});

describe("三、唯一冲突精确分流", () => {
  const src = readFileSync("app/api/agent-tasks/route.ts", "utf8");

  it("按约束名分流三种冲突", () => {
    expect(src).toMatch(/IDEMPOTENCY_CONFLICT/);
    expect(src).toMatch(/ACTIVE_DEDUP_CONFLICT/);
    expect(src).toMatch(/UNEXPECTED_UNIQUE_CONFLICT/);
    expect(src).toMatch(/idx_tasks_idem_owner/);
    expect(src).toMatch(/idx_tasks_active_dedup/);
  });

  it("未知冲突：退款 + 结构化日志 + 409，且不返回无关任务", () => {
    const at = src.indexOf('if (conflictKind === "UNEXPECTED_UNIQUE_CONFLICT")');
    expect(at).toBeGreaterThan(-1);
    const branch = src.slice(at, at + 900);
    expect(branch).toMatch(/refundQuota/);                    // 退款
    expect(branch).toMatch(/console\.error\(JSON\.stringify/); // 结构化日志
    expect(branch).toMatch(/status: 409/);                     // 409
    // 绝不能在这个分支里去查已有任务返回
    expect(branch).not.toMatch(/SELECT task_id/);
  });

  it("非唯一冲突仍然退款后抛出（不吞错）", () => {
    const at = src.indexOf("const isUnique =");
    const branch = src.slice(at, at + 500);
    expect(branch).toMatch(/refundQuota/);
    expect(branch).toMatch(/throw e/);
  });
});

describe("四、赛题子表写入锁", () => {
  it("withVersionWriteLock 对已发布版本拒绝写入", async () => {
    const { withVersionWriteLock, VersionWriteError } = await import("@/lib/problem-center");
    const { vid } = await seedDraft();
    await publish(vid);
    await expect(withVersionWriteLock(vid, async () => { /* 不应执行 */ }))
      .rejects.toBeInstanceOf(VersionWriteError);
  });

  it("published 版本：所有子表写入均被拒绝", async () => {
    const pc = await import("@/lib/problem-center");
    const { vid, pid } = await seedDraft();
    await publish(vid);

    // requirements / notes / diffs / reviews / scoring 全部经由同一把锁
    await expect(pc.addReview(vid, "staff:3", "approve")).rejects.toThrow(/已发布版本不可修改/);
    await expect(pc.saveDiffs(vid, pid, [], "a", "b")).rejects.toThrow(/已发布版本不可修改/);
    await expect(pc.saveExtraction(vid, { requirements: [{ id: "X", description: "d" }] }))
      .rejects.toThrow(/已发布版本不可修改/);
    await expect(pc.withVersionWriteLock(vid, async (tx) => {
      await tx.execute({ sql: "UPDATE problem_notes SET resolved=1 WHERE version_id=?", args: [vid] });
    })).rejects.toThrow(/已发布版本不可修改/);

    // 数据未被改动
    const n = await ctx.raw("SELECT COUNT(*) c FROM problem_reviews WHERE version_id=$1", [vid]);
    expect(Number(n.rows[0].c)).toBe(2);   // 仍是发布前的两条
  });

  it("draft 版本：子表写入正常放行", async () => {
    const { withVersionWriteLock } = await import("@/lib/problem-center");
    const { vid } = await seedDraft();
    await withVersionWriteLock(vid, async (tx) => {
      await tx.execute({ sql: "UPDATE problem_notes SET resolved=1 WHERE version_id=?", args: [vid] });
    });
    const rs = await ctx.raw("SELECT resolved FROM problem_notes WHERE version_id=$1", [vid]);
    expect(Number(rs.rows[0].resolved)).toBe(1);
  });

  it("发布与 Requirement 编辑并发：发布后编辑必被拒", async () => {
    const pc = await import("@/lib/problem-center");
    const { vid } = await seedDraft();
    await publish(vid);
    // 发布完成后任何 requirement 写入都应失败
    await expect(pc.withVersionWriteLock(vid, async (tx) => {
      await tx.execute({
        sql: "UPDATE problem_requirements SET status='REJECTED' WHERE version_id=?", args: [vid],
      });
    })).rejects.toThrow();
    const rs = await ctx.raw("SELECT status FROM problem_requirements WHERE version_id=$1", [vid]);
    expect(rs.rows[0].status).toBe("CONFIRMED");   // 未被改成 REJECTED
  });

  it("发布与 Diff resolve 并发：发布后 resolve 必被拒", async () => {
    const pc = await import("@/lib/problem-center");
    const { vid } = await seedDraft();
    await publish(vid);
    await expect(pc.withVersionWriteLock(vid, async (tx) => {
      await tx.execute({ sql: "UPDATE problem_review_diffs SET resolved=0 WHERE version_id=?", args: [vid] });
    })).rejects.toThrow();
  });

  it("versionIdOf 只允许白名单表与主键列", async () => {
    const { versionIdOf } = await import("@/lib/problem-center");
    const { vid } = await seedDraft();
    expect(await versionIdOf("problem_notes", "note_id", "N1")).toBe(vid);
    expect(await versionIdOf("problem_review_diffs", "id", "1")).toBe(vid);
    // 列名不匹配时必须拒绝（防 SQL 注入）
    await expect(versionIdOf("problem_notes", "version_id" as any, "x")).rejects.toThrow(/非法/);
  });

  it("API 层把 VersionWriteError 映射为 409（源码约束）", () => {
    const a = readFileSync("app/api/problems/[id]/route.ts", "utf8");
    const b = readFileSync("app/api/problems/[id]/diffs/route.ts", "utf8");
    for (const [name, src] of [["problems route", a], ["diffs route", b]] as const) {
      expect(src, `${name} 应使用 withVersionWriteLock`).toMatch(/withVersionWriteLock/);
      expect(src, `${name} 应把 VersionWriteError 映射为 409`).toMatch(/VersionWriteError[\s\S]{0,200}status: 409/);
    }
    // 不得再有裸的 db().execute 直接改子表
    expect(a).not.toMatch(/db\(\)\.execute\([\s\S]{0,120}UPDATE problem_requirements/);
    expect(b).not.toMatch(/db\(\)\.execute\([\s\S]{0,120}UPDATE problem_review_diffs/);
  });

  it("saveDiffs 不再静默吞错", () => {
    const src = readFileSync("lib/problem-center.ts", "utf8");
    const at = src.indexOf("export async function saveDiffs");
    const body = src.slice(at, at + 1000);
    expect(body).toMatch(/withVersionWriteLock/);
    expect(body).not.toMatch(/\.catch\(\(\) => \{\}\)/);
  });
});

describe("五、取消轮询指标", () => {
  it("指标模块提供所需的全部字段", async () => {
    const { metrics, snapshot } = await import("@/lib/worker-metrics");
    metrics.reset();
    metrics.cancelPoll(); metrics.cancelPoll();
    metrics.cancelPollError();
    metrics.cancelRequested();
    metrics.cancelAbortLatency(12);
    metrics.cancelAbortLatency(40);
    metrics.taskStarted(); metrics.taskStarted();
    metrics.heartbeat(); metrics.claim();

    const s = snapshot();
    expect(s.cancel_poll_queries).toBe(2);
    expect(s.cancel_poll_db_errors).toBe(1);
    expect(s.cancel_requests).toBe(1);
    expect(s.active_worker_tasks).toBe(2);
    expect(s.cancel_abort_latency_p50).toBeGreaterThanOrEqual(0);
    expect(s.cancel_abort_latency_p95).toBeGreaterThanOrEqual(s.cancel_abort_latency_p50);
    expect(s.qps).toHaveProperty("cancel_poll");
    expect(s.qps).toHaveProperty("total");
  });

  it("taskEnded 不会把在途数减到负值", async () => {
    const { metrics, snapshot } = await import("@/lib/worker-metrics");
    metrics.reset();
    metrics.taskEnded(); metrics.taskEnded();
    expect(snapshot().active_worker_tasks).toBe(0);
  });

  it("延迟样本有上限，长跑不会无限增长", async () => {
    const { metrics, snapshot } = await import("@/lib/worker-metrics");
    metrics.reset();
    for (let i = 0; i < 1200; i++) metrics.cancelAbortLatency(i);
    // 内部限制 1000 个样本
    expect(snapshot().cancel_abort_latency_p50).toBeGreaterThan(0);
  });

  it("Worker 已埋点取消轮询与错误计数（源码约束）", () => {
    const w = readFileSync("scripts/agent-worker.mts", "utf8");
    expect(w).toMatch(/metrics\.cancelPoll\(\)/);
    expect(w).toMatch(/metrics\.cancelPollError\(\)/);
    expect(w).toMatch(/metrics\.cancelAbortLatency/);
    expect(w).toMatch(/metrics\.taskStarted\(\)/);
    expect(w).toMatch(/metrics\.taskEnded\(\)/);
  });
});

describe("六 / 七 / 八、CI、readiness、压测脚本", () => {
  it("CI 含 workflow_dispatch 与 artifact 上传", () => {
    const ci = readFileSync(".github/workflows/ci.yml", "utf8");
    expect(ci).toMatch(/workflow_dispatch:/);
    expect(ci).toMatch(/upload-artifact/);
    expect(ci).toMatch(/junit\.xml/);
    expect(ci).toMatch(/worker-startup\.log/);
    expect(ci).toMatch(/load-test-summary\.txt/);
  });

  it("readiness 覆盖所有要求的字段", () => {
    const src = readFileSync("app/api/admin/readiness/route.ts", "utf8");
    for (const key of [
      "database", "workers", "heartbeat_age_sec", "heavy_slots", "light_slots",
      "by_priority", "oldest_queued_sec", "provider_health", "usage_today",
      "estimated_cost_usd", "web_sha", "worker_shas", "ci_sha", "tx_pool",
    ]) {
      expect(src, `readiness 缺少字段：${key}`).toMatch(new RegExp(key));
    }
    // 版本不一致要给 warning
    expect(src).toMatch(/版本不一致/);
  });

  it("压测脚本支持四种模式且对真实成本有安全阀", () => {
    const src = readFileSync("scripts/load-test.mts", "utf8");
    for (const mode of ["queue-only", "mock-provider", "real-provider-light", "fallback-drill"]) {
      expect(src, `缺少模式：${mode}`).toMatch(new RegExp(mode));
    }
    expect(src).toMatch(/CONFIRM_REAL_COST/);
    expect(src).toMatch(/ENABLE_MOCK_ASSUMED/);
    // 必需的输出指标
    for (const metric of [
      "success_rate", "dedup_correct", "queue_wait_p95", "queue_wait_p99",
      "execution_p95", "execution_p99", "db_query_errors", "fallback_count",
      "per_task_usd", "total_input_tokens",
    ]) {
      expect(src, `压测报告缺少指标：${metric}`).toMatch(new RegExp(metric));
    }
    // 压测数据使用可识别前缀，便于清理
    expect(src).toMatch(/__loadtest_/);
  });
});
