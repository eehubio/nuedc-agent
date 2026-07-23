import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { setupMockDb, teardownMockDb, type MockDbContext } from "./helpers/mock-db";

/** 本轮修复验证：
 *  一、发布门禁 fail closed（数据库故障不得伪装成检查通过）
 *  二、createDraftVersion 只重试真正的版本号冲突
 *  三、readiness 区分 error 与 warning
 *  四、CI 关键冒烟真正阻断 */

let ctx: MockDbContext;
beforeEach(async () => { ctx = await setupMockDb(); await ctx.reset(); });
afterAll(teardownMockDb);

async function seedPublishable() {
  const { createProblem, createDraftVersion, addReview } = await import("@/lib/problem-center");
  const pid = await createProblem({ year: 2025, code: "A", title: "T", createdBy: "s" });
  const vid = await createDraftVersion(pid);
  await ctx.raw(
    `INSERT INTO problem_requirements (req_id, version_id, requirement_no, description, status,
        source_page, source_quote, source_type, sort_order)
     VALUES ('R1',$1,'REQ-001','需求一','CONFIRMED',3,'引用','AI_EXTRACTED',1)`, [vid],
  );
  await ctx.raw(
    `INSERT INTO problem_scoring_items (item_id, version_id, item, points, points_type, requirement_refs, sort_order)
     VALUES ('S1',$1,'基本',50,'official','["REQ-001"]',1)`, [vid],
  );
  await addReview(vid, "staff:1", "approve");
  await addReview(vid, "staff:2", "approve");
  return { pid, vid };
}

describe("一、发布门禁 fail closed", () => {
  it("problem_review_diffs 查询失败 → publicationChecklist 抛错，不返回 passed", async () => {
    const { publicationChecklist, PublicationCheckError } = await import("@/lib/problem-center");
    const { vid } = await seedPublishable();
    ctx.failOn({ match: /problem_review_diffs/i, nth: 1, message: "注入：差异查询失败" });
    await expect(publicationChecklist(vid)).rejects.toBeInstanceOf(PublicationCheckError);
    ctx.failOn(null);
  });

  it("差异查询失败 → publishVersion 回滚且返回 PUBLICATION_CHECK_FAILED", async () => {
    const { publishVersion } = await import("@/lib/problem-center");
    const { vid, pid } = await seedPublishable();

    ctx.failOn({ match: /problem_review_diffs/i, nth: 1, message: "注入：差异查询失败" });
    const r = await publishVersion(vid, "staff:1");
    ctx.failOn(null);

    expect(r.ok).toBe(false);
    expect(r.error_code).toBe("PUBLICATION_CHECK_FAILED");

    // 版本必须仍是 draft / immutable=0 / 无 hash
    const v = await ctx.raw("SELECT status, immutable, content_hash FROM problem_versions WHERE version_id=$1", [vid]);
    expect(v.rows[0].status).not.toBe("published");
    expect(Number(v.rows[0].immutable || 0)).toBe(0);
    expect(v.rows[0].content_hash).toBeNull();

    // official_problems 不得变为 published
    const p = await ctx.raw("SELECT status FROM official_problems WHERE problem_id=$1", [pid]);
    expect(p.rows[0].status).not.toBe("published");
  });

  it("版本内容读取失败同样 fail closed", async () => {
    const { publicationChecklist, PublicationCheckError } = await import("@/lib/problem-center");
    const { vid } = await seedPublishable();
    ctx.failOn({ match: /FROM problem_requirements WHERE version_id/i, nth: 1, message: "注入：内容读取失败" });
    await expect(publicationChecklist(vid)).rejects.toBeInstanceOf(PublicationCheckError);
    ctx.failOn(null);
  });

  it("源码中不得再有把门禁查询默认为通过的 catch", () => {
    const src = readFileSync("lib/problem-center.ts", "utf8");
    // 旧写法：查询失败默认 n=0，等于「无关键差异」
    expect(src).not.toMatch(/catch\(\(\) => \(\{ rows: \[\{ n: 0 \}\]/);
    expect(src).toContain("PublicationCheckError");
  });

  it("门禁正常时仍可发布（fail closed 不影响正常路径）", async () => {
    const { publishVersion } = await import("@/lib/problem-center");
    const { vid } = await seedPublishable();
    const r = await publishVersion(vid, "staff:1");
    expect(r.ok).toBe(true);
  });
});

describe("二、createDraftVersion 重试分类", () => {
  it("非版本号冲突的错误立即抛出，不被伪装成并发冲突", async () => {
    const { createProblem, createDraftVersion } = await import("@/lib/problem-center");
    const pid = await createProblem({ year: 2025, code: "B", title: "T", createdBy: "s" });
    // 注入一个「数据库不可用」类错误：必须原样抛出，而不是重试 25 次后说"版本号冲突"
    ctx.failOn({ match: /INSERT INTO problem_versions/i, nth: 1, message: "connection terminated unexpectedly" });
    await expect(createDraftVersion(pid)).rejects.toThrow(/connection terminated/);
    ctx.failOn(null);
  });

  it("错误信息不得被替换为版本号冲突", async () => {
    const { createProblem, createDraftVersion } = await import("@/lib/problem-center");
    const pid = await createProblem({ year: 2025, code: "C", title: "T", createdBy: "s" });
    ctx.failOn({ match: /INSERT INTO problem_versions/i, nth: 1, message: "permission denied for table" });
    const err = await createDraftVersion(pid).then(() => null, (e) => e);
    ctx.failOn(null);
    expect(err).toBeTruthy();
    expect(String(err.message)).toMatch(/permission denied/);
    // 关键：不得被替换成"版本号并发冲突"这种误导性结论
    expect(String(err.message)).not.toMatch(/版本号并发冲突/);
  });

  it("isVersionNoConflict 判定逻辑（源码约束）", () => {
    const src = readFileSync("lib/problem-center.ts", "utf8");
    expect(src).toContain("function isVersionNoConflict");
    const at = src.indexOf("function isVersionNoConflict");
    const body = src.slice(at, at + 500);
    expect(body).toMatch(/23505/);                 // 必须是 unique_violation
    expect(body).toMatch(/problem_versions/);      // 且约束指向 problem_versions
    expect(body).toMatch(/version_no/);            // 的 version_no
    // catch 里必须重新抛出非冲突错误
    const cd = src.slice(src.indexOf("export async function createDraftVersion"), src.indexOf("function isVersionNoConflict"));
    expect(cd).toMatch(/if \(!isVersionNoConflict\(e\)\) throw e/);
  });

  it("正常并发仍然可用（8 并发版本号唯一且连续）", async () => {
    const { createProblem, createDraftVersion } = await import("@/lib/problem-center");
    const pid = await createProblem({ year: 2025, code: "D", title: "T", createdBy: "s" });
    const ids = await Promise.all(Array.from({ length: 8 }, () => createDraftVersion(pid)));
    expect(new Set(ids).size).toBe(8);
    const rs = await ctx.raw("SELECT version_no FROM problem_versions WHERE problem_id=$1 ORDER BY version_no", [pid]);
    expect(rs.rows.map((r: any) => Number(r.version_no))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

describe("三、readiness 区分 error 与 warning", () => {
  const src = readFileSync("app/api/admin/readiness/route.ts", "utf8");

  it("返回结构包含 errors 与 warnings，ready 只由 errors 决定", () => {
    expect(src).toMatch(/const errors: string\[\] = \[\]/);
    expect(src).toMatch(/ready: errors\.length === 0/);
    expect(src).toMatch(/errors,/);
    expect(src).toMatch(/warnings,/);
  });

  it("阻断项归入 errors", () => {
    expect(src).toMatch(/errors\.push\("数据库不可达"\)/);
    expect(src).toMatch(/errors\.push\("没有存活的 Worker/);
    expect(src).toMatch(/errors\.push\(`最老任务已排队/);
    expect(src).toMatch(/errors\.push\("所有 Provider 均不可用/);
  });

  it("非阻断项归入 warnings", () => {
    // 有 live worker 时的 stale 只是 warning
    expect(src).toMatch(/if \(liveWorkers\.length > 0\) warnings\.push\(msg\)/);
    // SHA 不一致、接近阈值、备用 Provider 不健康
    expect(src).toMatch(/warnings\.push\(`Web 与 Worker 版本不一致/);
    expect(src).toMatch(/warnings\.push\(`队列接近告警阈值/);
    expect(src).toMatch(/warnings\.push\(`备用 Provider 不健康/);
  });

  it("提供 24 小时僵尸心跳清理并接入 Worker", async () => {
    const { pruneStaleHeartbeats } = await import("@/lib/task-queue");
    expect(typeof pruneStaleHeartbeats).toBe("function");
    // 造一条 30 小时前的心跳与一条新的
    await ctx.raw(
      `INSERT INTO worker_heartbeats (worker_id, host, pid, heavy_slots, light_slots, in_flight, last_beat_at)
       VALUES ('zombie','h',1,2,6,0, now() - interval '30 hours'), ('alive','h',2,2,6,0, now())`,
    );
    const pruned = await pruneStaleHeartbeats(24);
    expect(pruned).toBe(1);
    const rs = await ctx.raw("SELECT worker_id FROM worker_heartbeats ORDER BY worker_id");
    expect(rs.rows.map((r: any) => r.worker_id)).toEqual(["alive"]);

    const worker = readFileSync("scripts/agent-worker.mts", "utf8");
    expect(worker).toMatch(/pruneStaleHeartbeats\(24\)/);
  });
});

describe("四、CI 关键冒烟真正阻断", () => {
  const ci = readFileSync(".github/workflows/ci.yml", "utf8");

  it("Worker startup 与 queue smoke 的关键命令不再吞掉失败", () => {
    const smoke = ci.slice(ci.indexOf("Worker startup smoke"), ci.indexOf("- name: Stop server"));
    expect(smoke).toMatch(/set -o pipefail/);
    // 关键命令（压测、验收、迁移、构建）不得带 || true
    for (const cmd of [
      "npx tsx scripts/load-test.mts",
      "node scripts/assert-load-result.mjs",
      "npm run db:init",
      "npx vitest run tests/worker-startup.test.ts",
    ]) {
      const at = smoke.indexOf(cmd);
      expect(at, `缺少关键命令：${cmd}`).toBeGreaterThan(-1);
      const line = smoke.slice(at, smoke.indexOf("\n", at));
      expect(line, `${cmd} 不得吞掉失败`).not.toMatch(/\|\| true/);
    }
    // 健康检查失败必须 exit 1，而不是继续跑压测
    expect(smoke).toMatch(/exit 1/);
  });

  it("服务清理与日志上传不因失败中断（清理步骤允许 || true）", () => {
    const stop = ci.slice(ci.indexOf("- name: Stop server"), ci.indexOf("- name: Build"));
    expect(stop).toMatch(/if: always\(\)/);
    // 清理本身失败不应让 job 红灯
    expect(stop).toMatch(/\|\| true/);
  });

  it("queue-only 结果经过验收门禁", () => {
    expect(ci).toMatch(/assert-load-result\.mjs/);
  });

  it("验收脚本检查四项功能指标", () => {
    const src = readFileSync("scripts/assert-load-result.mjs", "utf8");
    expect(src).toMatch(/HTTP 错误/);
    expect(src).toMatch(/DB 查询错误/);
    expect(src).toMatch(/去重错误/);
    expect(src).toMatch(/配额泄漏/);
    // 性能数字不卡 CI
    expect(src).toMatch(/仅参考，不卡 CI/);
    expect(src).toMatch(/process\.exit\(1\)/);
  });

  it("Artifact 仍然上传", () => {
    expect(ci).toMatch(/upload-artifact/);
    expect(ci).toMatch(/junit\.xml/);
    expect(ci).toMatch(/worker-startup\.log/);
    expect(ci).toMatch(/load-test-summary\.txt/);
  });
});
