import { z } from "zod";

/** LLM 输出的运行时校验（诊断 P0-4）。
 *  llmJson 的泛型只是编译期提示，模型完全可能返回 {"items":"none"} 这种东西。
 *  这里做宽松但有效的校验：类型对不上就修正或剔除，结构性缺失才判失败。 */

/** 枚举归一：模型常写 "very important"/"probably confirmed" 这类自由文本，
 *  能映射的就归一，映射不了的落到安全默认值并标记需人工确认。 */
const REQ_TYPES = ["functional", "performance", "constraint", "bonus", "scoring"] as const;
const REQ_PRIORITIES = ["mandatory", "bonus"] as const;
const REQ_STATUSES = ["AI_EXTRACTED", "NEEDS_REVIEW", "CONFIRMED", "REJECTED", "AMBIGUOUS"] as const;
const VERIFY_METHODS = ["measurement", "demonstration", "inspection", "analysis"] as const;

const normEnum = <T extends readonly string[]>(allowed: T, fallback: T[number], alias: Record<string, T[number]> = {}) =>
  z.preprocess((v) => {
    const raw = String(v ?? "").trim().toLowerCase();
    if (!raw) return fallback;
    const hit = allowed.find((a) => a.toLowerCase() === raw);
    if (hit) return hit;
    for (const [k, target] of Object.entries(alias)) if (raw.includes(k)) return target;
    return fallback;
  }, z.enum(allowed as unknown as [string, ...string[]]));

export const requirementSchema = z.object({
  id: z.string(),
  type: normEnum(REQ_TYPES, "functional", {
    perf: "performance", 指标: "performance", constraint: "constraint", 约束: "constraint",
    bonus: "bonus", 发挥: "bonus", scor: "scoring", 评分: "scoring",
  }),
  description: z.string(),
  target: z.union([z.number(), z.string()]).nullish(),
  unit: z.string().nullish(),
  tolerance: z.string().nullish(),
  priority: normEnum(REQ_PRIORITIES, "mandatory", {
    must: "mandatory", 基本: "mandatory", required: "mandatory", important: "mandatory",
    bonus: "bonus", optional: "bonus", 发挥: "bonus", nice: "bonus",
  }),
  source: z.string().optional(),
  source_page: z.union([z.number(), z.string()]).nullish(),
  verification_method: normEnum(VERIFY_METHODS, "measurement", {
    measur: "measurement", 测量: "measurement", demo: "demonstration", 演示: "demonstration",
    inspect: "inspection", 检查: "inspection", analy: "analysis", 分析: "analysis",
  }),
  status: normEnum(REQ_STATUSES, "AI_EXTRACTED", {
    confirm: "CONFIRMED", 确认: "CONFIRMED", reject: "REJECTED", 驳回: "REJECTED",
    ambig: "AMBIGUOUS", 歧义: "AMBIGUOUS", review: "NEEDS_REVIEW",
  }),
});

export const scoringItemSchema = z.object({
  item: z.string(),
  points: z.number().nullable().optional(),
  points_type: z.enum(["official", "estimated"]).optional(),
  requirement_ids: z.array(z.string()).default([]),
  source: z.string().optional(),
});

export const problemInterpretationSchema = z.object({
  project_name: z.string().optional(),
  system_overview: z.string().optional(),
  requirements: z.array(requirementSchema).default([]),
  scoring_items: z.array(scoringItemSchema).default([]),
  ambiguities: z.array(z.any()).default([]),
});

export const solutionBlockSchema = z.object({
  block_id: z.string(),
  name: z.string(),
  module_id: z.string().default(""),
  role: z.string().default(""),
  covers_requirements: z.array(z.string()).default([]),
});

/** 连线：规则引擎最依赖的结构，必须真校验（诊断第三节 1） */
export const connectionSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  from_block_id: z.string().optional(),
  from_interface_id: z.string().optional(),
  to_block_id: z.string().optional(),
  to_interface_id: z.string().optional(),
  protocol: z.string().default("GPIO"),
  voltage_from: z.preprocess((v) => (v == null || v === "" ? null : Number(v)), z.number().nullable()),
  voltage_to: z.preprocess((v) => (v == null || v === "" ? null : Number(v)), z.number().nullable()),
  baudrate: z.preprocess((v) => (v == null || v === "" ? null : Number(v)), z.number().nullable()).optional(),
});

/** 电源轨：预算必须是数字，否则电源检查会静默失效 */
export const powerRailSchema = z.object({
  rail: z.string().min(1),
  voltage: z.preprocess((v) => Number(v), z.number()),
  source: z.string().default(""),
  loads: z.array(z.string()).default([]),
  budget_ma: z.preprocess((v) => (v == null || v === "" ? null : Number(v)), z.number().nullable()),
});

export const solutionSchema = z.object({
  solution_id: z.string(),
  name: z.string(),
  summary: z.string().default(""),
  blocks: z.array(solutionBlockSchema).min(1),
  connections: z.array(z.any()).default([]),      // 逐项用 connectionSchema 过滤（见 normalizeSolution）
  power_tree: z.array(z.any()).default([]),       // 逐项用 powerRailSchema 过滤
  advantages: z.array(z.string()).default([]),
  disadvantages: z.array(z.string()).default([]),
  risk_level: z.string().default("medium"),
  implementation_hours: z.number().default(0),
  uncovered_requirements: z.array(z.string()).default([]),
});

// 数量：能解析就转数字；解析不了（"若干"/"视情况"）保留 null 交人工确认，
// 绝不悄悄猜成 1（诊断第三节 3：猜错比报错更危险）
const quantity = z.preprocess((v) => {
  if (typeof v === "number" && v > 0) return v;
  const n = parseFloat(String(v ?? "").replace(/[^\d.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}, z.number().positive().nullable());

export const bomItemSchema = z.object({
  line_id: z.string().default(""),
  mpn: z.string().default(""),
  name: z.string(),
  manufacturer: z.string().optional(),
  category: z.string().default("other.misc"),
  package: z.string().optional(),
  quantity,
  quantity_raw: z.union([z.string(), z.number()]).nullish(),   // 保留原文供人工判断
  source_type: z.enum(["component", "module"]).default("component"),
  inventory_status: z.string().optional(),
  substitutes: z.array(z.string()).default([]),
  unit_price: z.number().nullish(),
  purchase_url: z.string().optional(),
  confidence: z.preprocess((v) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.5;
  }, z.number()),
  needs_review: z.boolean().optional(),
});

export const bomOutputSchema = z.object({
  items: z.array(bomItemSchema).default([]),
  unresolved_items: z.array(z.string()).default([]),
});

export const codeFileSchema = z.object({
  path: z.string(),
  language: z.string().default("c"),
  content: z.string().min(1),
  notes: z.string().default(""),
});

export const codeBundleSchema = z.object({
  plan: z.array(z.any()).default([]),
  files: z.array(codeFileSchema).min(1),
  integration_notes: z.array(z.string()).default([]),
  unsupported_items: z.array(z.string()).default([]),
});

/** 宽松校验：逐项过滤掉不合法的数组元素，保留合法部分；
 *  返回 { data, dropped }，dropped > 0 说明模型输出有脏数据。 */
export function parseArrayLoose<T>(schema: z.ZodType<T>, raw: unknown): { data: T[]; dropped: number } {
  if (!Array.isArray(raw)) return { data: [], dropped: 0 };
  const data: T[] = [];
  let dropped = 0;
  for (const item of raw) {
    const r = schema.safeParse(item);
    if (r.success) data.push(r.data); else dropped++;
  }
  return { data, dropped };
}
