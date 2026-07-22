import { describe, it, expect, beforeEach, vi } from "vitest";
import { z } from "zod";

/** Schema strict 与缓存归属。对应本轮整改第二、三项。 */

beforeEach(() => {
  vi.resetModules();
  process.env.ENABLE_MOCK_PROVIDER = "1";
  process.env.MOCK_LATENCY_MS = "1";
  delete process.env.MOCK_FAIL_RATE;
});

function stubInfra() {
  vi.doMock("../lib/system-mode", () => ({
    getSystemMode: async () => "NORMAL",
    allowsPriority: () => ({ allowed: true }),
  }));
  vi.doMock("../lib/model-gateway/telemetry", () => ({
    recordUsageEvent: async () => 0, checkBudget: async () => null, estimateCost: () => 0,
  }));
  vi.doMock("../lib/model-gateway/health", () => ({
    isAvailable: async () => true, recordCall: async () => {},
    healthSnapshot: async () => [], enable: async () => {}, disable: async () => {},
  }));
}

describe("Schema strict：校验失败即调用失败", () => {
  it("strict 任务 Schema 不符时 ok=false、errorCode=SCHEMA_INVALID、带 issues", async () => {
    stubInfra();
    vi.doMock("../lib/model-gateway/cache", () => ({
      PROMPT_VERSION: "v2", SCHEMA_VERSION: "s1",
      buildCacheKey: () => "k", cacheGet: async () => null,
      cacheSet: async () => {}, cacheDelete: async () => {}, inputHash: () => "h",
    }));
    const { modelGateway } = await import("../lib/model-gateway");
    // mock 返回的 solution 结构不含 impossible_field，用不可能满足的 schema 触发失败
    const r = await modelGateway.run({
      taskType: "SOLUTION_PRIMARY",         // strict
      system: "生成 solution", messages: [{ role: "user", content: "x" }],
      schema: z.object({ impossible_field: z.string() }),
      allowCache: false,
    });
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe("SCHEMA_INVALID");
    expect(r.validation.ok).toBe(false);
    expect(r.validation.issues?.length).toBeGreaterThan(0);
    expect(r.message).toContain("不符合预期结构");
  });

  it("warn 任务 Schema 不符仍返回 ok=true，但 validation.ok=false", async () => {
    stubInfra();
    vi.doMock("../lib/model-gateway/cache", () => ({
      PROMPT_VERSION: "v2", SCHEMA_VERSION: "s1",
      buildCacheKey: () => "k", cacheGet: async () => null,
      cacheSet: async () => {}, cacheDelete: async () => {}, inputHash: () => "h",
    }));
    const { modelGateway } = await import("../lib/model-gateway");
    const r = await modelGateway.run({
      taskType: "GENERAL_QA",               // warn
      system: "q", messages: [{ role: "user", content: "x" }],
      schema: z.object({ impossible_field: z.string() }),
      allowCache: false,
    });
    expect(r.ok).toBe(true);
    expect(r.validation.ok).toBe(false);
  });

  it("strict 校验失败不得写缓存", async () => {
    stubInfra();
    const sets: string[] = [];
    vi.doMock("../lib/model-gateway/cache", () => ({
      PROMPT_VERSION: "v2", SCHEMA_VERSION: "s1",
      buildCacheKey: (o: any) => `${o.provider}:${o.model}`,
      cacheGet: async () => null,
      cacheSet: async (k: string) => { sets.push(k); },
      cacheDelete: async () => {}, inputHash: () => "h",
    }));
    const { modelGateway } = await import("../lib/model-gateway");
    await modelGateway.run({
      taskType: "BOM_NORMALIZE",            // strict
      system: "BOM", messages: [{ role: "user", content: "x" }],
      schema: z.object({ impossible_field: z.string() }),
      allowCache: true,
    });
    expect(sets).toHaveLength(0);
  });

  it("命中的缓存不符合当前 Schema 时被删除并重新调用，不返回 ok=true 的脏数据", async () => {
    stubInfra();
    const deleted: string[] = [];
    vi.doMock("../lib/model-gateway/cache", () => ({
      PROMPT_VERSION: "v2", SCHEMA_VERSION: "s1",
      buildCacheKey: (o: any) => `${o.provider}:${o.model}`,
      // 缓存里是过期结构
      cacheGet: async () => ({ output: JSON.stringify({ old_shape: true }), provider: "mock", model: "mock-model" }),
      cacheSet: async () => {},
      cacheDelete: async (k: string) => { deleted.push(k); },
      inputHash: () => "h",
    }));
    const { modelGateway } = await import("../lib/model-gateway");
    const r = await modelGateway.run({
      taskType: "BOM_NORMALIZE",
      system: "BOM", messages: [{ role: "user", content: "x" }],
      schema: z.object({ impossible_field: z.string() }),
      allowCache: true,
    });
    expect(deleted.length).toBeGreaterThan(0);     // 坏缓存被清理
    expect(r.ok).toBe(false);                       // 不把脏缓存当成功
    expect(r.cacheHit).toBe(false);
  });
});

describe("缓存归属：容灾切换后不得张冠李戴", () => {
  it("缓存 key 由实际产出的 provider:model 决定", async () => {
    vi.resetModules();
    const { buildCacheKey } = await import("../lib/model-gateway/cache");
    const base = { taskType: "SOLUTION_PRIMARY", input: { a: 1 }, projectId: "P", scope: "project" };
    const gemini = buildCacheKey({ ...base, provider: "gemini", model: "gemini-2.5-flash" });
    const qwen = buildCacheKey({ ...base, provider: "qwen", model: "qwen-plus" });
    expect(gemini).not.toBe(qwen);   // 两家结果各自独立存放
  });

  it("Gemini 失败、Qwen 成功后，结果写入 Qwen 的 key 而非 Gemini 的", async () => {
    stubInfra();
    const written: { key: string; provider: string }[] = [];
    vi.doMock("../lib/model-gateway/cache", () => ({
      PROMPT_VERSION: "v2", SCHEMA_VERSION: "s1",
      buildCacheKey: (o: any) => `${o.provider}:${o.model}`,
      cacheGet: async () => null,
      cacheSet: async (k: string, _p: any, _o: string, provider: string) => { written.push({ key: k, provider }); },
      cacheDelete: async () => {}, inputHash: () => "h",
    }));
    // 构造：第一家抛错，第二家成功
    const { ProviderError } = await import("../lib/model-gateway/providers/base");
    const failing = {
      id: "gemini", label: "G", capabilities: { vision: true, pdf: true, jsonMode: true, thinkingControl: true },
      pricing: { inputPerMillion: 1, outputPerMillion: 1 },
      isConfigured: () => true, modelFor: () => "gemini-2.5-flash",
      complete: async () => { throw new ProviderError("挂了", "SERVER", false); },
    };
    const working = {
      id: "qwen", label: "Q", capabilities: { vision: true, pdf: false, jsonMode: true, thinkingControl: false },
      pricing: { inputPerMillion: 0.5, outputPerMillion: 0.5 },
      isConfigured: () => true, modelFor: () => "qwen-plus",
      complete: async () => ({ text: JSON.stringify({ ok: true }), inputTokens: 5, outputTokens: 5, truncated: false }),
    };
    vi.doMock("../lib/model-gateway/router", () => ({
      route: async () => [{ provider: failing, model: "gemini-2.5-flash" }, { provider: working, model: "qwen-plus" }],
      routingSnapshot: async () => ({}),
    }));
    delete process.env.ENABLE_MOCK_PROVIDER;
    const { modelGateway } = await import("../lib/model-gateway");
    const r = await modelGateway.run({
      taskType: "GENERAL_QA", system: "q", messages: [{ role: "user", content: "x" }], allowCache: true,
    });
    expect(r.ok).toBe(true);
    expect(r.provider).toBe("qwen");
    expect(r.fallbackUsed).toBe(true);
    expect(written).toHaveLength(1);
    expect(written[0].provider).toBe("qwen");
    expect(written[0].key).toContain("qwen");        // 关键：不能写进 gemini 的 key
    expect(written[0].key).not.toContain("gemini");
  });
});

describe("TaskPolicy schemaMode 配置", () => {
  it("八类结构化任务必须为 strict", async () => {
    const { TASK_POLICIES } = await import("../lib/model-gateway/task-policy");
    for (const t of ["PROBLEM_STRUCTURE", "SCORING_EXTRACT", "REQUIREMENT_NORMALIZE",
      "SOLUTION_PRIMARY", "SOLUTION_FALLBACK", "BOM_NORMALIZE", "CODE_GENERATE", "TEST_PLAN"]) {
      expect((TASK_POLICIES as any)[t].schemaMode, t).toBe("strict");
    }
  });
});

describe("Provider 路由安全（第五项）", () => {
  it("普通用户的 providerHint 被忽略，admin/worker 的生效", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("lib/model-gateway/index.ts", "utf8");
    expect(src).toContain('req.caller === "admin"');
    expect(src).toContain('req.caller === "worker"');
    expect(src).toContain("const effectiveHint = hintAllowed ? req.providerHint : null");
  });

  it("定价未知的 Provider 不参与低价自动排序", async () => {
    vi.resetModules();
    process.env.CUSTOM_API_KEY = "k";
    process.env.CUSTOM_BASE_URL = "https://x/v1";
    process.env.CUSTOM_MODEL_TEXT = "m";
    const { PROVIDERS } = await import("../lib/model-gateway/providers");
    expect(PROVIDERS.custom.pricing).toBeNull();          // 未声明定价 = null，非 0
    expect(PROVIDERS.gemini.pricing).not.toBeNull();
    delete process.env.CUSTOM_API_KEY;
  });

  it("成本排序按任务的输入/输出 token 配比，而非单价相加", async () => {
    vi.doUnmock("../lib/model-gateway/router");
    vi.resetModules();
    const { estimateTaskCost } = await import("../lib/model-gateway/router");
    // A：输入便宜输出贵；B：输入贵输出便宜
    const A = { inputPerMillion: 0.1, outputPerMillion: 10 };
    const B = { inputPerMillion: 5, outputPerMillion: 0.5 };
    // 单价相加：A=10.1 > B=5.5，会误判 B 更便宜
    // 长输入短输出任务（如 BOM 规范化）实际 A 更省
    expect(estimateTaskCost(A, 8000, 500)).toBeLessThan(estimateTaskCost(B, 8000, 500));
    // 短输入长输出任务（如报告生成）则 B 更省
    expect(estimateTaskCost(B, 500, 4000)).toBeLessThan(estimateTaskCost(A, 500, 4000));
  });

  it("选路返回可解释的理由", async () => {
    vi.doUnmock("../lib/model-gateway/router");
    vi.resetModules();
    process.env.ENABLE_MOCK_PROVIDER = "1";
    const { route } = await import("../lib/model-gateway/router");
    const { policyFor } = await import("../lib/model-gateway/task-policy");
    const cands = await route(policyFor("SOLUTION_PRIMARY"));
    expect(cands[0].reason).toBeTruthy();
    expect(cands[0].reason).toContain("ENABLE_MOCK_PROVIDER");
  });
});

describe("兼容层不再二次重试（第六项）", () => {
  it("llmJson 只做单次转发，解析与重试全在网关", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("lib/llm.ts", "utf8");
    const body = src.slice(src.indexOf("export async function llmJson"), src.indexOf("export class GatewayCallError"));
    expect(body).toContain("modelGateway.run");
    expect(body).not.toContain("repairTruncatedJson");   // 不再自己修复
    expect(body).not.toMatch(/retry|重试/);               // 不再自己重试
    expect(src).not.toContain("_lastRepairApplied");      // 模块级状态已删除
  });

  it("partial 通过 ALS 上下文传递，并发安全", async () => {
    const { withAgentContext, markPartial, sawPartial } = await import("../lib/agents/base");
    const [a, b] = await Promise.all([
      withAgentContext({ owner: "u1", partialSeen: { value: false } }, async () => {
        markPartial();
        await new Promise((r) => setTimeout(r, 10));
        return sawPartial();
      }),
      withAgentContext({ owner: "u2", partialSeen: { value: false } }, async () => {
        await new Promise((r) => setTimeout(r, 5));
        return sawPartial();       // 未标记，不应被 u1 污染
      }),
    ]);
    expect(a).toBe(true);
    expect(b).toBe(false);
  });
});
