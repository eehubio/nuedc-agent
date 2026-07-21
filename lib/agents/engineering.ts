// 工程类 Agent：方案架构、接口集成检查、BOM 整理、备料规划
import { llmJson } from "../llm";
import { registerAgent, loadModuleIndex, moduleCatalogForLlm } from "./base";
import { checkIntegration } from "../rules/integration-rules";
import { applyQuantityRules, flagForReview } from "../rules/procurement-rules";
import type { SolutionProposal, BomItem } from "../types";

// ============ Agent 8：系统方案架构（Solution Architect）============
// 生成两套候选方案；生成后立刻用规则引擎做接口预检，把结果附在方案上
registerAgent("solution_architect", async (input) => {
  const index = await loadModuleIndex();
  const catalog = moduleCatalogForLlm(index);
  const requirements = input.requirements;
  if (!requirements) return { ok: false, output: null, message: "缺少 requirements（先运行赛题理解 Agent）" };

  const out = await llmJson<{ candidate_solutions: SolutionProposal[]; recommended_solution: string; rationale: string }>({
    system: `你是电赛系统方案架构师。基于结构化需求生成 2 套候选方案（SOL-A / SOL-B），要求：
1. 优先使用模块目录中的模块（引用真实 module_id）；目录没有的写 module_id 为空并在 name 里说明
2. 每个 block 标注 covers_requirements（引用 REQ id）；未覆盖的需求列入 uncovered_requirements
3. connections 写清接口端点（形如 "K230.UART1_TX" → "MSPM0.UART0_RX"）、protocol、voltage_from/voltage_to
4. power_tree 写清每条电源轨的电压、来源、负载和电流预算 budget_ma
5. 两套方案在主控/算法/实现路径上要有真实差异，各自给出优缺点、风险等级、预计实现小时数
6. 四天三夜可完成性是第一约束
模块目录：
${catalog || "（模块库为空，允许方案使用通用模块名，module_id 留空）"}`,
    messages: [{ role: "user", content: `结构化需求：\n${JSON.stringify(requirements).slice(0, 8000)}\n补充约束：${input.constraints || "无"}` }],
    maxTokens: 6144,
    temperature: 0.5,
  });

  // 生成后立即做规则预检（需求覆盖 + 接口兼容），结果附在每套方案上
  const solutions = (out.candidate_solutions || []).map((sol) => {
    const integration = checkIntegration(sol, index);
    return { ...sol, integration_precheck: integration };
  });

  return {
    ok: true,
    artifact_type: "solution_proposal",
    output: { ...out, candidate_solutions: solutions },
    human_review_required: true, // 候选方案必须人工确认才能变成最终方案
    message: `生成 ${solutions.length} 套候选方案，请人工确认后进入 BOM/代码阶段`,
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
