import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { setupMockDb, teardownMockDb, type MockDbContext } from "./helpers/mock-db";

/** Commit 2 集成测试：
 *  四、CANCELED 错误码
 *  五、取消轮询与租约心跳分离
 *  六、agent_runs 状态不再恒为 ok
 *  八、CI 配置可实际触发 */

let ctx: MockDbContext;
beforeEach(async () => { ctx = await setupMockDb(); await ctx.reset(); });
afterAll(teardownMockDb);

describe("四、CANCELED 错误码", () => {
  it("classifyAgentError 识别各种取消形态", async () => {
    const { classifyAgentError } = await import("@/lib/agents/base");
    for (const s of ["AbortError", "ABORTED", "CANCELED", "CANCELLED", "The operation was aborted",
                     "用户取消", "请求已取消"]) {
      expect(classifyAgentError(s), `未识别为 CANCELED: ${s}`).toBe("CANCELED");
    }
  });

  it("CANCELED 不可重试", async () => {
    const { isRetryable } = await import("@/lib/agents/base");
    expect(isRetryable("CANCELED")).toBe(false);
  });

  it("AbortSignal 触发时归一化为 CANCELED 而非 UNKNOWN", async () => {
    const { normalizeProviderError } = await import("@/lib/model-gateway/providers/base");
    const ctl = new AbortController();
    ctl.abort();
    // 普通 Error + 已 abort 的信号
    expect(normalizeProviderError(new Error("socket closed"), ctl.signal).code).toBe("CANCELED");
    // DOMException AbortError（无信号也能识别）
    const abortErr: any = new Error("The operation was aborted");
    abortErr.name = "AbortError";
    expect(normalizeProviderError(abortErr).code).toBe("CANCELED");
    // 非取消错误仍是 UNKNOWN
    expect(normalizeProviderError(new Error("weird failure")).code).toBe("UNKNOWN");
  });

  it("gateway 用 normalizeProviderError，取消不会落成 UNKNOWN（源码约束）", () => {
    const src = readFileSync("lib/model-gateway/index.ts", "utf8");
    expect(src).toContain("normalizeProviderError(e, req.signal)");
    expect(src).not.toMatch(/new ProviderError\(String\(e\?\.message \|\| e\), "UNKNOWN", false\)/);
  });
});

describe("五、取消轮询与心跳分离", () => {
  const worker = readFileSync("scripts/agent-worker.mts", "utf8");

  it("取消轮询有独立定时器与独立间隔", () => {
    expect(worker).toContain("WORKER_CANCEL_POLL_MS");
    expect(worker).toMatch(/CANCEL_POLL_MS\s*=\s*Number\(process\.env\.WORKER_CANCEL_POLL_MS\s*\|\|\s*3000\)/);
    // 两个独立的 setInterval：心跳用 HEARTBEAT_MS，取消轮询用 CANCEL_POLL_MS
    expect(worker).toMatch(/setInterval\([\s\S]*?\},\s*HEARTBEAT_MS\)/);
    expect(worker).toMatch(/setInterval\([\s\S]*?\},\s*CANCEL_POLL_MS\)/);
  });

  it("默认取消延迟远小于心跳周期", async () => {
    const { HEARTBEAT_MS } = await import("@/lib/task-queue");
    const cancelDefault = 3000;
    expect(cancelDefault).toBeLessThan(HEARTBEAT_MS);
    expect(HEARTBEAT_MS / cancelDefault).toBeGreaterThanOrEqual(5);  // 至少快 5 倍
  });

  it("两个定时器都被清理，不泄漏", () => {
    expect(worker).toContain("clearInterval(hb)");
    expect(worker).toContain("clearInterval(cancelPoll)");
  });
});

describe("六、agent_runs 状态", () => {
  it("runStatusOf 按 result 派生五种状态", async () => {
    const { runStatusOf } = await import("@/lib/agents/base");
    expect(runStatusOf({ ok: true, output: {} })).toBe("ok");
    expect(runStatusOf({ ok: false, output: null, error_code: "CANCELED" })).toBe("canceled");
    expect(runStatusOf({ ok: false, output: null, error_code: "STAGE_BLOCKED" })).toBe("blocked_by_stage");
    expect(runStatusOf({ ok: false, output: null, error_code: "RATE_LIMIT" })).toBe("retryable_error");
    expect(runStatusOf({ ok: false, output: null, error_code: "SERVER" })).toBe("retryable_error");
    expect(runStatusOf({ ok: false, output: null, error_code: "SCHEMA_INVALID" })).toBe("error");
    expect(runStatusOf({ ok: false, output: null, error_code: "INVALID_INPUT" })).toBe("error");
  });

  it("失败结果绝不写 status=ok（源码约束）", () => {
    const src = readFileSync("lib/agents/base.ts", "utf8");
    // 主路径不得再硬编码 "ok"
    expect(src).not.toMatch(/logRun\(runId, ctx, type, input, result, Date\.now\(\) - t0, "ok"\)/);
    expect(src).toContain("runStatusOf(result));");
  });

  it("统计：失败运行按状态正确归类", async () => {
    const { runStatusOf } = await import("@/lib/agents/base");
    const results = [
      { ok: true, output: {} },
      { ok: true, output: {} },
      { ok: false, output: null, error_code: "RATE_LIMIT" as const },
      { ok: false, output: null, error_code: "TIMEOUT" as const },
      { ok: false, output: null, error_code: "SCHEMA_INVALID" as const },
      { ok: false, output: null, error_code: "CANCELED" as const },
      { ok: false, output: null, error_code: "STAGE_BLOCKED" as const },
    ];
    const tally: Record<string, number> = {};
    for (const r of results) { const s = runStatusOf(r as any); tally[s] = (tally[s] || 0) + 1; }
    expect(tally).toEqual({ ok: 2, retryable_error: 2, error: 1, canceled: 1, blocked_by_stage: 1 });
    // 失败率统计不再失真：成功只有 2 条，而非 7 条
    expect(tally.ok).toBe(2);
  });

  it("写入 agent_runs 的状态可被查询统计", async () => {
    for (const [id, st] of [["R1", "ok"], ["R2", "retryable_error"], ["R3", "error"], ["R4", "canceled"]]) {
      await ctx.raw(
        `INSERT INTO agent_runs (run_id, project_id, agent_type, status, duration_ms)
         VALUES ($1,'P','solution_architect',$2,10)`, [id, st],
      );
    }
    const rs = await ctx.raw("SELECT status, COUNT(*) n FROM agent_runs GROUP BY status ORDER BY status");
    const map = Object.fromEntries(rs.rows.map((r: any) => [r.status, Number(r.n)]));
    expect(map).toEqual({ ok: 1, retryable_error: 1, error: 1, canceled: 1 });
  });
});

describe("八、CI 配置", () => {
  const ci = readFileSync(".github/workflows/ci.yml", "utf8");

  it("workflow 位于默认分支的标准路径且结构合法", () => {
    // 路径必须是 .github/workflows/*.yml，否则 GitHub 不会识别
    expect(ci.length).toBeGreaterThan(0);
    // 不依赖额外依赖：做关键结构断言
    expect(ci).toMatch(/^name:\s*CI/m);
    expect(ci).toMatch(/^on:/m);
    expect(ci).toMatch(/push:/);
    expect(ci).toMatch(/branches:\s*\[main\]/);
    expect(ci).toMatch(/^jobs:/m);
  });

  it("显式声明权限，确保状态回写 commit checks", () => {
    expect(ci).toMatch(/permissions:/);
    expect(ci).toMatch(/checks:\s*write/);
    expect(ci).toMatch(/statuses:\s*write/);
  });

  it("五个步骤齐全且顺序正确", () => {
    const order = ["npm ci", "npm run lint", "npm run typecheck", "npm test", "npm run build"];
    let pos = -1;
    for (const step of order) {
      const at = ci.indexOf(step);
      expect(at, `缺少步骤: ${step}`).toBeGreaterThan(-1);
      expect(at, `步骤顺序错误: ${step}`).toBeGreaterThan(pos);
      pos = at;
    }
  });

  it("Node 20 与 22 双版本矩阵", () => {
    expect(ci).toMatch(/node-version:\s*\["20",\s*"22"\]/);
  });
});
