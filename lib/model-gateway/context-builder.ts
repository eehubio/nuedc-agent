/** 上下文组装：按优先级选择信息并产出 contextManifest。
 *  禁止 JSON.stringify(largeObject).slice(...) —— 那会静默截断且用户无感知。 */

export interface ContextManifest {
  includedRequirementIds: string[];
  omittedRequirementIds: string[];
  includedModuleIds: string[];
  omittedModuleCount: number;
  estimatedTokens: number;
}

/** 粗略 token 估算：中文约 1.5 字/token，英文约 4 字符/token */
export function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  return Math.ceil(cjk / 1.5 + (text.length - cjk) / 4);
}

export interface BuildOptions {
  requirements: any[];
  modules?: any[];
  constraints?: string;
  previousDecisions?: string[];
  budgetTokens: number;
  maxModules?: number;
}

/** 优先级顺序：
 *  1 必选基本要求 → 2 已选发挥项 → 3 安全约束 → 4 评分项 → 5 用户约束
 *  → 6 候选模块 → 7 既往决策 → 8 其余 */
export function buildContext(opts: BuildOptions): { text: string; manifest: ContextManifest } {
  const compact = (r: any) => ({
    id: r.id,
    d: String(r.description || "").slice(0, 120),
    ...(r.target != null ? { t: r.target } : {}),
    ...(r.unit ? { u: r.unit } : {}),
    ...(r.tolerance ? { tol: r.tolerance } : {}),
    p: r.priority === "mandatory" ? "M" : "B",
  });

  const active = (opts.requirements || []).filter((r) => r.status !== "REJECTED");
  const safety = active.filter((r) => /安全|隔离|保护|高压|并网|过流|过压/.test(String(r.description)));
  const mandatory = active.filter((r) => r.priority === "mandatory" && !safety.includes(r));
  const selectedBonus = active.filter((r) => r.priority !== "mandatory" && r.status === "CONFIRMED");
  const rest = active.filter((r) => !safety.includes(r) && !mandatory.includes(r) && !selectedBonus.includes(r));
  const ordered = [...safety, ...mandatory, ...selectedBonus, ...rest];

  const included: any[] = [];
  const omitted: string[] = [];
  let used = 0;
  const reserve = Math.floor(opts.budgetTokens * 0.35);   // 给模块目录与约束留额度

  for (const r of ordered) {
    const piece = JSON.stringify(compact(r));
    const cost = estimateTokens(piece);
    if (used + cost <= opts.budgetTokens - reserve) { included.push(compact(r)); used += cost; }
    else omitted.push(r.id);
  }

  // 模块目录：程序已过滤过的 top K 才进来
  const maxModules = opts.maxModules ?? 20;
  const mods = (opts.modules || []).slice(0, maxModules);
  const omittedModuleCount = Math.max(0, (opts.modules || []).length - mods.length);
  const modText = mods.map((m: any) =>
    `- ${m.id} | ${m.name} | ${m.main_chip ?? "?"} | ${(m.interfaces || []).map((i: any) => `${i.name}:${i.interface_type}@${i.voltage_level ?? "?"}V`).join(",")} | ${m.certification_status ?? ""}`
  ).join("\n");

  const parts = [
    `需求（共 ${active.length} 条，纳入 ${included.length} 条；M=基本 B=发挥）：\n${JSON.stringify(included)}`,
    omitted.length ? `未纳入本次上下文的需求（请在 uncovered_requirements 中原样列出）：${omitted.join("、")}` : "",
    opts.constraints ? `用户约束：${opts.constraints}` : "",
    mods.length ? `候选模块（已按类别/电压/接口/证据等级筛选）：\n${modText}${omittedModuleCount ? `\n（另有 ${omittedModuleCount} 个模块未列出）` : ""}` : "",
    opts.previousDecisions?.length ? `既往决策：${opts.previousDecisions.slice(0, 5).join("；")}` : "",
  ].filter(Boolean);

  const text = parts.join("\n\n");
  return {
    text,
    manifest: {
      includedRequirementIds: included.map((r) => r.id),
      omittedRequirementIds: omitted,
      includedModuleIds: mods.map((m: any) => m.id),
      omittedModuleCount,
      estimatedTokens: estimateTokens(text),
    },
  };
}

/** 模块预筛选：程序过滤 → top K，避免把整库送进模型 */
export function preFilterModules(all: any[], opts: {
  requirements?: any[]; preferred?: string[]; voltage?: number; interfaces?: string[]; limit?: number;
}): any[] {
  const CERT_RANK: Record<string, number> = {
    COMPETITION_READY: 0, BENCHMARKED: 1, FUNCTION_TESTED: 2, POWER_TESTED: 3, DOCUMENTED: 4, DRAFT: 5, DEPRECATED: 9,
  };
  const preferred = new Set(opts.preferred || []);
  const keywords = (opts.requirements || [])
    .flatMap((r) => String(r.description || "").match(/[\u4e00-\u9fff]{2,6}|[A-Za-z]{3,}/g) || [])
    .map((w) => w.toLowerCase());

  const scored = all.map((m: any) => {
    let score = 0;
    if (preferred.has(m.id)) score += 100;
    score += (10 - (CERT_RANK[m.certification_status] ?? 6)) * 2;
    // 关键词与模块名/芯片/标签的重合度（程序侧粗排，避免语义检索开销）
    const hay = `${m.name} ${m.main_chip ?? ""} ${(m.tags || []).join(" ")} ${m.category ?? ""}`.toLowerCase();
    for (const k of keywords) if (k.length > 1 && hay.includes(k)) score += 3;
    if (opts.interfaces?.length) {
      const has = (m.interfaces || []).some((i: any) => opts.interfaces!.includes(i.interface_type));
      if (has) score += 5;
    }
    if (opts.voltage && m.power?.input_voltage_range) {
      const [lo, hi] = m.power.input_voltage_range;
      if (opts.voltage >= lo && opts.voltage <= hi) score += 3;
    }
    return { m, score };
  });

  return scored.sort((a, b) => b.score - a.score).slice(0, opts.limit ?? 20).map((x) => x.m);
}
