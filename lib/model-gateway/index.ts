import type { z } from "zod";
import { route } from "./router";
import { policyFor, type TaskType } from "./task-policy";
import { recordCall } from "./health";
import { recordTaskCall, taskTypeHealthy } from "./task-health";
import { buildCacheKey, cacheGet, cacheSet, cacheDelete, inputHash, taskDedupKey } from "./cache";
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
  /** 指定 Provider。仅 admin / worker / 系统内部可用；
   *  普通用户请求传入会被忽略（否则可指定贵模型刷成本）。 */
  providerHint?: string | null;
  /** 调用来源，决定 providerHint 是否被采纳 */
  caller?: "user" | "admin" | "worker" | "system";
  /** 多模态输入 */
  pdfBase64?: string;
  imageBase64?: string;
  imageMime?: string;
  /** 参与缓存 key 的版本标识 */
  problemVersion?: string;
  moduleCatalogVersion?: string;
  /** 外部取消信号，透传给 Provider，触发后正在进行的调用被 abort */
  signal?: AbortSignal;
}

export interface GatewayResult<T = unknown> {
  ok: boolean;
  provider: string;
  model: string;
  /** 为什么选中这个模型（运营后台可解释性） */
  routingReason?: string;
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
    // providerHint 权限控制：非特权调用方的指定一律忽略
    const hintAllowed = req.caller === "admin" || req.caller === "worker" || req.caller === "system"
      || process.env.ALLOW_USER_PROVIDER_HINT === "1";
    const effectiveHint = hintAllowed ? req.providerHint : null;
    const candidates = await route(policy, { hint: effectiveHint, needPdf: !!req.pdfBase64 });
    if (!candidates.length) {
      const reason = "所有模型服务当前不可用（未配置或已熔断）。项目数据、模块库、BOM、接口检查、测试评分与报告编辑仍可正常使用。";
      return { ...base, errorCode: "NO_PROVIDER", message: reason, degraded: { mode: "RULES_ONLY", reason }, latency: Date.now() - t0 };
    }

    // 按 TaskType 质量健康过滤：schema/parse 长期失败的 Provider 不再承担该 TaskType，
    // 即便它 HTTP 一直 200。至少保留一个候选（全不健康时降级用第一候选，避免完全无服务）。
    let usable = candidates;
    try {
      const flags = await Promise.all(candidates.map((c) => taskTypeHealthy(c.provider.id, c.model, req.taskType)));
      const filtered = candidates.filter((_, i) => flags[i]);
      if (filtered.length) usable = filtered;
    } catch { /* 健康表不可用时不过滤 */ }

    // 4) 缓存：按候选逐个查各自的 key（缓存归属实际产出者，不能只查第一候选）
    const allowCache = req.allowCache ?? policy.allowCache;
    const keyFor = (provider: string, model: string) => buildCacheKey({
      taskType: req.taskType, input: { s: req.system, m: req.messages }, projectId: req.projectId,
      problemVersion: req.problemVersion, moduleCatalogVersion: req.moduleCatalogVersion,
      provider, model, scope: policy.cacheScope,
    });

    if (allowCache) {
      for (const c of candidates) {
        const k = keyFor(c.provider.id, c.model);
        const hit = await cacheGet(k);
        if (!hit) continue;

        const parsedHit = req.json !== false ? extractJson(hit.output) : { parsed: hit.output, partial: false };
        let hitOutput: any = parsedHit?.parsed;
        let hitValid = true;
        let hitIssues: string[] | undefined;
        if (req.schema && parsedHit) {
          const v = req.schema.safeParse(parsedHit.parsed);
          if (v.success) hitOutput = v.data;
          else {
            hitValid = false;
            hitIssues = v.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`);
          }
        }
        // 缓存内容已不符合当前 schema（如 schema 升级）→ 丢弃该缓存并继续走真实调用
        if (!hitValid && policy.schemaMode === "strict") {
          await cacheDelete(k);
          continue;
        }
        if (!parsedHit) { await cacheDelete(k); continue; }

        await recordUsageEvent({
          owner: req.owner, projectId: req.projectId, taskId: req.taskId, taskType: req.taskType,
          provider: hit.provider || c.provider.id, model: hit.model || c.model,
          inputTokens: 0, outputTokens: 0, latencyMs: Date.now() - t0, status: "cache_hit", cacheHit: true,
        });
        return {
          ...base, ok: true, provider: hit.provider || c.provider.id, model: hit.model || c.model,
          output: hitOutput as T, rawText: hit.output, cacheHit: true, latency: Date.now() - t0,
          validation: { ok: hitValid, issues: hitIssues },
        };
      }
    }

    // 5) 逐个候选调用，带重试与退避
    const maxOut = Math.min(req.maxOutputTokens ?? policy.maxOutputTokens, policy.maxOutputTokens);
    const allowFallback = req.allowFallback ?? true;
    let retryCount = 0;
    let fallbackUsed = false;
    let lastError: ProviderError | Error | null = null;
    let lastErrorCode: string | null = null;
    let lastValidation: { ok: boolean; issues?: string[] } | null = null;

    for (let ci = 0; ci < usable.length; ci++) {
      const { provider, model } = usable[ci];
      if (ci > 0) fallbackUsed = true;

      for (let attempt = 0; attempt <= policy.maxRetries; attempt++) {
        const callStart = Date.now();
        // 已被取消：不再发起新的 Provider 调用，直接返回 CANCELED
        if (req.signal?.aborted) {
          return { ...base, errorCode: "CANCELED", message: "请求已取消", retryCount, fallbackUsed, latency: Date.now() - t0 };
        }
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
            signal: req.signal,
          }, model);

          const latencyMs = Date.now() - callStart;
          await recordCall({ provider: provider.id, ok: true, latencyMs });
          // 传输层成功（HTTP 200 且拿到响应）
          await recordTaskCall({ provider: provider.id, model, taskType: req.taskType, dimension: "transport", ok: true });

          // 解析 + Schema 校验
          let output: any = res.text;
          let partial = res.truncated;
          let validation: { ok: boolean; issues?: string[] } = { ok: true };
          if (req.json !== false) {
            const parsed = extractJson(res.text);
            if (!parsed) {
              lastError = new Error("模型输出无法解析为 JSON");
              await recordTaskCall({ provider: provider.id, model, taskType: req.taskType, dimension: "parse", ok: false });
              await recordUsageEvent({
                owner: req.owner, projectId: req.projectId, taskId: req.taskId, taskType: req.taskType,
                provider: provider.id, model, inputTokens: res.inputTokens, outputTokens: res.outputTokens,
                latencyMs, status: "error", errorCode: "PARSE_FAILED",
              });
              continue;   // 换下一次尝试
            }
            await recordTaskCall({ provider: provider.id, model, taskType: req.taskType, dimension: "parse", ok: true });
            output = parsed.parsed;
            partial = partial || parsed.partial;
            if (req.schema && policy.schemaMode !== "none") {
              const v = req.schema.safeParse(output);
              if (v.success) { output = v.data; }
              else validation = { ok: false, issues: v.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`) };
              // 记录 schema 维度（strict/warn 都记，用于判定该 Provider 对该 TaskType 的可用性）
              await recordTaskCall({ provider: provider.id, model, taskType: req.taskType, dimension: "schema", ok: v.success });
            }
          }

          const cost = await recordUsageEvent({
            owner: req.owner, projectId: req.projectId, taskId: req.taskId, taskType: req.taskType,
            provider: provider.id, model, inputTokens: res.inputTokens, outputTokens: res.outputTokens,
            latencyMs, status: validation.ok ? "success" : "error",
            errorCode: validation.ok ? undefined : "SCHEMA_INVALID", fallbackUsed,
          });

          // strict 模式下 Schema 失败 = 调用失败：不缓存、不返回 ok，尝试下一次/下一家
          if (!validation.ok && policy.schemaMode === "strict") {
            lastError = new Error(`Schema 校验失败：${(validation.issues || []).join("；")}`);
            lastErrorCode = "SCHEMA_INVALID";
            lastValidation = validation;
            continue;
          }

          // 只有完整且通过校验的结果才写缓存，且归属到实际产出的 provider:model
          if (allowCache && !partial && validation.ok) {
            await cacheSet(keyFor(provider.id, model), policy, res.text, provider.id, model);
          }

          return {
            ok: true, provider: provider.id, model, routingReason: usable[ci].reason,
            output: output as T, rawText: res.text,
            usage: { inputTokens: res.inputTokens, outputTokens: res.outputTokens, cachedTokens: 0 },
            latency: Date.now() - t0, cacheHit: false, fallbackUsed, retryCount,
            partial, validation, costEstimate: cost,
          };
        } catch (e: any) {
          const latencyMs = Date.now() - callStart;
          // 取消：立即停止，不重试、不换 Provider
          if (e?.name === "AbortError" || (e instanceof ProviderError && e.code === "CANCELED") || req.signal?.aborted) {
            await recordCall({ provider: provider.id, ok: false, latencyMs, errorCode: "CANCELED" });
            return { ...base, errorCode: "CANCELED", message: "请求已取消", retryCount, fallbackUsed, latency: Date.now() - t0 };
          }
          const pe = e instanceof ProviderError ? e : new ProviderError(String(e?.message || e), "UNKNOWN", false);
          lastError = pe;
          await recordCall({ provider: provider.id, ok: false, latencyMs, errorCode: pe.code });
          // 传输层失败维度
          await recordTaskCall({ provider: provider.id, model, taskType: req.taskType, dimension: "transport", ok: false });
          if (pe.code === "TIMEOUT") await recordTaskCall({ provider: provider.id, model, taskType: req.taskType, dimension: "timeout" });
          if (pe.code === "RATE_LIMIT") await recordTaskCall({ provider: provider.id, model, taskType: req.taskType, dimension: "rate429" });
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

    const code = lastErrorCode || (lastError instanceof ProviderError ? lastError.code : "UNKNOWN");
    return {
      ...base, retryCount, fallbackUsed, latency: Date.now() - t0,
      errorCode: code,
      validation: lastValidation || { ok: false },
      message: code === "SCHEMA_INVALID"
        ? `模型输出不符合预期结构：${(lastValidation?.issues || []).join("；") || lastError?.message}`
        : `模型调用失败（${code}）：${lastError?.message || "未知原因"}`,
    };
  },

  inputHash,
  taskDedupKey,
};

export { policyFor, TASK_POLICIES, TASK_TYPES, AGENT_TASK_TYPE } from "./task-policy";
export type { TaskType } from "./task-policy";
export { routingSnapshot } from "./router";
export { healthSnapshot, enable as enableProvider, disable as disableProvider } from "./health";
export { taskHealthSnapshot } from "./task-health";
export { usageSummary, checkBudget } from "./telemetry";
export { configuredProviders } from "./providers";
