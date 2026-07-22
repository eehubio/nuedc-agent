import { describe, it, expect, beforeEach, vi } from "vitest";

/** 模型网关测试：对照本轮 8 条验收标准。
 *  不触碰真实 Provider —— 通过 mock provider 与纯函数验证行为。 */

beforeEach(() => {
  vi.resetModules();
  for (const k of Object.keys(process.env)) {
    if (/^(GEMINI|QWEN|DEEPSEEK|GLM|MOONSHOT|CUSTOM|MODEL_PROVIDER|ENABLE_MOCK)/.test(k)) delete process.env[k];
  }
});

describe("验收 6：确定性任务完全不用模型", () => {
  it("规则引擎与评分不出现在 taskType 表中（它们根本不经过网关）", async () => {
    const { TASK_TYPES } = await import("../lib/model-gateway/task-policy");
    for (const forbidden of ["INTEGRATION_CHECK", "SCORE_COMPUTE", "PIN_CONFLICT", "POWER_BUDGET"]) {
      expect(TASK_TYPES as readonly string[]).not.toContain(forbidden);
    }
  });
  it("接口检查与评分是纯函数，不 import 任何模型模块", async () => {
    const fs = await import("node:fs");
    for (const f of ["lib/rules/integration-rules.ts", "lib/rules/test-scoring.ts"]) {
      const src = fs.readFileSync(f, "utf8");
      expect(src).not.toMatch(/model-gateway|llmJson|llmComplete/);
    }
  });
});

describe("验收 2：Gemini 不可用时自动切换", () => {
  it("选路跳过熔断中的 Provider，按链路顺序给出候选", async () => {
    process.env.GEMINI_API_KEY = "k1";
    process.env.QWEN_API_KEY = "k2";
    process.env.QWEN_BASE_URL = "https://example.com/v1";
    process.env.MODEL_PROVIDER_PRIMARY = "gemini";
    process.env.MODEL_PROVIDER_FALLBACK = "qwen";

    vi.doMock("../lib/model-gateway/health", () => ({
      isAvailable: async (p: string) => p !== "gemini",     // gemini 熔断中
      recordCall: async () => {}, healthSnapshot: async () => [],
      enable: async () => {}, disable: async () => {},
    }));
    const { route } = await import("../lib/model-gateway/router");
    const { policyFor } = await import("../lib/model-gateway/task-policy");
    const cands = await route(policyFor("SOLUTION_PRIMARY"));
    expect(cands.length).toBeGreaterThan(0);
    expect(cands[0].provider.id).toBe("qwen");             // 自动切到备用
    expect(cands.map((c) => c.provider.id)).not.toContain("gemini");
  });

  it("低成本任务优先选便宜的 Provider", async () => {
    process.env.GEMINI_API_KEY = "k1";
    process.env.GLM_API_KEY = "k2";
    process.env.GLM_BASE_URL = "https://example.com/v4";
    vi.doMock("../lib/model-gateway/health", () => ({
      isAvailable: async () => true, recordCall: async () => {},
      healthSnapshot: async () => [], enable: async () => {}, disable: async () => {},
    }));
    const { route } = await import("../lib/model-gateway/router");
    const { policyFor } = await import("../lib/model-gateway/task-policy");
    const cheap = await route(policyFor("REPORT_POLISH"));   // preference: cheap
    expect(cheap[0].provider.id).toBe("glm");                // GLM 单价最低
  });
});

describe("验收 3：模型全部不可用时系统仍可工作", () => {
  it("无可用 Provider 时返回降级信息而非抛异常", async () => {
    vi.doMock("../lib/model-gateway/health", () => ({
      isAvailable: async () => true, recordCall: async () => {},
      healthSnapshot: async () => [], enable: async () => {}, disable: async () => {},
    }));
    vi.doMock("../lib/system-mode", () => ({
      getSystemMode: async () => "NORMAL",
      allowsPriority: () => ({ allowed: true }),
    }));
    vi.doMock("../lib/model-gateway/telemetry", () => ({
      recordUsageEvent: async () => 0, checkBudget: async () => null, estimateCost: () => 0,
    }));
    const { modelGateway } = await import("../lib/model-gateway");
    const r = await modelGateway.run({
      taskType: "GENERAL_QA", system: "s", messages: [{ role: "user", content: "q" }],
    });
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe("NO_PROVIDER");
    expect(r.degraded?.mode).toBe("RULES_ONLY");
    expect(r.message).toContain("仍可正常使用");    // 明确告知可用能力
  });

  it("RULES_ONLY 模式拒绝模型任务但说明可用能力", async () => {
    vi.doUnmock("../lib/system-mode");
    vi.resetModules();
    const { allowsPriority } = await import("../lib/system-mode");
    const r = allowsPriority("RULES_ONLY", 0);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/BOM|测试|报告/);
  });

  it("DEGRADED 模式只暂停低优先任务，P0 仍放行", async () => {
    vi.doUnmock("../lib/system-mode");
    vi.resetModules();
    const { allowsPriority } = await import("../lib/system-mode");
    expect(allowsPriority("DEGRADED", 0).allowed).toBe(true);   // 主方案
    expect(allowsPriority("DEGRADED", 3).allowed).toBe(false);  // 报告润色
  });
});

describe("验收 5：相同结果可缓存复用", () => {
  it("cache key 随 prompt 版本与模型变化，防止陈旧命中", async () => {
    const { buildCacheKey } = await import("../lib/model-gateway/cache");
    const base = { taskType: "BOM_NORMALIZE", input: { a: 1 }, projectId: "P1", model: "m1", scope: "project" };
    expect(buildCacheKey(base)).toBe(buildCacheKey({ ...base }));
    expect(buildCacheKey(base)).not.toBe(buildCacheKey({ ...base, model: "m2" }));
    expect(buildCacheKey(base)).not.toBe(buildCacheKey({ ...base, input: { a: 2 } }));
  });
  it("全局作用域缓存不含 projectId（官方题目跨项目复用）", async () => {
    const { buildCacheKey } = await import("../lib/model-gateway/cache");
    const a = buildCacheKey({ taskType: "PDF_EXTRACT", input: { x: 1 }, projectId: "P1", model: "m", scope: "global" });
    const b = buildCacheKey({ taskType: "PDF_EXTRACT", input: { x: 1 }, projectId: "P2", model: "m", scope: "global" });
    expect(a).toBe(b);
  });
});

describe("验收 7：Token 与成本可监控可限制", () => {
  it("每个 taskType 都有输出上限，且不超过 8k", async () => {
    const { TASK_POLICIES } = await import("../lib/model-gateway/task-policy");
    for (const [name, p] of Object.entries(TASK_POLICIES)) {
      expect(p.maxOutputTokens, name).toBeGreaterThan(0);
      expect(p.maxOutputTokens, name).toBeLessThanOrEqual(8000);
    }
  });
  it("降本目标：方案≤4k、报告章节≤2500、润色≤1200、BOM≤2000", async () => {
    const { TASK_POLICIES } = await import("../lib/model-gateway/task-policy");
    expect(TASK_POLICIES.SOLUTION_PRIMARY.maxOutputTokens).toBeLessThanOrEqual(4000);
    expect(TASK_POLICIES.REPORT_SECTION.maxOutputTokens).toBeLessThanOrEqual(2500);
    expect(TASK_POLICIES.REPORT_POLISH.maxOutputTokens).toBeLessThanOrEqual(1200);
    expect(TASK_POLICIES.BOM_NORMALIZE.maxOutputTokens).toBeLessThanOrEqual(2000);
  });
  it("OCR 与 JSON 抽取类任务关闭 thinking 预算", async () => {
    const { TASK_POLICIES } = await import("../lib/model-gateway/task-policy");
    expect(TASK_POLICIES.PDF_EXTRACT.thinkingBudget).toBe(0);
    expect(TASK_POLICIES.BOM_NORMALIZE.thinkingBudget).toBe(0);
    expect(TASK_POLICIES.REQUIREMENT_NORMALIZE.thinkingBudget).toBe(0);
    expect(TASK_POLICIES.SOLUTION_PRIMARY.thinkingBudget).toBeGreaterThan(0);  // 主方案允许适量
  });
  it("成本估算按 Provider 单价计算", async () => {
    vi.doUnmock("../lib/model-gateway/telemetry");
    vi.resetModules();
    process.env.GEMINI_API_KEY = "k";
    const { estimateCost } = await import("../lib/model-gateway/telemetry");
    const c = estimateCost("gemini", 1_000_000, 1_000_000);
    expect(c).toBeCloseTo(0.30 + 2.50, 2);
  });
});

describe("验收 1 & 高峰排队：优先级", () => {
  it("主方案/代码修复为 P0，报告润色与问答为 P3", async () => {
    const { TASK_POLICIES } = await import("../lib/model-gateway/task-policy");
    expect(TASK_POLICIES.SOLUTION_PRIMARY.priority).toBe(0);
    expect(TASK_POLICIES.CODE_REPAIR.priority).toBe(0);
    expect(TASK_POLICIES.REPORT_POLISH.priority).toBe(3);
    expect(TASK_POLICIES.GENERAL_QA.priority).toBe(3);
  });
  it("重型任务标记 heavy，用于每用户并发限制", async () => {
    const { TASK_POLICIES } = await import("../lib/model-gateway/task-policy");
    expect(TASK_POLICIES.SOLUTION_PRIMARY.concurrencyClass).toBe("heavy");
    expect(TASK_POLICIES.GENERAL_QA.concurrencyClass).toBe("light");
  });
});

describe("验收 8：调用可追踪到用户/项目/任务", () => {
  it("用量事件表包含 owner/project/task/taskType 四个维度", async () => {
    const fs = await import("node:fs");
    const mig = fs.readFileSync("lib/migrations.ts", "utf8");
    const seg = mig.slice(mig.indexOf("llm_usage_events"));
    for (const col of ["owner", "project_id", "task_id", "task_type", "provider", "input_tokens", "output_tokens", "estimated_cost"]) {
      expect(seg).toContain(col);
    }
  });
});

describe("Provider 抽象：不锁定供应商", () => {
  it("国内厂商通过环境变量配置即可启用，无需改代码", async () => {
    const { PROVIDERS } = await import("../lib/model-gateway/providers");
    expect(Object.keys(PROVIDERS)).toEqual(expect.arrayContaining(["gemini", "qwen", "deepseek", "glm", "moonshot", "custom"]));
    process.env.CUSTOM_API_KEY = "k";
    process.env.CUSTOM_BASE_URL = "https://my-gateway.local/v1";
    process.env.CUSTOM_MODEL_TEXT = "my-model";
    expect(PROVIDERS.custom.isConfigured()).toBe(true);
    expect(PROVIDERS.custom.modelFor("text")).toBe("my-model");
  });
  it("业务代码不判断 provider 字符串", async () => {
    const fs = await import("node:fs");
    for (const f of ["lib/agents/engineering.ts", "lib/agents/planning.ts", "lib/agents/delivery.ts"]) {
      const src = fs.readFileSync(f, "utf8");
      expect(src).not.toMatch(/LLM_PROVIDER|generativelanguage|api\.anthropic|dashscope/);
    }
  });
  it("错误分类：429 可重试、认证失败不可重试", async () => {
    const { classifyHttpError } = await import("../lib/model-gateway/providers/base");
    expect(classifyHttpError(429, "rate limited").retryable).toBe(true);
    expect(classifyHttpError(401, "bad key").retryable).toBe(false);
    expect(classifyHttpError(404, "model not found").code).toBe("MODEL_NOT_FOUND");
    expect(classifyHttpError(403, "not available in your country").code).toBe("REGION_BLOCKED");
    expect(classifyHttpError(500, "oops").retryable).toBe(true);
  });
});

describe("上下文压缩（降本核心）", () => {
  it("预算不足时优先保留安全约束与基本要求，省略项进 manifest", async () => {
    const { buildContext } = await import("../lib/model-gateway/context-builder");
    const reqs = [
      { id: "R1", description: "发挥项".repeat(30), priority: "bonus", status: "AI_EXTRACTED" },
      { id: "R2", description: "输出电压精度", priority: "mandatory", status: "CONFIRMED" },
      { id: "R3", description: "并网侧需加隔离保护", priority: "mandatory", status: "CONFIRMED" },
    ];
    const { manifest } = buildContext({ requirements: reqs, budgetTokens: 60 });
    expect(manifest.includedRequirementIds).toContain("R3");   // 安全约束优先
    expect(manifest.omittedRequirementIds).toContain("R1");
    expect(manifest.estimatedTokens).toBeGreaterThan(0);
  });
  it("模块预筛选只返回 top K，优先模块置顶", async () => {
    const { preFilterModules } = await import("../lib/model-gateway/context-builder");
    const all = Array.from({ length: 100 }, (_, i) => ({
      id: `m${i}`, name: `模块${i}`, certification_status: i < 3 ? "DRAFT" : "COMPETITION_READY", interfaces: [], power: {},
    }));
    const picked = preFilterModules(all, { preferred: ["m1"], limit: 10 });
    expect(picked).toHaveLength(10);
    expect(picked[0].id).toBe("m1");
  });
});

describe("赛题中心：官方题目只解析一次", () => {
  it("同一 PDF 哈希唯一，重复上传返回既有题目", async () => {
    const { pdfHash } = await import("../lib/problem-center");
    const a = pdfHash("JVBERi0xLjQKJeLjz9M...");
    expect(pdfHash("JVBERi0xLjQKJeLjz9M...")).toBe(a);
    expect(pdfHash("different")).not.toBe(a);
    const fs = await import("node:fs");
    const mig = fs.readFileSync("lib/migrations.ts", "utf8");
    expect(mig).toContain("idx_problems_pdf");           // 唯一索引防重复解析
    expect(mig).toContain("source_pdf_hash");
  });

  it("项目采用官方题目的接口不调用任何模型", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("app/api/projects/[id]/adopt-problem/route.ts", "utf8");
    expect(src).not.toMatch(/modelGateway|llmJson|llmComplete/);
    expect(src).toContain("llm_calls: 0");
  });

  it("双模复核：关键差异（指标/分值）标记为 critical", async () => {
    const { diffExtractions } = await import("../lib/problem-center");
    const a = {
      requirements: [{ id: "R1", description: "输出电压可调", target: 10, unit: "V", tolerance: "±1%" }],
      scoring_items: [{ item: "幅度测量", points: 30 }],
    };
    const b = {
      requirements: [{ id: "R1", description: "输出电压可调", target: 12, unit: "V", tolerance: "±1%" }],
      scoring_items: [{ item: "幅度测量", points: 20 }],
    };
    const diffs = diffExtractions(a as any, b as any);
    const critical = diffs.filter((d) => d.severity === "critical");
    expect(critical.length).toBe(2);                       // 指标不一致 + 分值不一致
    expect(critical.some((d) => d.field_path.includes("target"))).toBe(true);
    expect(critical.some((d) => d.field_path.includes("points"))).toBe(true);
  });

  it("完全一致的两次提取不产生差异", async () => {
    const { diffExtractions } = await import("../lib/problem-center");
    const x = { requirements: [{ id: "R1", description: "同样的描述", target: 5, unit: "V" }], scoring_items: [{ item: "a", points: 10 }] };
    expect(diffExtractions(x as any, JSON.parse(JSON.stringify(x)))).toHaveLength(0);
  });

  it("双模复核只用于后台任务，普通用户 Agent 不默认双模", async () => {
    const fs = await import("node:fs");
    const staff = fs.readFileSync("app/api/problems/[id]/extract/route.ts", "utf8");
    expect(staff).toContain("dual_review");
    for (const f of ["lib/agents/engineering.ts", "lib/agents/planning.ts", "lib/agents/delivery.ts"]) {
      expect(fs.readFileSync(f, "utf8")).not.toContain("dual_review");
    }
  });
});

describe("压测脚本安全默认", () => {
  it("默认走 mock，真实模型需显式 --real", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("scripts/load-test.mts", "utf8");
    expect(src).toContain('args.includes("--real")');
    expect(src).toContain("ALLOW_MOCK_ASSUMED");
    expect(src).toContain("会产生真实模型费用");
  });
});

describe("基础故障不返回空响应（压测发现）", () => {
  it("数据库不可用时创建项目返回结构化 503，而非崩溃或空体", async () => {
    const saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      vi.resetModules();
      const mod: any = await import("../app/api/projects/route");
      const req: any = new Request("http://x/api/projects", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "t" }),
      });
      req.cookies = { get: () => undefined };
      const res = await mod.POST(req);
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.error).toBeTruthy();
      expect(String(body.error)).toContain("服务暂时不可用");
    } finally {
      if (saved) process.env.DATABASE_URL = saved;
    }
  });
});

describe("压测脚本与状态机一致性", () => {
  it("压测推进到的阶段确实允许 solution_architect", async () => {
    const fs = await import("node:fs");
    const { STAGE_ALLOWED_AGENTS } = await import("../lib/types");
    const src = fs.readFileSync("scripts/load-test.mts", "utf8");
    const m = src.match(/stage:\s*"([A-Z_]+)"/);
    expect(m, "压测脚本必须显式推进项目阶段").toBeTruthy();
    const stage = m![1];
    expect((STAGE_ALLOWED_AGENTS as any)[stage]).toContain("solution_architect");
  });

  it("压测提交的需求全部为 CONFIRMED（方案 Agent 有需求确认门禁）", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("scripts/load-test.mts", "utf8");
    const taskBlock = src.slice(src.indexOf('agent: "solution_architect"'), src.indexOf('agent: "solution_architect"') + 900);
    expect(taskBlock).toContain('status: "CONFIRMED"');
    expect(taskBlock).toContain('priority: "mandatory"');
  });

  it("非 --real 模式必须先做 mock 预检，未通过则中止", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("scripts/load-test.mts", "utf8");
    expect(src).toContain("async function preflight");
    expect(src).toContain("if (!(await preflight())) process.exit(2)");
    expect(src).toContain("会产生真实模型费用");
  });
});

describe("选路预览端点（压测预检依赖）", () => {
  it("mock 开启时如实报告 mock，且不泄露密钥", async () => {
    process.env.ENABLE_MOCK_PROVIDER = "1";
    vi.resetModules();
    const mod: any = await import("../app/api/routing-preview/route");
    const d = await (await mod.GET()).json();
    expect(d.mock_enabled).toBe(true);
    expect(d.primary_candidate).toContain("mock");
    // 不得包含任何密钥字段
    expect(JSON.stringify(d)).not.toMatch(/API_KEY|sk-|Bearer/i);
    delete process.env.ENABLE_MOCK_PROVIDER;
  });

  it("mock 关闭时报告真实 Provider，压测预检据此中止", async () => {
    delete process.env.ENABLE_MOCK_PROVIDER;
    process.env.GEMINI_API_KEY = "fake";
    process.env.GEMINI_MODEL = "gemini-2.5-flash";
    vi.resetModules();
    const mod: any = await import("../app/api/routing-preview/route");
    const d = await (await mod.GET()).json();
    expect(d.mock_enabled).toBe(false);
    expect(d.primary_candidate).toContain("gemini");
  });
});

describe("任务模型名不再臆测", () => {
  it("建任务时不按 LLM_PROVIDER 猜模型名（实际由网关选路决定）", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("app/api/agent-tasks/route.ts", "utf8");
    expect(src).not.toMatch(/process\.env\.LLM_PROVIDER === "gemini"/);
    expect(src).toContain("执行完成后回写实际值");
  });
  it("执行完成后从用量事件回写真实 provider 与 model", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("app/api/agent-tasks/[id]/execute/route.ts", "utf8");
    expect(src).toContain("MAX(provider) provider");
    expect(src).toContain("model=COALESCE(?, model)");
  });
});
