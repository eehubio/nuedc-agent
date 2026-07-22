import type { z } from "zod";
import { route } from "./router";
import { policyFor, type TaskType } from "./task-policy";
import { recordCall } from "./health";
import { buildCacheKey, cacheGet, cacheSet, inputHash } from "./cache";
import { recordUsageEvent, checkBudget, estimateCost } from "./telemetry";
import { ProviderError, type ChatMessage } from "./providers";
import { getSystemMode, allowsPriority } from "../system-mode";
import { repairTruncatedJson } from "../llm";

/** 统一模型网关：所有 Agent 的唯一模型入口。
 *  Agent 不得自行拼 Provider URL，也不得自己决定用哪家模型。 */

export interface GatewayRequest<T = unknown> {
  taskType: TaskType;
  system: string;
  messages: ChatMessage[];
  /** 结构化输出的 Zod schema；提供后会做运行时校验 */
  schema?: z.ZodType<T>;
  projectId?: string | null;
  owner?: string | null;
  taskId?: string | null;
  tier?: string;
  json?: boolean;
  allowFallback?: boolean;
  allowCache?: boolean;
  maxOutputTokens?: number;
  providerHint?: string | null;
  /** 多模态输入 */
  pdfBase64?: string;
  imageBase64?: string;
  imageMime?: string;
  /** 参与缓存 key 的版本标识 */
  problemVersion?: string;
  moduleCatalogVersion?: string;
}

export interface GatewayResult<T = unknown> {
  ok: boolean;
  provider: string;
  model: string;
  output: T | null;
  rawText: string;
  usage: { inputTokens: number; outputTokens: number; cachedTokens: number };
  latency: number;
  cacheHit: boolean;
  fallbackUsed: boolean;
  retryCount: number;
  partial: boolean;
  validation: { ok: boolean; issues?: string[] };
  costEstimate: number;
  errorCode?: string;
  message?: string;
  /** 降级信息：模型不可用时供 UI 显示 */
  degraded?: { mode: string; reason: string };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function extractJson(raw: string): { parsed: any; partial: boolean } | null {
  const cleaned = raw.replace(/```json|```/g, "").trim();
  const s = cleaned.indexOf("{");
  const e = cleaned.lastIndexOf("}");
  const body = s >= 0 && e > s ? cleaned.slice(s, e + 1) : cleaned;
  try { return { parsed: JSON.parse(body), partial: false }; } catch { /* 尝试修复 */ }
  const repaired = repairTruncatedJson(cleaned);
  if (repaired) {
    try { return { parsed: JSON.parse(repaired), partial: true }; } catch { /* 修不好 */ }
  }
  return null;
}

export const modelGateway = {
  async run<T = unknown>(req: GatewayRequest<T>): Promise<GatewayResult<T>> {
    const policy = policyFor(req.taskType);
    const t0 = Date.now();
    const base: GatewayResult<T> = {
      ok: false, provider: "", model: "", output: null, rawText: "",
      usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
      latency: 0, cacheHit: false, fallbackUsed: false, retryCount: 0,
      partial: false, validation: { ok: false }, costEstimate: 0,
    };

    // 1) 系统模式门禁 —— 降级时明确告知，不白屏
    const mode = await getSystemMode();
    const gate = allowsPriority(mode, policy.priority);
    if (!gate.allowed) {
      return { ...base, errorCode: "SYSTEM_MODE", message: gate.reason, degraded: { mode, reason: gate.reason! }, latency: Date.now() - t0 };
    }

    // 2) 预算门禁
    if (req.owner) {
      const budgetErr = await checkBudget(req.owner, req.projectId);
      if (budgetErr) {
        return { ...base, errorCode: "BUDGET_EXCEEDED", message: budgetErr, degraded: { mode, reason: budgetErr }, latency: Date.now() - t0 };
      }
    }

    // 3) 选路
    const candidates = await route(policy, { hint: req.providerHint, needPdf: !!req.pdfBase64 });
    if (!candidates.length) {
      const reason = "所有模型服务当前不可用（未配置或已熔断）。项目数据、模块库、BOM、接口检查、测试评分与报告编辑仍可正常使用。";
      return { ...base, errorCode: "NO_PROVIDER", message: reason, degraded: { mode: "RULES_ONLY", reason }, latency: Date.now() - t0 };
    }

    // 4) 缓存（按最优候选的模型算 key）
    const allowCache = req.allowCache ?? policy.allowCache;
    const cacheKey = allowCache
      ? buildCacheKey({
          taskType: req.taskType, input: { s: req.system, m: req.messages }, projectId: req.projectId,
          problemVersion: req.problemVersion, moduleCatalogVersion: req.moduleCatalogVersion,
          model: candidates[0].model, scope: policy.cacheScope,
        })
      : "";
    if (allowCache && cacheKey) {
      const hit = await cacheGet(cacheKey);
      if (hit) {
        const parsedHit = req.json !== false ? extractJson(hit.output) : { parsed: hit.output, partial: false };
        const validated = req.schema && parsedHit ? req.schema.safeParse(parsedHit.parsed) : null;
        await recordUsageEvent({
          owner: req.owner, projectId: req.projectId, taskId: req.taskId, taskType: req.taskType,
          provider: hit.provider || "cache", model: hit.model, inputTokens: 0, outputTokens: 0,
          latencyMs: Date.now() - t0, status: "cache_hit", cacheHit: true,
        });
        return {
          ...base, ok: true, provider: hit.provider || "cache", model: hit.model,
          output: (validated?.success ? validated.data : parsedHit?.parsed) as T,
          rawText: hit.output, cacheHit: true, latency: Date.now() - t0,
          validation: { ok: validated ? validated.success : true },
        };
      }
    }

    // 5) 逐个候选调用，带重试与退避
    const maxOut = Math.min(req.maxOutputTokens ?? policy.maxOutputTokens, policy.maxOutputTokens);
    const allowFallback = req.allowFallback ?? true;
    let retryCount = 0;
    let fallbackUsed = false;
    let lastError: ProviderError | Error | null = null;

    for (let ci = 0; ci < candidates.length; ci++) {
      const { provider, model } = candidates[ci];
      if (ci > 0) fallbackUsed = true;

      for (let attempt = 0; attempt <= policy.maxRetries; attempt++) {
        const callStart = Date.now();
        try {
          const res = await provider.complete({
            system: req.system,
            messages: req.messages,
            maxOutputTokens: maxOut,
            temperature: policy.temperature,
            json: req.json !== false,
            thinkingBudget: policy.thinkingBudget,
            timeoutMs: policy.timeoutMs,
            pdfBase64: req.pdfBase64,
            imageBase64: req.imageBase64,
            imageMime: req.imageMime,
          }, model);

          const latencyMs = Date.now() - callStart;
          await recordCall({ provider: provider.id, ok: true, latencyMs });

          // 解析 + Schema 校验
          let output: any = res.text;
          let partial = res.truncated;
          let validation: { ok: boolean; issues?: string[] } = { ok: true };
          if (req.json !== false) {
            const parsed = extractJson(res.text);
            if (!parsed) {
              lastError = new Error("模型输出无法解析为 JSON");
              await recordUsageEvent({
                owner: req.owner, projectId: req.projectId, taskId: req.taskId, taskType: req.taskType,
                provider: provider.id, model, inputTokens: res.inputTokens, outputTokens: res.outputTokens,
                latencyMs, status: "error", errorCode: "PARSE_FAILED",
              });
              continue;   // 换下一次尝试
            }
            output = parsed.parsed;
            partial = partial || parsed.partial;
            if (req.schema) {
              const v = req.schema.safeParse(output);
              if (v.success) output = v.data;
              else validation = { ok: false, issues: v.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`) };
            }
          }

          const cost = await recordUsageEvent({
            owner: req.owner, projectId: req.projectId, taskId: req.taskId, taskType: req.taskType,
            provider: provider.id, model, inputTokens: res.inputTokens, outputTokens: res.outputTokens,
            latencyMs, status: "success", fallbackUsed,
          });

          // 只有完整且通过校验的结果才写缓存
          if (allowCache && cacheKey && !partial && validation.ok) {
            await cacheSet(cacheKey, policy, res.text, provider.id, model);
          }

          return {
            ok: true, provider: provider.id, model, output: output as T, rawText: res.text,
            usage: { inputTokens: res.inputTokens, outputTokens: res.outputTokens, cachedTokens: 0 },
            latency: Date.now() - t0, cacheHit: false, fallbackUsed, retryCount,
            partial, validation, costEstimate: cost,
          };
        } catch (e: any) {
          const latencyMs = Date.now() - callStart;
          const pe = e instanceof ProviderError ? e : new ProviderError(String(e?.message || e), "UNKNOWN", false);
          lastError = pe;
          await recordCall({ provider: provider.id, ok: false, latencyMs, errorCode: pe.code });
          await recordUsageEvent({
            owner: req.owner, projectId: req.projectId, taskId: req.taskId, taskType: req.taskType,
            provider: provider.id, model, inputTokens: 0, outputTokens: 0,
            latencyMs, status: "error", errorCode: pe.code, fallbackUsed,
          });

          if (!pe.retryable || attempt >= policy.maxRetries) break;   // 换 Provider
          retryCount++;
          // 指数退避 + 抖动，尊重 Retry-After
          const backoff = pe.retryAfterMs ?? Math.min(8000, 500 * 2 ** attempt) + Math.random() * 300;
          await sleep(backoff);
        }
      }
      if (!allowFallback) break;
    }

    const code = lastError instanceof ProviderError ? lastError.code : "UNKNOWN";
    return {
      ...base, retryCount, fallbackUsed, latency: Date.now() - t0,
      errorCode: code,
      message: `模型调用失败（${code}）：${lastError?.message || "未知原因"}`,
    };
  },

  inputHash,
};

export { policyFor, TASK_POLICIES, TASK_TYPES, AGENT_TASK_TYPE } from "./task-policy";
export type { TaskType } from "./task-policy";
export { routingSnapshot } from "./router";
export { healthSnapshot, enable as enableProvider, disable as disableProvider } from "./health";
export { usageSummary, checkBudget } from "./telemetry";
export { configuredProviders } from "./providers";
