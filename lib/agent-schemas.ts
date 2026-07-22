import { z } from "zod";

/** LLM 输出的运行时校验（诊断 P0-4）。
 *  llmJson 的泛型只是编译期提示，模型完全可能返回 {"items":"none"} 这种东西。
 *  这里做宽松但有效的校验：类型对不上就修正或剔除，结构性缺失才判失败。 */

export const requirementSchema = z.object({
  id: z.string(),
  type: z.string().optional(),
  description: z.string(),
  target: z.union([z.number(), z.string()]).nullish(),
  unit: z.string().nullish(),
  tolerance: z.string().nullish(),
  priority: z.string().optional(),
  source: z.string().optional(),
  verification_method: z.string().optional(),
  status: z.string().optional(),
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

export const solutionSchema = z.object({
  solution_id: z.string(),
  name: z.string(),
  summary: z.string().default(""),
  blocks: z.array(solutionBlockSchema).min(1),
  connections: z.array(z.any()).default([]),
  power_tree: z.array(z.any()).default([]),
  advantages: z.array(z.string()).default([]),
  disadvantages: z.array(z.string()).default([]),
  risk_level: z.string().default("medium"),
  implementation_hours: z.number().default(0),
  uncovered_requirements: z.array(z.string()).default([]),
});

// 数量字段模型常写成 "很多"/"2块" —— 强制转数字，转不出来判为需人工确认
const quantity = z.preprocess((v) => {
  if (typeof v === "number") return v;
  const n = parseFloat(String(v ?? "").replace(/[^\d.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : 1;
}, z.number().positive());

export const bomItemSchema = z.object({
  line_id: z.string().default(""),
  mpn: z.string().default(""),
  name: z.string(),
  manufacturer: z.string().optional(),
  category: z.string().default("other.misc"),
  package: z.string().optional(),
  quantity,
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
