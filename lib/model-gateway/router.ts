import { PROVIDERS, getProvider, type Provider } from "./providers";
import { isAvailable } from "./health";
import type { TaskPolicy } from "./task-policy";

/** 选路：按任务偏好 + 环境配置 + 健康状态挑选 Provider 顺序。
 *  业务代码不判断 provider 字符串，一切由此处决定。 */

function envList(name: string): string[] {
  return (process.env[name] || "").split(",").map((s) => s.trim()).filter(Boolean);
}

/** 质量优先链：主模型在前 */
function qualityChain(): string[] {
  const primary = process.env.MODEL_PROVIDER_PRIMARY || "gemini";
  const fallbacks = envList("MODEL_PROVIDER_FALLBACK");
  return [primary, ...fallbacks];
}

/** 单次任务的预计成本（美元）：按该任务实际的输入/输出 token 配比估算，
 *  而不是简单相加单价 —— 输出昂贵的模型在长输出任务上才真的贵。 */
export function estimateTaskCost(
  pricing: { inputPerMillion: number; outputPerMillion: number },
  expectedInputTokens: number,
  expectedOutputTokens: number,
): number {
  return (expectedInputTokens / 1e6) * pricing.inputPerMillion
       + (expectedOutputTokens / 1e6) * pricing.outputPerMillion;
}

/** 低成本优先链：按「该任务的预计花费」排序，定价未知者不参与自动排序 */
function cheapChain(policy?: TaskPolicy): string[] {
  const explicit = envList("MODEL_PROVIDER_CHEAP");
  if (explicit.length) return [...explicit, ...qualityChain()];

  const priced = Object.values(PROVIDERS)
    .filter((p) => p.isConfigured() && p.id !== "mock" && p.pricing !== null);
  const expIn = policy?.maxInputTokens ?? 4000;
  const expOut = policy?.maxOutputTokens ?? 2000;
  const byCost = [...priced].sort((a, b) =>
    estimateTaskCost(a.pricing!, expIn, expOut) - estimateTaskCost(b.pricing!, expIn, expOut));

  // 定价未知的排在有定价的之后（可用但不优先）
  const unpriced = Object.values(PROVIDERS)
    .filter((p) => p.isConfigured() && p.id !== "mock" && p.pricing === null)
    .map((p) => p.id);
  const ids = [...byCost.map((p) => p.id), ...unpriced];
  return ids.length ? ids : qualityChain();
}

/** 多模态链：只保留有 vision/pdf 能力的 */
function visionChain(): string[] {
  const all = [...envList("MODEL_PROVIDER_VISION"), ...qualityChain(), ...cheapChain()];
  return all.filter((id) => {
    const p = getProvider(id);
    return p?.capabilities.vision || p?.capabilities.pdf;
  });
}

export interface RouteCandidate {
  provider: Provider;
  model: string;
  /** 选中理由，供运营后台解释"为什么用这个模型" */
  reason: string;
}

/** 返回按优先级排序的候选 Provider（已过滤未配置与熔断中的）。 */
export async function route(policy: TaskPolicy, opts: { hint?: string | null; needPdf?: boolean } = {}): Promise<RouteCandidate[]> {
  // mock 优先级最高（压测/本地开发）
  if (process.env.ENABLE_MOCK_PROVIDER === "1") {
    const mock = getProvider("mock")!;
    return [{ provider: mock, model: mock.modelFor("text"), reason: "ENABLE_MOCK_PROVIDER=1（压测/开发模式）" }];
  }

  let chain: string[];
  let reason: string;
  if (policy.preference === "vision") { chain = visionChain(); reason = "任务需要多模态能力"; }
  else if (policy.preference === "cheap") { chain = cheapChain(policy); reason = `低成本优先（按 ${policy.maxInputTokens}/${policy.maxOutputTokens} token 配比估算）`; }
  else { chain = qualityChain(); reason = "质量优先（主模型在前）"; }

  if (opts.hint) chain = [opts.hint, ...chain];
  // 质量任务在链尾补上其他已配置 Provider 作为最后手段
  chain = [...chain, ...Object.keys(PROVIDERS).filter((id) => id !== "mock")];

  const seen = new Set<string>();
  const out: RouteCandidate[] = [];
  for (const id of chain) {
    if (seen.has(id)) continue;
    seen.add(id);
    const p = getProvider(id);
    if (!p || !p.isConfigured()) continue;
    if (opts.needPdf && !p.capabilities.pdf) continue;
    if (!(await isAvailable(id))) continue;      // 熔断中跳过
    const kind = policy.preference === "vision" ? (opts.needPdf ? "ocr" : "vision") : "text";
    const model = p.modelFor(kind as any);
    if (!model) continue;
    const why = opts.hint === id ? "调用方显式指定"
      : out.length === 0 ? reason
      : `容灾候补 #${out.length}（${reason}）`;
    out.push({ provider: p, model, reason: why });
  }
  return out;
}

/** 诊断用：当前可用 Provider 概览 */
export async function routingSnapshot() {
  const rows = await Promise.all(Object.values(PROVIDERS).map(async (p) => ({
    id: p.id, label: p.label, configured: p.isConfigured(),
    available: p.isConfigured() ? await isAvailable(p.id) : false,
    capabilities: p.capabilities,
    models: { text: p.modelFor("text"), vision: p.modelFor("vision") },
    pricing: p.pricing,
  })));
  return {
    primary: process.env.MODEL_PROVIDER_PRIMARY || "gemini",
    fallback: envList("MODEL_PROVIDER_FALLBACK"),
    cheapChain: cheapChain(),
    providers: rows,
  };
}
