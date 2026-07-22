// 工程类 Agent：方案架构、接口集成检查、BOM 整理、备料规划
import { llmJson, lastRepairApplied } from "../llm";
import { registerAgent, loadModuleIndex, moduleCatalogForLlm } from "./base";
import { solutionSchema, bomOutputSchema, parseArrayLoose, bomItemSchema } from "../agent-schemas";
import { checkIntegration } from "../rules/integration-rules";
import { applyQuantityRules, flagForReview } from "../rules/procurement-rules";
import type { SolutionProposal, BomItem } from "../types";

// ============ Agent 8：系统方案架构（Solution Architect）============
// 生成两套候选方案；生成后立刻用规则引擎做接口预检，把结果附在方案上
registerAgent("solution_architect", async (input) => {
  const index = await loadModuleIndex();
  const catalog = moduleCatalogForLlm(index, { preferred: input.preferred_modules || [], limit: 40 });
  const requirements = input.requirements;
  if (!requirements) return { ok: false, output: null, message: "缺少 requirements（先运行赛题理解 Agent）" };
  // 需求确认门禁：所有必须项需人工确认（REJECTED 视为删除）；input.force=true 可越过（原型探索用）
  const reqList = (requirements.requirements || []) as { priority?: string; status?: string; id: string }[];
  const unconfirmed = reqList.filter((r) => r.priority === "mandatory" && r.status !== "CONFIRMED" && r.status !== "REJECTED");
  if (unconfirmed.length && !input.force) {
    return { ok: false, output: null, message: `尚有 ${unconfirmed.length} 条基本要求未确认（${unconfirmed.slice(0, 5).map((r) => r.id).join("、")}…）。请在需求清单中逐条确认后再生成正式方案。` };
  }
  // 不修改调用方传入的对象（旧问题 3）：用副本，避免前端状态被意外改写
  const requirementsForGen = { ...requirements, requirements: reqList.filter((r) => r.status !== "REJECTED") };

  // ---- 分次生成：两套方案各一次调用，单次输出量减半，从根本上避免截断 ----
  // （一次性生成两套方案 + 框图 + 连线 + 电源树，即使 12k token 也常被截断）
  const SHARED_RULES = `你是电赛系统方案架构师。要求：
1. 优先使用模块目录中的模块（引用真实 module_id）；目录没有的写 module_id 为空并在 name 里说明
2. 每个 block 标注 covers_requirements（引用 REQ id）；未覆盖的需求列入 uncovered_requirements
3. connections 必须同时给出结构化字段与显示字符串：from_block_id/from_interface_id/to_block_id/to_interface_id（引用 blocks 里的 block_id 与模块真实接口名）以及 from/to（形如 "B1.UART0_TX"）、protocol、voltage_from/voltage_to
4. power_tree 写清每条电源轨的电压、来源、负载和电流预算 budget_ma
5. 给出优缺点、风险等级、预计实现小时数
6. 四天三夜可完成性是第一约束
7. 篇幅控制：summary ≤50 字，每条优缺点 ≤20 字，功能块数量控制在 4~8 个
模块目录：
${catalog || "（模块库为空，允许方案使用通用模块名，module_id 留空）"}`;

  // 需求裁剪（P0-5）：不按字符硬切（会静默丢掉后半段），改为按优先级逐条纳入并明确报告省略项
  function buildRequirementContext(reqs: any[], budget = 6000) {
    const rank = (r: any) => (r.priority === "mandatory" ? 0 : 1);
    const ordered = [...reqs].sort((a, b) => rank(a) - rank(b));
    const compact = (r: any) => ({
      id: r.id, description: String(r.description || "").slice(0, 120),
      target: r.target ?? undefined, unit: r.unit ?? undefined, tolerance: r.tolerance ?? undefined,
      priority: r.priority,
    });
    const kept: any[] = [];
    const omitted: string[] = [];
    let size = 2;
    for (const r of ordered) {
      const piece = JSON.stringify(compact(r));
      if (size + piece.length + 1 <= budget) { kept.push(compact(r)); size += piece.length + 1; }
      else omitted.push(r.id);
    }
    return { kept, omitted };
  }
  const reqAll = (requirementsForGen.requirements || []) as any[];
  const { kept: reqKept, omitted: reqOmitted } = buildRequirementContext(reqAll);
  const userCtx = `结构化需求（共 ${reqAll.length} 条${reqOmitted.length ? `，因长度限制本次仅纳入 ${reqKept.length} 条` : ""}）：
${JSON.stringify(reqKept)}
${reqOmitted.length ? `注意：以下需求未纳入本次上下文，请在 uncovered_requirements 中原样列出它们：${reqOmitted.join("、")}` : ""}
补充约束：${input.constraints || "无"}
用户已选用的优先模块：${JSON.stringify(input.preferred_modules || [])}`;

  // 容错解析：模型可能返回 {solution:{...}}、直接 {...}、或把 blocks 叫别的名字
  function normalizeSolution(raw: any, id: string): SolutionProposal | null {
    if (!raw || typeof raw !== "object") return null;
    const s: any = raw.solution || raw.candidate_solution ||
      (Array.isArray(raw.candidate_solutions) ? raw.candidate_solutions[0] : null) ||
      (Array.isArray(raw.solutions) ? raw.solutions[0] : null) || raw;
    if (!s || typeof s !== "object") return null;
    // 功能块的常见别名
    const blocks = s.blocks || s.modules || s.components || s.function_blocks || s.block_diagram || [];
    if (!Array.isArray(blocks) || !blocks.length) return null;
    return {
      ...s,
      solution_id: s.solution_id || s.id || id,
      name: s.name || s.title || `方案 ${id}`,
      summary: s.summary || s.description || "",
      blocks: blocks.map((b: any, i: number) => ({
        block_id: b.block_id || b.id || `B${i + 1}`,
        name: b.name || b.title || `模块${i + 1}`,
        module_id: b.module_id || b.moduleId || "",
        role: b.role || b.type || "",
        covers_requirements: b.covers_requirements || b.requirements || [],
      })),
      connections: s.connections || s.links || [],
      power_tree: s.power_tree || s.power || [],
      advantages: s.advantages || s.pros || [],
      disadvantages: s.disadvantages || s.cons || [],
      risk_level: s.risk_level || "medium",
      implementation_hours: s.implementation_hours || 0,
      uncovered_requirements: s.uncovered_requirements || [],
    } as SolutionProposal;
  }

  let lastError = "";
  async function genOne(id: string, flavor: string): Promise<SolutionProposal | null> {
    try {
      const raw = await llmJson<any>({
        system: `${SHARED_RULES}\n\n本次只生成【一套】方案，solution_id 固定为 "${id}"，技术路线取向：${flavor}。
输出格式（严格遵守，blocks 至少 4 项）：
{"solution":{"solution_id":"${id}","name":"方案名","summary":"一句话概述","blocks":[{"block_id":"B1","name":"主控","module_id":"库中真实id或留空","role":"mcu","covers_requirements":["REQ-001"]}],"connections":[{"from_block_id":"B1","from_interface_id":"UART0_TX","to_block_id":"B2","to_interface_id":"RX","from":"B1.UART0_TX","to":"B2.RX","protocol":"UART","voltage_from":3.3,"voltage_to":3.3}],"power_tree":[{"rail":"3V3","voltage":3.3,"source":"LDO","loads":["B1"],"budget_ma":500}],"advantages":["..."],"disadvantages":["..."],"risk_level":"low","implementation_hours":40,"uncovered_requirements":[]}}`,
        messages: [{ role: "user", content: userCtx }],
        maxTokens: 10240,
        temperature: 0.4,
      });
      const norm0 = normalizeSolution(raw, id);
      // 运行时 Schema 校验（P0-4）：类型不符的字段就地修正，结构缺失才判失败
      const parsed = norm0 ? solutionSchema.safeParse(norm0) : null;
      const norm = parsed?.success ? (parsed.data as any) : null;
      if (!norm && norm0 && parsed && !parsed.success) {
        lastError = `方案结构校验失败：${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}:${i.message}`).join("；")}`;
      }
      if (!norm) {
        lastError = `模型返回的结构缺少功能块（收到字段：${Object.keys(raw?.solution || raw || {}).slice(0, 8).join("/") || "空"}）`;
      }
      return norm;
    } catch (e: any) {
      // 关键：不再吞掉真实错误（finishReason / 配额 / 网络）
      lastError = String(e?.message || e).slice(0, 300);
      console.error("[solution_architect] 生成失败:", lastError);
      return null;
    }
  }

  // 默认只生成 1 套方案；备选由前端传 variant 单独追加
  const variant: string | undefined = input.variant;
  const existing: SolutionProposal[] = input.existing_solutions || [];
  const FLAVORS: Record<string, string> = {
    balanced: "综合最优：在可实现性与性能之间取平衡，优先成熟模块与短调试链路",
    safe: "稳妥优先：成熟模块、实现风险低、调试链路短，确保四天三夜能完成",
    performance: "性能优先：更强算力或更高精度路径，允许更高实现难度",
  };
  const nextId = `SOL-${String.fromCharCode(65 + existing.length)}`;
  const flavor = FLAVORS[variant || "balanced"] || FLAVORS.balanced;
  const avoid = existing.length
    ? `\n已有方案（本次必须给出实质不同的技术路线，不要重复）：${existing.map((e: any) => `${e.solution_id}=${e.name}`).join("；")}`
    : "";

  const one = await genOne(nextId, flavor + avoid);
  const rawSols = [one].filter((x): x is SolutionProposal => !!x);

  // 结构校验：残缺方案不得当成功返回
  if (!rawSols.length) {
    return { ok: false, output: null, message: `方案生成失败：${lastError || "未知原因"}` };
  }
  const usable = rawSols.filter(
    (sl: any) => sl?.solution_id && sl?.name && Array.isArray(sl.blocks) && sl.blocks.length
  );
  if (!usable.length) {
    return { ok: false, output: null, message: `方案结构不完整：${lastError || "缺少功能块"}` };
  }
  const partial = lastRepairApplied();
  const truncation_note = partial
    ? "本次输出曾被截断并自动修复，方案可能不完整（例如缺少部分连线或功能块）—— 请仔细核对后再确认为主方案，或重新生成。"
    : undefined;

  // 生成后立即做规则预检（需求覆盖 + 接口兼容）
  const fresh = usable.map((sol: SolutionProposal) => ({
    ...sol,
    integration_precheck: checkIntegration(sol, index),
  }));
  const solutions = [...existing, ...fresh];

  // 需求覆盖率核对（P0-5 配套）：未纳入上下文的需求也要如实计入未覆盖
  for (const sol of fresh as any[]) {
    const covered = new Set<string>();
    for (const b of sol.blocks || []) for (const rid of b.covers_requirements || []) covered.add(rid);
    const uncovered = reqAll.map((r) => r.id).filter((id) => !covered.has(id));
    sol.uncovered_requirements = uncovered;
    sol.coverage = { total: reqAll.length, covered: reqAll.length - uncovered.length, omitted_from_context: reqOmitted };
  }

  return {
    ok: true,
    artifact_type: "solution_proposal",
    output: { solutions, candidate_solutions: solutions, recommended_solution: solutions[0]?.solution_id, truncation_note, partial_output: partial, repair_applied: partial },
    human_review_required: true, // 候选方案必须人工确认才能变成最终方案
    message: (existing.length ? `已追加备选方案 ${nextId}，可与现有方案对比` : "方案已生成，请核对后确认为主方案") + (partial ? "（⚠ 输出曾被截断修复，请重点核对完整性）" : ""),
  };
});

// ============ Agent 9：接口与集成检查（Integration Checker，纯规则）============
registerAgent("integration_checker", async (input) => {
  const solution: SolutionProposal | undefined = input.solution;
  if (!solution) return { ok: false, output: null, message: "缺少 solution 对象" };
  const index = await loadModuleIndex();
  const report = checkIntegration(solution, index);
  return {
    ok: true,
    artifact_type: "integration_report",
    output: report,
    message: report.passed
      ? `接口检查通过（${report.checked_connections} 条连接，${report.issues.length} 条提示）`
      : `发现 ${report.issues.filter((i) => i.severity === "blocker").length} 个阻断问题，禁止进入代码生成`,
  };
});

// ============ Agent 4：物料清单整理（BOM Normalization）============
// LLM 抽取规范化 + 规则引擎打审核标记
registerAgent("bom_agent", async (input) => {
  const rawText: string = input.raw_bom || "";
  const solution: SolutionProposal | undefined = input.solution;
  if (!rawText && !solution) return { ok: false, output: null, message: "请提供 raw_bom（文本/CSV 粘贴）或 solution（从方案生成 BOM）" };

  const source = rawText
    ? `用户粘贴的原始物料清单（可能来自 Excel/CSV/官方清单/手写，格式混乱）：\n${rawText.slice(0, 8000)}`
    : `从以下方案提取物料：\n${JSON.stringify(solution).slice(0, 8000)}`;

  const out = await llmJson<{ items: BomItem[]; unresolved_items: string[] }>({
    system: `你是电赛 BOM 规范化专家。把输入整理成规范物料清单：
1. mpn 使用规范完整型号（如 MSPM0G3507SPTR），能识别 manufacturer 就填
2. 区分 source_type：module（成品模块）还是 component（裸器件）
3. 同物异名合并、数量汇总
4. confidence 为型号识别置信度 0~1；不确定的型号如实给低分，禁止编造
5. 无法解析的行放 unresolved_items 原文保留
6. line_id 从 BOM-001 起编号`,
    messages: [{ role: "user", content: source }],
    maxTokens: 4096,
  });

  // 规则层：备料数量规则 + 人工审核标记（不经过 LLM）
  let items = applyQuantityRules(out.items || []);
  items = flagForReview(items);

  const needReview = items.filter((i) => i.needs_review).length;
  return {
    ok: true,
    artifact_type: "bom",
    output: { items, unresolved_items: out.unresolved_items || [] },
    human_review_required: needReview > 0,
    message: `整理出 ${items.length} 项${needReview ? `，${needReview} 项需人工确认（低置信度/替代料/功率风险）` : ""}`,
  };
});

// ============ Agent 10：备料规划（Procurement Planner）============
registerAgent("procurement_planner", async (input) => {
  const items: BomItem[] = input.items || [];
  if (!items.length) return { ok: false, output: null, message: "缺少 BOM items" };
  const index = await loadModuleIndex();

  // 库存匹配：模块库中已认证的同名/同芯片模块视为实验室可用
  const withInventory = items.map((it) => {
    const hit = Object.values(index).find(
      (m: any) =>
        m.certification_status !== "DRAFT" &&
        (m.main_chip?.toLowerCase().includes(it.mpn.toLowerCase().slice(0, 6)) ||
          m.name.includes(it.name))
    );
    return {
      ...it,
      inventory_status: (hit ? "available" : "unknown") as BomItem["inventory_status"],
      lab_module_id: (hit as any)?.id,
    };
  });

  const groups: Record<string, typeof withInventory> = {};
  for (const it of withInventory) {
    const g = it.group || "必须具备";
    (groups[g] ||= []).push(it);
  }

  return {
    ok: true,
    artifact_type: "procurement_plan",
    output: {
      groups,
      summary: {
        total_lines: withInventory.length,
        in_lab: withInventory.filter((i) => i.inventory_status === "available").length,
        to_purchase: withInventory.filter((i) => i.inventory_status !== "available").length,
      },
    },
  };
});
