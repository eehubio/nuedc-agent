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

/** 低成本优先链：便宜的在前（按已配置 Provider 的实际单价排序） */
function cheapChain(): string[] {
  const explicit = envList("MODEL_PROVIDER_CHEAP");
  if (explicit.length) return [...explicit, ...qualityChain()];
  const configured = Object.values(PROVIDERS).filter((p) => p.isConfigured() && p.id !== "mock");
  const byPrice = [...configured].sort((a, b) =>
    (a.pricing.inputPerMillion + a.pricing.outputPerMillion) - (b.pricing.inputPerMillion + b.pricing.outputPerMillion));
  const ids = byPrice.map((p) => p.id);
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

export interface RouteCandidate { provider: Provider; model: string }

/** 返回按优先级排序的候选 Provider（已过滤未配置与熔断中的）。 */
export async function route(policy: TaskPolicy, opts: { hint?: string | null; needPdf?: boolean } = {}): Promise<RouteCandidate[]> {
  // mock 优先级最高（压测/本地开发）
  if (process.env.ENABLE_MOCK_PROVIDER === "1") {
    const mock = getProvider("mock")!;
    return [{ provider: mock, model: mock.modelFor("text") }];
  }

  let chain: string[];
  if (policy.preference === "vision") chain = visionChain();
  else if (policy.preference === "cheap") chain = cheapChain();
  else chain = qualityChain();

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
    out.push({ provider: p, model });
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
