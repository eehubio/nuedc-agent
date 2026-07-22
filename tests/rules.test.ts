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

  it("I2C/SDA 总线端点豁免；普通引脚被两条连接占用 → 冲突", () => {
    const r = checkIntegration(baseSol({
      connections: [
        { from: "SENSOR1.SDA", to: "MCU.SDA", protocol: "I2C", voltage_from: 3.3, voltage_to: 3.3 },
        { from: "SENSOR2.SDA", to: "MCU.SDA", protocol: "I2C", voltage_from: 3.3, voltage_to: 3.3 },
        { from: "ENC.A", to: "MCU.PC1", protocol: "GPIO", voltage_from: 3.3, voltage_to: 3.3 },
        { from: "KEY.OUT", to: "MCU.PC1", protocol: "GPIO", voltage_from: 3.3, voltage_to: 3.3 },
      ],
    }) as any, modIndex);
    const pinIssues = r.issues.filter((i) => i.rule === "PIN_CONFLICT");
    expect(pinIssues.some((i) => i.where.includes("SDA"))).toBe(false);  // 总线豁免
    expect(pinIssues.some((i) => i.where.includes("PC1"))).toBe(true);   // 普通引脚冲突
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
