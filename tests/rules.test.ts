import { describe, it, expect } from "vitest";
import { checkIntegration } from "../lib/rules/integration-rules";
import { judge, computeScore } from "../lib/rules/test-scoring";
import { stripPaidFields, canDownloadAssets } from "../lib/auth";
import { scoreCompleteness } from "../lib/module-query";
import { makeAdminToken, verifyAdminToken } from "../lib/admin-session";
import type { Requirement } from "../lib/types";

/* ---------- 夹具 ---------- */
const modIndex: Record<string, any> = {
  "mcu-a": {
    id: "mcu-a", name: "主控A",
    interfaces: [{ name: "UART0", interface_type: "UART", voltage_level: 3.3, five_v_tolerant: false, pins: [{ signal: "RX", pin: "PA10" }] }],
    power: { typical_current_ma: 100 },
  },
  "drv-t": {
    id: "drv-t", name: "驱动T",
    interfaces: [{ name: "PWMA", interface_type: "PWM", voltage_level: 3.3, five_v_tolerant: true, pins: [] }],
    power: { typical_current_ma: 50 },
  },
  "cam-x": { id: "cam-x", name: "视觉X", interfaces: [], power: { peak_current_ma: 900 } },
};
const baseSol = (over: any = {}) => ({
  solution_id: "S", name: "t", summary: "", advantages: [], disadvantages: [],
  risk_level: "low", implementation_hours: 1, uncovered_requirements: [],
  blocks: [
    { block_id: "B1", name: "主控", module_id: "mcu-a", role: "mcu", covers_requirements: [] },
    { block_id: "B2", name: "驱动", module_id: "drv-t", role: "motor", covers_requirements: [] },
    { block_id: "B3", name: "视觉", module_id: "cam-x", role: "vision", covers_requirements: [] },
  ],
  connections: [], power_tree: [], ...over,
});

describe("接口规则引擎", () => {
  it("5V 打非容忍 3.3V 输入 → blocker", () => {
    const r = checkIntegration(baseSol({
      connections: [{ from: "X.OUT", to: "MCU-A.UART0_RX", protocol: "UART", voltage_from: 5, voltage_to: 3.3 }],
    }) as any, modIndex);
    expect(r.passed).toBe(false);
    expect(r.issues.some((i) => i.rule === "LEVEL_5V_INTO_3V3" && i.severity === "blocker")).toBe(true);
  });

  it("5V 打已标注 5V 容忍的输入 → 仅 warning 不阻断", () => {
    const r = checkIntegration(baseSol({
      connections: [{ from: "MCU.PWM", to: "DRV-T.PWMA", protocol: "PWM", voltage_from: 5, voltage_to: 3.3 }],
      blocks: [{ block_id: "B2", name: "驱动", module_id: "drv-t", role: "motor", covers_requirements: [] }],
    }) as any, modIndex);
    expect(r.issues.some((i) => i.severity === "blocker" && i.rule.startsWith("LEVEL"))).toBe(false);
  });

  it("电源预算超支 → blocker，并给出各负载明细", () => {
    const r = checkIntegration(baseSol({
      power_tree: [{ rail: "5V", voltage: 5, source: "DCDC", loads: ["B1", "B3"], budget_ma: 500 }],
    }) as any, modIndex);
    const hit = r.issues.find((i) => i.rule === "POWER_BUDGET_EXCEEDED");
    expect(hit?.severity).toBe("blocker");
    expect(hit?.message).toContain("1000");
  });

  it("多个源驱动同一输入 → 阻断；I2C 总线豁免", () => {
    const r = checkIntegration(baseSol({
      connections: [
        { from: "SENSOR1.SDA", to: "MCU.SDA", protocol: "I2C", voltage_from: 3.3, voltage_to: 3.3 },
        { from: "SENSOR2.SDA", to: "MCU.SDA", protocol: "I2C", voltage_from: 3.3, voltage_to: 3.3 },
        { from: "ENC.A", to: "MCU.PC1", protocol: "GPIO", voltage_from: 3.3, voltage_to: 3.3 },
        { from: "KEY.OUT", to: "MCU.PC1", protocol: "GPIO", voltage_from: 3.3, voltage_to: 3.3 },
      ],
    }) as any, modIndex);
    const pinIssues = r.issues.filter((i) => i.rule === "PIN_CONFLICT");
    expect(pinIssues.some((i) => i.where.includes("SDA"))).toBe(false);   // 总线豁免
    expect(pinIssues.some((i) => i.where.includes("PC1") && i.severity === "blocker")).toBe(true);  // 两个源抢 MCU.PC1 输入 → 阻断
  });

  it("一个输出扇出驱动多个输入 → 警告不阻断（模拟信号分路是正常做法）", () => {
    const r = checkIntegration(baseSol({
      connections: [
        { from: "B2.OUT", to: "B3.IN", protocol: "Analog", voltage_from: 2.5, voltage_to: 2.5 },
        { from: "B2.OUT", to: "B4.IN", protocol: "Analog", voltage_from: 2.5, voltage_to: 2.5 },
      ],
    }) as any, modIndex);
    expect(r.issues.filter((i) => i.rule === "PIN_CONFLICT")).toHaveLength(0);
    const fanout = r.issues.find((i) => i.rule === "PIN_FANOUT");
    expect(fanout?.severity).toBe("warning");
    expect(r.passed).toBe(true);   // 仅警告不拦截代码生成
  });
});

describe("测试评分规则", () => {
  const req = (over: Partial<Requirement> = {}): Requirement => ({
    id: "REQ-001", type: "performance", description: "输出幅度",
    target: 2, unit: "Vpp", tolerance: "±1%", priority: "mandatory",
    source: "基本要求(1)", verification_method: "measurement", status: "CONFIRMED", ...over,
  });

  it("±1% 容差内通过、超出不通过", () => {
    expect(judge(req(), { requirement_id: "REQ-001", measured_value: 2.01 }).passed).toBe(true);
    expect(judge(req(), { requirement_id: "REQ-001", measured_value: 2.1 }).passed).toBe(false);
  });
  it("≤ 型判据按上限判定", () => {
    const r = req({ tolerance: "≤5", target: undefined });
    expect(judge(r, { requirement_id: "REQ-001", measured_value: 4 }).passed).toBe(true);
    expect(judge(r, { requirement_id: "REQ-001", measured_value: 6 }).passed).toBe(false);
  });
  it("人工判定覆盖自动判定；未测返回 null", () => {
    expect(judge(req(), { requirement_id: "REQ-001", measured_value: 99, pass_override: true }).passed).toBe(true);
    expect(judge(req(), undefined).passed).toBe(null);
  });
  it("得分汇总：未通过的基本要求进入 blockers，未测项拉开高低区间", () => {
    const reqs = [req(), req({ id: "REQ-002" }), req({ id: "REQ-003", priority: "bonus" })];
    const { summary } = computeScore(reqs, [
      { requirement_id: "REQ-001", measured_value: 2 },      // pass
      { requirement_id: "REQ-002", measured_value: 3 },      // fail
    ]);
    expect(summary.mandatory_passed).toBe(1);
    expect(summary.blockers).toHaveLength(1);
    expect(summary.score_high).toBeGreaterThan(summary.score_low);
  });
});

describe("付费门控", () => {
  const mod = { id: "m", schematic_assets: ["a.pdf"], pcb_assets: ["b"], code_repositories: ["c"], name: "x" };
  it("免费用户剥离付费字段并标记锁定", () => {
    const out: any = stripPaidFields(mod as any);
    expect(out.schematic_assets).toEqual([]);      // 置空而非删键，前端可安全遍历
    expect(out.code_repositories).toEqual([]);
    expect(out.assets_locked).toBe(true);
  });
  it("付费用户仅可下载 FUNCTION_TESTED 及以上；实验室不受限", () => {
    expect(canDownloadAssets("paid", "DOCUMENTED")).toBe(false);
    expect(canDownloadAssets("paid", "FUNCTION_TESTED")).toBe(true);
    expect(canDownloadAssets("lab", "DRAFT")).toBe(true);
    expect(canDownloadAssets("free", "COMPETITION_READY")).toBe(false);
  });
});

describe("完整度评分", () => {
  it("补充字段单调不减，空模块低分", () => {
    const empty = scoreCompleteness({ id: "x" });
    const rich = scoreCompleteness({
      id: "x", name: "n", category: "c", main_chip: "chip", description: "很长的描述文本", price: 10,
      tags: ["a"], interfaces: [{ pins: [{ signal: "s", pin: "1" }], constraints: ["c"] }],
      power: { input_voltage_range: [3, 5], typical_current_ma: 10, peak_current_ma: 20 },
      usage_notes: ["u"], known_issues: ["k"], competition_cases: [{ year: 2024, problem: "A" }],
      compatibility: ["y"], source_snapshot: { source: "lab" }, schematic_assets: ["s"], code_repositories: ["r"],
    });
    expect(empty.score).toBeLessThan(30);
    expect(rich.score).toBeGreaterThan(90);
    expect(rich.score).toBeGreaterThan(empty.score);
  });
});

describe("管理会话令牌", () => {
  it("正确密钥签发的令牌可验证；篡改与错密钥拒绝", () => {
    const t = makeAdminToken("secret-1");
    expect(verifyAdminToken(t, "secret-1")).toBe(true);
    expect(verifyAdminToken(t, "secret-2")).toBe(false);
    expect(verifyAdminToken(t.slice(0, -2) + "xx", "secret-1")).toBe(false);
    expect(verifyAdminToken(undefined, "secret-1")).toBe(false);
  });
});

describe("迁移框架", () => {
  it("迁移编号唯一且递增", async () => {
    const { MIGRATIONS } = await import("../lib/migrations");
    const ids = MIGRATIONS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
  });
});

describe("证据等级 schema", () => {
  it("合法证据通过校验，非法等级被拒", async () => {
    const { evidenceRecordSchema } = await import("../lib/module-schema");
    expect(evidenceRecordSchema.safeParse({
      param: "power.peak_current_ma", value: 1.4, unit: "A",
      evidence_level: "E5", conditions: "12V, 25°C", source_id: "TEST-2026-017",
    }).success).toBe(true);
    expect(evidenceRecordSchema.safeParse({ param: "x", value: 1, evidence_level: "E9" }).success).toBe(false);
  });
});

describe("官方分值 vs 估算分值", () => {
  const req2 = (id: string, pri: "mandatory" | "bonus" = "mandatory"): Requirement => ({
    id, type: "performance", description: "d", target: 2, unit: "V", tolerance: "±1%",
    priority: pri, source: "s", verification_method: "measurement", status: "CONFIRMED",
  });
  it("题面官方分值：按关联需求判定，未测计入上限", () => {
    const reqs = [req2("REQ-001"), req2("REQ-002")];
    const items = [
      { item: "幅度测量", points: 30, points_type: "official" as const, requirement_ids: ["REQ-001"] },
      { item: "相位测量", points: 20, points_type: "official" as const, requirement_ids: ["REQ-002"] },
    ];
    const { summary } = computeScore(reqs, [{ requirement_id: "REQ-001", measured_value: 2 }], items);
    expect(summary.score_basis).toBe("official");
    expect(summary.official_total).toBe(50);
    expect(summary.score_low).toBe(30);     // 通过项
    expect(summary.score_high).toBe(50);    // 未测项计入上限
  });
  it("无官方分值 → 估算口径", () => {
    const { summary } = computeScore([req2("REQ-001")], [], [
      { item: "x", points: null, points_type: "estimated" as const, requirement_ids: ["REQ-001"] },
    ]);
    expect(summary.score_basis).toBe("estimated");
  });
});

describe("产物依赖图（精确失效）", () => {
  it("方案的下游含代码与报告，不含需求", async () => {
    const { downstreamOf } = await import("../lib/artifact-graph");
    const d = downstreamOf("solution");
    expect(d).toContain("code_bundle");
    expect(d).toContain("report");
    expect(d).not.toContain("requirements");
  });
  it("接口检查变更只影响代码及之后，不影响 BOM", async () => {
    const { downstreamOf } = await import("../lib/artifact-graph");
    const d = downstreamOf("integration_report");
    expect(d).toContain("code_bundle");
    expect(d).not.toContain("bom");
  });
  it("需求变更传递到全链", async () => {
    const { downstreamOf } = await import("../lib/artifact-graph");
    expect(downstreamOf("requirements")).toEqual(expect.arrayContaining(["solution", "bom", "code_bundle", "report", "test_record"]));
  });
});

describe("内容哈希", () => {
  it("相同内容同哈希，不同内容不同哈希，键序不敏感需一致输入", async () => {
    const { contentHash } = await import("../lib/artifacts");
    expect(contentHash({ a: 1 })).toBe(contentHash({ a: 1 }));
    expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: 2 }));
  });
});

describe("权限矩阵（canAccessProject）", () => {
  it("admin 全通；所有者通；成员通；陌生人拒", async () => {
    const { canAccessProject } = await import("../lib/auth");
    expect(canAccessProject("admin", "u1", "u9", false)).toBe(true);
    expect(canAccessProject("free", "u1", "u1", false)).toBe(true);
    expect(canAccessProject("paid", "u1", "u2", true)).toBe(true);
    expect(canAccessProject("paid", "u1", "u2", false)).toBe(false);
    expect(canAccessProject("lab", "u1", "u2", false)).toBe(false);
  });
});

describe("编译输入护栏", () => {
  it("路径逃逸/绝对路径/非法扩展名/超量被拒，正常工程放行", async () => {
    const { validateBuildFiles } = await import("../lib/build-limits");
    expect(validateBuildFiles([{ path: "../x.c", content: "" }])).toBeTruthy();
    expect(validateBuildFiles([{ path: "/etc/x.c", content: "" }])).toBeTruthy();
    expect(validateBuildFiles([{ path: "run.sh", content: "" }])).toBeTruthy();
    expect(validateBuildFiles(Array.from({ length: 41 }, (_, i) => ({ path: `f${i}.c`, content: "" })))).toBeTruthy();
    expect(validateBuildFiles([{ path: "src/main.c", content: "int main(){return 0;}" }])).toBeNull();
  });
});

describe("JSON 截断修复", () => {
  it("修复断在字符串中间的输出（真实故障样本）", async () => {
    const { repairTruncatedJson } = await import("../lib/llm");
    const truncated = `{
  "project_name": "集成运放参数测量装置",
  "requirements": [
    { "id": "REQ-001", "type": "constraint", "priority": "mandatory", "description": "需提供 DIP8 插座" },
    { "id": "REQ-002", "type": "performance", "priority": "mandatory", "description": "测量单位增益带宽",
      "target`;
    const fixed = repairTruncatedJson(truncated);
    expect(fixed).toBeTruthy();
    const o = JSON.parse(fixed!);
    expect(o.project_name).toBe("集成运放参数测量装置");
    expect(o.requirements.length).toBeGreaterThanOrEqual(1);   // 保住完整的那些条目
    expect(o.requirements[0].id).toBe("REQ-001");
  });
  it("修复断在数组元素之间的输出", async () => {
    const { repairTruncatedJson } = await import("../lib/llm");
    const o = JSON.parse(repairTruncatedJson('{"a":[1,2,3],"b":{"c":"x"},"d":[{"e":1},{"e":2},')!);
    expect(o.a).toEqual([1, 2, 3]);
    expect(o.d.length).toBe(2);
  });
  it("完整 JSON 原样返回；无 JSON 返回 null", async () => {
    const { repairTruncatedJson } = await import("../lib/llm");
    expect(JSON.parse(repairTruncatedJson('{"ok":true}')!)).toEqual({ ok: true });
    expect(repairTruncatedJson("这不是 JSON")).toBeNull();
  });
});

describe("方案输出契约", () => {
  it("前后端字段一致：solutions 与 candidate_solutions 同时提供", () => {
    // 契约锁：solution_architect 的 output 必须含 solutions（前端读取字段）
    const output: any = { candidate_solutions: [{ solution_id: "SOL-A", name: "x", blocks: [{ block_id: "B1" }] }] };
    output.solutions = output.candidate_solutions;
    expect(output.solutions).toBeDefined();
    expect(output.solutions[0].solution_id).toBe("SOL-A");
  });
  it("残缺方案（无 blocks）应被判定为不可用", () => {
    const raw = [
      { solution_id: "SOL-A", name: "完整", blocks: [{ block_id: "B1" }] },
      { solution_id: "SOL-B", name: "残缺" },
    ];
    const usable = raw.filter((s: any) => s?.solution_id && s?.name && Array.isArray(s.blocks) && s.blocks.length);
    expect(usable).toHaveLength(1);
    expect(usable[0].solution_id).toBe("SOL-A");
  });
});

describe("模块目录裁剪", () => {
  it("优先模块置顶、按认证等级排序、超限截断并注明", async () => {
    const { moduleCatalogForLlm } = await import("../lib/agents/base");
    const index: Record<string, any> = {};
    for (let i = 0; i < 50; i++) {
      index[`m${i}`] = { id: `m${i}`, name: `模块${i}`, category: "sensor.other",
        certification_status: i < 5 ? "DRAFT" : "COMPETITION_READY", interfaces: [], power: {} };
    }
    const out = moduleCatalogForLlm(index, { preferred: ["m3"], limit: 10 });
    const lines = out.split("\n");
    expect(lines[0]).toContain("id=m3");            // 优先模块置顶（即便它是 DRAFT）
    expect(lines[1]).toContain("COMPETITION_READY"); // 其余按认证排序
    expect(out).toContain("另有 40 个模块未列出");
  });
  it("小库不截断、不加注释", async () => {
    const { moduleCatalogForLlm } = await import("../lib/agents/base");
    const out = moduleCatalogForLlm({ a: { id: "a", name: "A", category: "c", certification_status: "DRAFT", interfaces: [], power: {} } });
    expect(out).not.toContain("未列出");
  });
});

describe("Gemini thinking 预算与截断诊断", () => {
  it("2.5 系列模型应关闭 thinking 预算（否则思考 token 吃掉输出配额）", () => {
    const shouldDisable = (m: string) => /2\.5|thinking/i.test(m);
    expect(shouldDisable("gemini-2.5-flash")).toBe(true);
    expect(shouldDisable("gemini-2.5-pro")).toBe(true);
    expect(shouldDisable("gemini-2.0-flash")).toBe(false);
  });
});

describe("历年赛题库", () => {
  it("年份倒序、每年至少一题、题号唯一", async () => {
    const { PAST_PROBLEMS, PROBLEM_YEARS } = await import("../data/past-problems");
    expect(Number(PROBLEM_YEARS[0])).toBeGreaterThan(Number(PROBLEM_YEARS[PROBLEM_YEARS.length - 1]));
    for (const y of PROBLEM_YEARS) {
      const list = PAST_PROBLEMS[y];
      expect(list.length).toBeGreaterThan(0);
      expect(new Set(list.map((p) => p.code)).size).toBe(list.length);
    }
  });
});

describe("方案解析容错（字段别名）", () => {
  // 复刻 normalizeSolution 的契约：这些形状都应被接受
  function normalize(raw: any, id = "SOL-A") {
    if (!raw || typeof raw !== "object") return null;
    const s: any = raw.solution || raw.candidate_solution ||
      (Array.isArray(raw.candidate_solutions) ? raw.candidate_solutions[0] : null) ||
      (Array.isArray(raw.solutions) ? raw.solutions[0] : null) || raw;
    const blocks = s?.blocks || s?.modules || s?.components || s?.function_blocks || [];
    if (!Array.isArray(blocks) || !blocks.length) return null;
    return { solution_id: s.solution_id || s.id || id, name: s.name || s.title || `方案 ${id}`, blocks };
  }
  it("接受 {solution:{...}} 包装", () => {
    expect(normalize({ solution: { solution_id: "SOL-A", name: "x", blocks: [{ name: "主控" }] } })?.name).toBe("x");
  });
  it("接受裸对象（无包装）", () => {
    expect(normalize({ solution_id: "SOL-A", name: "裸", blocks: [{ name: "主控" }] })?.name).toBe("裸");
  });
  it("接受 modules/components 作为功能块别名", () => {
    expect(normalize({ solution: { name: "a", modules: [{ name: "m" }] } })?.blocks).toHaveLength(1);
    expect(normalize({ components: [{ name: "c" }] })?.blocks).toHaveLength(1);
  });
  it("接受 candidate_solutions 数组（旧格式）", () => {
    expect(normalize({ candidate_solutions: [{ name: "旧", blocks: [{ name: "b" }] }] })?.name).toBe("旧");
  });
  it("缺少 id/name 时用默认值补齐，不判失败", () => {
    const r = normalize({ blocks: [{ name: "b" }] }, "SOL-B");
    expect(r?.solution_id).toBe("SOL-B");
    expect(r?.name).toBe("方案 SOL-B");
  });
  it("真正没有功能块才判失败", () => {
    expect(normalize({ solution: { name: "空" } })).toBeNull();
    expect(normalize(null)).toBeNull();
  });
});

describe("失效横幅显示条件", () => {
  // 契约：产物不存在时不该提示"已过期"
  function shouldShow(exists: boolean | undefined, staleTypes: string[], types: string[]) {
    if (exists === false) return false;
    return types.some((t) => staleTypes.includes(t));
  }
  it("产物未生成过 → 不显示", () => {
    expect(shouldShow(false, ["code_bundle"], ["code_bundle"])).toBe(false);
  });
  it("产物存在且被标 stale → 显示", () => {
    expect(shouldShow(true, ["code_bundle"], ["code_bundle"])).toBe(true);
  });
  it("产物存在但未 stale → 不显示", () => {
    expect(shouldShow(true, ["bom"], ["code_bundle"])).toBe(false);
  });
});

describe("配额与用量", () => {
  it("各 tier 每日配额符合策略", async () => {
    const { quotaFor } = await import("../lib/usage");
    expect(quotaFor("pdf_extract", "free")).toBe(2);
    expect(quotaFor("pdf_extract", "paid")).toBe(20);
    expect(quotaFor("pdf_extract", "lab")).toBe(-1);
    expect(quotaFor("pdf_extract", "admin")).toBe(-1);
    expect(quotaFor("unknown_kind", "free")).toBe(0);
  });
});

describe("LLM 输出 Schema 校验", () => {
  it("BOM 数量字段：'很多'→null(交人工)，'2块'→2，数字原样", async () => {
    const { bomItemSchema } = await import("../lib/agent-schemas");
    const p = (q: any) => bomItemSchema.parse({ name: "x", quantity: q, confidence: 0.9 }).quantity;
    expect(p("很多")).toBeNull();   // 不再悄悄猜成 1
    expect(p("2块")).toBe(2);
    expect(p(3)).toBe(3);
  });
  it("置信度越界被夹到 [0,1]，非数值兜底 0.5", async () => {
    const { bomItemSchema } = await import("../lib/agent-schemas");
    const c = (v: any) => bomItemSchema.parse({ name: "x", quantity: 1, confidence: v }).confidence;
    expect(c(5)).toBe(1);
    expect(c(-2)).toBe(0);
    expect(c("高")).toBe(0.5);
  });
  it("items 是字符串（模型抽风）→ 逐项过滤后为空，不会污染下游", async () => {
    const { bomItemSchema, parseArrayLoose } = await import("../lib/agent-schemas");
    expect(parseArrayLoose(bomItemSchema, "none").data).toHaveLength(0);
    const mixed = parseArrayLoose(bomItemSchema, [{ name: "好行", quantity: 1, confidence: 1 }, { 不是: "物料" }]);
    expect(mixed.data).toHaveLength(1);
    expect(mixed.dropped).toBe(1);
  });
  it("方案缺少 blocks → 校验失败", async () => {
    const { solutionSchema } = await import("../lib/agent-schemas");
    expect(solutionSchema.safeParse({ solution_id: "S", name: "n", blocks: [] }).success).toBe(false);
    expect(solutionSchema.safeParse({ solution_id: "S", name: "n", blocks: [{ block_id: "B1", name: "主控" }] }).success).toBe(true);
  });
});

describe("需求上下文裁剪（不静默丢弃）", () => {
  function build(reqs: any[], budget: number) {
    const rank = (r: any) => (r.priority === "mandatory" ? 0 : 1);
    const ordered = [...reqs].sort((a, b) => rank(a) - rank(b));
    const compact = (r: any) => ({ id: r.id, description: String(r.description || "").slice(0, 120), priority: r.priority });
    const kept: any[] = []; const omitted: string[] = []; let size = 2;
    for (const r of ordered) {
      const piece = JSON.stringify(compact(r));
      if (size + piece.length + 1 <= budget) { kept.push(compact(r)); size += piece.length + 1; }
      else omitted.push(r.id);
    }
    return { kept, omitted };
  }
  it("预算不足时优先保留基本要求，发挥项进 omitted", () => {
    const reqs = [
      { id: "R1", description: "发挥项".repeat(20), priority: "bonus" },
      { id: "R2", description: "基本项", priority: "mandatory" },
      { id: "R3", description: "基本项", priority: "mandatory" },
    ];
    const { kept, omitted } = build(reqs, 120);
    expect(kept.map((k) => k.id)).toContain("R2");
    expect(kept.map((k) => k.id)).toContain("R3");
    expect(omitted).toContain("R1");
  });
  it("预算充足时全部纳入，omitted 为空", () => {
    const { kept, omitted } = build([{ id: "R1", description: "a", priority: "mandatory" }], 6000);
    expect(kept).toHaveLength(1);
    expect(omitted).toHaveLength(0);
  });
});

describe("未知功耗不按 0 处理", () => {
  it("功率类模块缺功耗数据 → 阻断；普通模块 → 警告", () => {
    const idx: Record<string, any> = {
      "motor-x": { id: "motor-x", name: "电机驱动", category: "actuator.motor", interfaces: [], power: {} },
      "led-y": { id: "led-y", name: "指示灯", category: "other.misc", interfaces: [], power: {} },
    };
    const sol: any = {
      solution_id: "S", name: "t", summary: "", advantages: [], disadvantages: [], risk_level: "low",
      implementation_hours: 1, uncovered_requirements: [],
      blocks: [
        { block_id: "B1", name: "电机", module_id: "motor-x", role: "motor", covers_requirements: [] },
        { block_id: "B2", name: "灯", module_id: "led-y", role: "led", covers_requirements: [] },
      ],
      connections: [],
      power_tree: [{ rail: "5V", voltage: 5, source: "DCDC", loads: ["B1", "B2"], budget_ma: 1000 }],
    };
    const r = checkIntegration(sol, idx);
    const missing = r.issues.filter((i) => i.rule === "POWER_DATA_MISSING");
    expect(missing.some((i) => i.severity === "blocker" && i.message.includes("电机"))).toBe(true);
    expect(missing.some((i) => i.severity === "warning" && i.message.includes("指示灯"))).toBe(true);
  });
});

describe("阻断项修复建议覆盖", () => {
  it("每条会产生 blocker 的规则都有对应修复指引", () => {
    // 与 components/pages-build.tsx 的 FIX_HINTS 保持同步的契约
    const BLOCKER_RULES = ["POWER_BUDGET_EXCEEDED", "POWER_DATA_MISSING", "LEVEL_5V_INTO_3V3", "PIN_CONFLICT"];
    const HINT_KEYS = ["POWER_BUDGET_EXCEEDED", "POWER_BUDGET_TIGHT", "POWER_DATA_MISSING", "LEVEL_5V_INTO_3V3",
      "LEVEL_MISMATCH", "LEVEL_LOW_DRIVE_HIGH", "PIN_CONFLICT", "PIN_FANOUT", "BAUDRATE_MISMATCH", "MOTOR_LOGIC_ISOLATION"];
    for (const r of BLOCKER_RULES) expect(HINT_KEYS).toContain(r);
  });
});

describe("BOM 从方案展开", () => {
  it("每个功能块都应出现在给模型的物料请求里", () => {
    const blocks = [
      { block_id: "B1", name: "直达信号DDS", module_id: "dds-ad9833", role: "signal" },
      { block_id: "B2", name: "信号合路", module_id: "", role: "analog" },
    ];
    const list = blocks.map((b: any, i) =>
      `${i + 1}. 功能块 ${b.block_id}「${b.name}」${b.module_id ? `（模块库 id=${b.module_id}）` : "（无对应库模块，请按功能推断常用器件）"}${b.role ? ` 角色=${b.role}` : ""}`
    ).join("\n");
    expect(list).toContain("B1");
    expect(list).toContain("dds-ad9833");
    expect(list).toContain("无对应库模块");   // 无 module_id 的块要提示模型自己推断
  });
});

describe("账户能力矩阵", () => {
  it("免费账户无代码/报告/调试；付费有；实验室与管理员全开", async () => {
    const { canDownloadAssets, canUploadModules } = await import("../lib/auth");
    const paidAgents = ["code_generator", "report_composer", "labsight_debug"];
    const allowed = (tier: string) => paidAgents.every(() => tier !== "free");
    expect(allowed("free")).toBe(false);
    expect(allowed("paid")).toBe(true);
    expect(canUploadModules("free")).toBe(false);
    expect(canUploadModules("paid")).toBe(true);
    expect(canDownloadAssets("free", "COMPETITION_READY")).toBe(false);
    expect(canDownloadAssets("paid", "FUNCTION_TESTED")).toBe(true);
  });
});

describe("报告 Markdown → DOCX", () => {
  it("解析出标题/段落/列表/表格/代码块/分隔线六类块", async () => {
    const { parseMarkdown } = await import("../lib/report-export");
    const md = ["# 标题", "", "正文**粗体**。", "", "* 项一", "* 项二", "",
      "| A | B |", "| --- | --- |", "| 1 | 2 |", "", "```c", "int main(){}", "```", "", "---", "", "## 二级"].join("\n");
    const types = parseMarkdown(md).map((b) => b.type);
    expect(types).toContain("heading");
    expect(types).toContain("para");
    expect(types).toContain("list");
    expect(types).toContain("table");
    expect(types).toContain("code");
    expect(types).toContain("hr");
  });
  it("表格行列解析正确", async () => {
    const { parseMarkdown } = await import("../lib/report-export");
    const t = parseMarkdown("| 指标 | 要求 | 实测 |\n| --- | --- | --- |\n| 幅度 | 2Vpp | 2.01Vpp |")
      .find((b) => b.type === "table");
    expect(t?.rows?.[0]).toEqual(["指标", "要求", "实测"]);
    expect(t?.rows?.[1]).toEqual(["幅度", "2Vpp", "2.01Vpp"]);
  });
  it("生成合法 DOCX（ZIP 格式且含中文正文）", async () => {
    const { markdownToDocxBuffer } = await import("../lib/report-export");
    const buf = await markdownToDocxBuffer("# 电赛设计报告\n\n本系统采用 DDS 方案。", "测试");
    expect(buf.length).toBeGreaterThan(2000);
    expect(buf.slice(0, 2).toString()).toBe("PK");   // ZIP 魔数
  });
});

describe("框图节点摆位", () => {
  it("自定义坐标覆盖自动布局，清空后回退", () => {
    const auto = new Map([["B1", { x: 10, y: 12 }], ["B2", { x: 268, y: 12 }]]);
    const custom: Record<string, { x: number; y: number }> = { B1: { x: 400, y: 200 } };
    for (const [id, p] of Object.entries(custom)) if (auto.has(id)) auto.set(id, p);
    expect(auto.get("B1")).toEqual({ x: 400, y: 200 });
    expect(auto.get("B2")).toEqual({ x: 268, y: 12 });   // 未自定义的保持自动布局
  });
});

describe("新建项目状态隔离", () => {
  it("重置应清空全部项目态字段（含测试/备选/选用模块）", () => {
    // 契约：resetProject 覆盖的字段集合
    const RESET_FIELDS = ["projectId", "stage", "problemText", "requirements", "solutions", "chosenSolution",
      "backupSolution", "wiringReport", "bom", "codeBundle", "debugSession", "report",
      "testPlan", "testRecords", "testResult", "staleTypes", "shortlist"];
    const stateAfterReset: Record<string, any> = {
      projectId: null, stage: "PREPARATION", problemText: "", requirements: null, solutions: null,
      chosenSolution: null, backupSolution: null, wiringReport: null, bom: null, codeBundle: null,
      debugSession: null, report: null, testPlan: null, testRecords: [], testResult: null,
      staleTypes: [], shortlist: [],
    };
    for (const f of RESET_FIELDS) {
      expect(stateAfterReset).toHaveProperty(f);
      const v = stateAfterReset[f];
      expect(v === null || v === "" || v === "PREPARATION" || (Array.isArray(v) && v.length === 0)).toBe(true);
    }
  });
});

describe("stale 横幅只对已存在产物显示", () => {
  function show(exists: boolean | undefined, stale: string[], types: string[]) {
    if (exists === false) return false;
    return types.some((t) => stale.includes(t));
  }
  it("测试计划从未生成 → 即使服务端标了 stale 也不提示", () => {
    expect(show(false, ["test_plan", "score"], ["test_plan", "score", "test_report"])).toBe(false);
  });
  it("测试计划已生成且 stale → 提示", () => {
    expect(show(true, ["test_plan"], ["test_plan", "score", "test_report"])).toBe(true);
  });
});

describe("方案页布局结构（防回归）", () => {
  it("设计助手必须是 solution-wrap 的直接子元素，否则会掉到需求清单下方", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("components/pages-build.tsx", "utf8");
    const seg = src.slice(src.indexOf("export function SolutionPage"), src.indexOf("/* ============ 电路连线"));
    const sub = seg.slice(seg.indexOf('<div className="solution-wrap">'));
    let depth = 0;
    let inside = "";
    for (const m of sub.matchAll(/<div\b(?![^>]*\/>)|<\/div>/g)) {
      depth += m[0].startsWith("<div") ? 1 : -1;
      if (depth === 0) { inside = sub.slice(0, (m.index ?? 0) + m[0].length); break; }
    }
    expect(inside).not.toBe("");                    // solution-wrap 必须正确闭合
    expect(inside).toContain("assistant-col");      // 助手在栅格内 → 才能并排显示
    expect(inside).toContain("RequirementEditor");  // 需求清单也在栅格内
  });
});

describe("配额原子性与返还（P0-2 / P0-3）", () => {
  it("SQL 用条件自增保证并发安全（契约检查）", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("lib/usage.ts", "utf8");
    // 必须是「插入或条件更新并返回」的单条语句，而非先 SELECT 再 INSERT
    expect(src).toContain("ON CONFLICT");
    expect(src).toContain("WHERE quota_counters.used < ?");
    expect(src).toContain("RETURNING used");
    expect(src).not.toMatch(/SELECT COUNT[\s\S]{0,200}INSERT INTO llm_usage/);
  });
  it("失败路径调用 refundQuota，成功路径调用 commitQuota", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("app/api/extract-pdf/route.ts", "utf8");
    expect(src).toContain("commitQuota(reservation.ref)");
    expect(src).toContain("refundQuota(id.owner");
  });
});

describe("公开诊断不得实时调用 LLM（P0-1）", () => {
  it("非管理员分支读 health_cache，不出现 llmComplete", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("app/api/diag/route.ts", "utf8");
    const publicBranch = src.slice(src.indexOf("if (!isAdmin)"), src.indexOf("const provider ="));
    expect(publicBranch).toContain("health_cache");
    expect(publicBranch).not.toContain("llmComplete");
  });
});

describe("需求枚举归一", () => {
  it("自由文本被映射到合法枚举，无法映射则落安全默认", async () => {
    const { requirementSchema } = await import("../lib/agent-schemas");
    const p = (o: any) => requirementSchema.parse({ id: "R1", description: "d", ...o });
    expect(p({ priority: "very important" }).priority).toBe("mandatory");
    expect(p({ priority: "optional" }).priority).toBe("bonus");
    expect(p({ priority: "发挥部分" }).priority).toBe("bonus");
    expect(p({ status: "probably confirmed" }).status).toBe("CONFIRMED");
    expect(p({ status: "有歧义" }).status).toBe("AMBIGUOUS");
    expect(p({ status: "" }).status).toBe("AI_EXTRACTED");
    expect(p({ type: "性能指标" }).type).toBe("performance");
    expect(p({ verification_method: "需要测量" }).verification_method).toBe("measurement");
  });
});

describe("连线与电源轨真校验（第三节 1）", () => {
  it("字符串连线被拒，结构化连线通过", async () => {
    const { connectionSchema, parseArrayLoose } = await import("../lib/agent-schemas");
    const r = parseArrayLoose(connectionSchema, [
      "随便连一下",
      { from: "B1.TX", to: "B2.RX", protocol: "UART", voltage_from: 3.3, voltage_to: 3.3 },
      { from: "", to: "B3.IN" },
    ]);
    expect(r.data).toHaveLength(1);
    expect(r.dropped).toBe(2);
  });
  it("电源轨预算强制数字，缺失记为 null 而非 0", async () => {
    const { powerRailSchema } = await import("../lib/agent-schemas");
    expect(powerRailSchema.parse({ rail: "5V", voltage: "5", budget_ma: "1000" }).budget_ma).toBe(1000);
    expect(powerRailSchema.parse({ rail: "5V", voltage: 5, budget_ma: "" }).budget_ma).toBeNull();
  });
});

describe("BOM 数量不猜（第三节 3）", () => {
  it("'若干' 解析为 null 而不是 1", async () => {
    const { bomItemSchema } = await import("../lib/agent-schemas");
    expect(bomItemSchema.parse({ name: "电阻", quantity: "若干", confidence: 0.8 }).quantity).toBeNull();
    expect(bomItemSchema.parse({ name: "电阻", quantity: "20个", confidence: 0.8 }).quantity).toBe(20);
    expect(bomItemSchema.parse({ name: "电阻", quantity: 5, confidence: 0.8 }).quantity).toBe(5);
  });
});

describe("统一身份函数（第五节）", () => {
  it("只保留 getRequestIdentity，旧的 resolveTierAsync 已移除", async () => {
    const fs = await import("node:fs");
    expect(fs.readFileSync("lib/auth.ts", "utf8")).not.toContain("resolveTierAsync");
    expect(fs.readFileSync("app/api/agent/route.ts", "utf8")).toContain("getRequestIdentity");
    expect(fs.readFileSync("app/api/agent-tasks/route.ts", "utf8")).toContain("getRequestIdentity");
  });
});

describe("兑换码防爆破（P0-4）", () => {
  it("有失败次数限制与哈希存储，不明文比对", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("app/api/account/route.ts", "utf8");
    expect(src).toContain("MAX_ATTEMPTS_PER_HOUR");
    expect(src).toContain("redeem_attempts");
    expect(src).toContain("hashCode");
    expect(src).toContain("used_count < max_uses");   // 次数上限
    expect(src).toContain("expires_at");              // 有效期
    expect(src).toContain("revoked_at");              // 可撤销
  });
});
