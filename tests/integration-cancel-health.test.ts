import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { setupMockDb, teardownMockDb, type MockDbContext } from "./helpers/mock-db";

/** Commit 2 集成测试：
 *  - 任务重量显式声明（不由 token 推断）
 *  - 真正取消：AbortSignal 中断 Provider 调用
 *  - Provider 分任务质量健康：schema 长期失败 → 停止承担该 TaskType */

let ctx: MockDbContext;
beforeEach(async () => { ctx = await setupMockDb(); await ctx.reset(); });
afterAll(teardownMockDb);

describe("任务重量显式声明", () => {
  it("每个 TaskType 的 concurrency/cost 与 maxOutputTokens 解耦", async () => {
    const { TASK_POLICIES } = await import("@/lib/model-gateway/task-policy");
    const heavy = ["PDF_EXTRACT", "PROBLEM_STRUCTURE", "SCORING_EXTRACT", "SOLUTION_PRIMARY",
      "SOLUTION_FALLBACK", "CODE_GENERATE", "CODE_REPAIR", "REPORT_SECTION"];
    const light = ["BOM_NORMALIZE", "MODULE_GAP_ANALYSIS", "BUILD_LOG_EXPLAIN", "TEST_ANALYSIS",
      "REPORT_POLISH", "GENERAL_QA"];
    for (const t of heavy) expect(TASK_POLICIES[t as keyof typeof TASK_POLICIES].concurrencyClass).toBe("heavy");
    for (const t of light) expect(TASK_POLICIES[t as keyof typeof TASK_POLICIES].concurrencyClass).toBe("light");
  });

  it("costClass 显式，不再由 token 阈值隐式决定", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("lib/model-gateway/task-policy.ts", "utf8");
    // 旧实现的 token 阈值推断必须已删除
    expect(src).not.toContain("maxOutputTokens > 3000 ? \"heavy\"");
    expect(src).not.toContain("maxOutputTokens > 3000 ? \"high\"");
    // 显式声明存在
    expect(src).toContain("concurrencyClass: weight.concurrencyClass");
    expect(src).toContain("costClass: weight.costClass");
  });

  it("REPORT_SECTION 提到 heavy 且不因 token=2500 被判 light", async () => {
    const { policyFor } = await import("@/lib/model-gateway/task-policy");
    const p = policyFor("REPORT_SECTION");
    expect(p.concurrencyClass).toBe("heavy");   // 显式，即便 token 只有 2500
    expect(p.maxOutputTokens).toBeLessThan(3000);
  });
});

describe("真正取消 Provider 请求", () => {
  it("已 abort 的信号 → mock provider 立即抛 CANCELED", async () => {
    process.env.ENABLE_MOCK_PROVIDER = "1";
    process.env.MOCK_LATENCY_MS = "3000";
    const { mockProvider } = await import("@/lib/model-gateway/providers/mock");
    const ctl = new AbortController();
    ctl.abort();
    await expect(
      mockProvider.complete({
        system: "s", messages: [{ role: "user", content: "hi" }],
        maxOutputTokens: 100, temperature: 0.3, json: true, timeoutMs: 5000, signal: ctl.signal,
      } as any, "mock-model"),
    ).rejects.toMatchObject({ code: "CANCELED" });
  });

  it("执行中途 abort → 在延迟结束前中断（不等满 3 秒）", async () => {
    process.env.ENABLE_MOCK_PROVIDER = "1";
    process.env.MOCK_LATENCY_MS = "3000";
    const { mockProvider } = await import("@/lib/model-gateway/providers/mock");
    const ctl = new AbortController();
    const t0 = Date.now();
    const p = mockProvider.complete({
      system: "s", messages: [{ role: "user", content: "hi" }],
      maxOutputTokens: 100, temperature: 0.3, json: true, timeoutMs: 5000, signal: ctl.signal,
    } as any, "mock-model");
    setTimeout(() => ctl.abort(), 100);
    await expect(p).rejects.toMatchObject({ code: "CANCELED" });
    expect(Date.now() - t0).toBeLessThan(1500);   // 远小于 3000ms，说明真的中断了
  });

  it("gateway 收到已取消信号 → 返回 errorCode=CANCELED，不发起调用", async () => {
    process.env.ENABLE_MOCK_PROVIDER = "1";
    const { modelGateway } = await import("@/lib/model-gateway");
    const ctl = new AbortController();
    ctl.abort();
    const r = await modelGateway.run({
      taskType: "GENERAL_QA", system: "s", messages: [{ role: "user", content: "hi" }],
      caller: "system", signal: ctl.signal, allowCache: false,
    });
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe("CANCELED");
  });

  it("取消任务：已用 token 计费、配额退款（completeTask canceled 路径）", async () => {
    const { completeTask } = await import("@/lib/task-queue");
    const { reserveQuota } = await import("@/lib/usage");
    const { reservation } = await reserveQuota("owner:A", "heavy_task", "free");
    // 建一条 running 任务并绑定配额
    await ctx.raw(
      `INSERT INTO agent_tasks (task_id, owner_ref, agent_type, status, worker_id, tier, quota_ref, quota_kind, priority, scheduled_at)
       VALUES ('T-C','owner:A','solution_architect','running','w1','free',$1,'heavy_task',5, now())`,
      [reservation!.ref],
    );
    // 模拟已经产生了一些 token 用量
    await ctx.raw(
      `INSERT INTO llm_usage_events (owner, task_id, task_type, provider, model, input_tokens, output_tokens, estimated_cost, latency_ms, status)
       VALUES ('owner:A','T-C','SOLUTION_PRIMARY','mock','mock-model',1000,200,0.01,100,'success')`,
    );
    await completeTask({ taskId: "T-C", workerId: "w1", ok: false, canceled: true, result: null, errorCode: "CANCELED" });

    const t = await ctx.raw("SELECT status, token_input, token_output FROM agent_tasks WHERE task_id='T-C'");
    expect(t.rows[0].status).toBe("canceled");
    expect(Number(t.rows[0].token_input)).toBe(1000);    // 已用 token 记录费用
    // 配额退款
    const q = await ctx.raw("SELECT used FROM quota_counters WHERE owner='owner:A' AND kind='heavy_task' AND day=CURRENT_DATE");
    expect(Number(q.rows[0].used)).toBe(0);
    const u = await ctx.raw("SELECT status FROM llm_usage WHERE ref=$1", [reservation!.ref]);
    expect(u.rows[0].status).toBe("refunded");
  });
});

describe("Provider 分任务质量健康", () => {
  it("schema 长期失败 → taskTypeHealthy=false（即便 transport 全 200）", async () => {
    const { recordTaskCall, taskTypeHealthy, taskHealth } = await import("@/lib/model-gateway/task-health");
    // 传输全部成功，但 schema 大量失败
    for (let i = 0; i < 12; i++) {
      await recordTaskCall({ provider: "badp", model: "m", taskType: "SOLUTION_PRIMARY", dimension: "transport", ok: true });
      await recordTaskCall({ provider: "badp", model: "m", taskType: "SOLUTION_PRIMARY", dimension: "schema", ok: false });
    }
    const h = await taskHealth("badp", "m", "SOLUTION_PRIMARY");
    expect(h.transportRate).toBe(1);       // HTTP 一直 200
    expect(h.schemaRate).toBeLessThan(0.5);
    expect(await taskTypeHealthy("badp", "m", "SOLUTION_PRIMARY")).toBe(false);
  });

  it("样本不足时不下结论（healthy=true）", async () => {
    const { recordTaskCall, taskTypeHealthy } = await import("@/lib/model-gateway/task-health");
    await recordTaskCall({ provider: "newp", model: "m", taskType: "GENERAL_QA", dimension: "schema", ok: false });
    expect(await taskTypeHealthy("newp", "m", "GENERAL_QA")).toBe(true);
  });

  it("健康 Provider → taskTypeHealthy=true", async () => {
    const { recordTaskCall, taskTypeHealthy } = await import("@/lib/model-gateway/task-health");
    for (let i = 0; i < 12; i++) {
      await recordTaskCall({ provider: "goodp", model: "m", taskType: "BOM_NORMALIZE", dimension: "transport", ok: true });
      await recordTaskCall({ provider: "goodp", model: "m", taskType: "BOM_NORMALIZE", dimension: "schema", ok: true });
    }
    expect(await taskTypeHealthy("goodp", "m", "BOM_NORMALIZE")).toBe(true);
  });

  it("timeout / 429 维度分别计数", async () => {
    const { recordTaskCall, taskHealth } = await import("@/lib/model-gateway/task-health");
    for (let i = 0; i < 10; i++) await recordTaskCall({ provider: "p", model: "m", taskType: "CODE_GENERATE", dimension: "transport", ok: false });
    for (let i = 0; i < 4; i++) await recordTaskCall({ provider: "p", model: "m", taskType: "CODE_GENERATE", dimension: "timeout" });
    for (let i = 0; i < 3; i++) await recordTaskCall({ provider: "p", model: "m", taskType: "CODE_GENERATE", dimension: "rate429" });
    const h = await taskHealth("p", "m", "CODE_GENERATE");
    expect(h.timeoutRate).toBeGreaterThan(0);
    expect(h.rate429).toBeGreaterThan(0);
  });
});
