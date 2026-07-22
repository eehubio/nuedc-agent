/** Provider 统一适配接口。业务代码永远不判断 provider 字符串。 */

export interface ChatMessage { role: "user" | "assistant"; content: string }

export interface ProviderRequest {
  system: string;
  messages: ChatMessage[];
  maxOutputTokens: number;
  temperature: number;
  json: boolean;              // 要求结构化 JSON 输出
  thinkingBudget?: number;    // 0 = 关闭思考（支持的 Provider 才生效）
  timeoutMs: number;
  pdfBase64?: string;         // 多模态：PDF 输入
  imageBase64?: string;
  imageMime?: string;
}

export interface ProviderResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
  finishReason?: string;
  truncated: boolean;
}

/** Provider 抛出的标准化错误，供熔断与重试判定 */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly code: "RATE_LIMIT" | "TIMEOUT" | "AUTH" | "MODEL_NOT_FOUND" | "REGION_BLOCKED" | "SAFETY" | "SERVER" | "UNKNOWN",
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) { super(message); this.name = "ProviderError"; }
}

export interface ProviderCapabilities {
  vision: boolean;            // 能读图片
  pdf: boolean;               // 能直接读 PDF
  jsonMode: boolean;          // 原生 JSON 输出模式
  thinkingControl: boolean;   // 可控制思考预算
}

export interface Provider {
  readonly id: string;
  readonly label: string;
  readonly capabilities: ProviderCapabilities;
  /** 每百万 token 价格（美元），用于成本估算；未知填 0 */
  readonly pricing: { inputPerMillion: number; outputPerMillion: number };
  isConfigured(): boolean;
  modelFor(kind: "text" | "vision" | "ocr"): string;
  complete(req: ProviderRequest, model: string): Promise<ProviderResponse>;
}

/** 从 HTTP 状态与响应体推断标准错误码 */
export function classifyHttpError(status: number, body: string): ProviderError {
  const snippet = body.slice(0, 300);
  if (status === 429) {
    const m = body.match(/retry[- ]?after[":\s]+(\d+)/i);
    return new ProviderError(`限流：${snippet}`, "RATE_LIMIT", true, m ? Number(m[1]) * 1000 : undefined);
  }
  if (status === 401 || status === 403) {
    if (/region|country|location|not available/i.test(body)) {
      return new ProviderError(`区域限制：${snippet}`, "REGION_BLOCKED", false);
    }
    return new ProviderError(`认证失败：${snippet}`, "AUTH", false);
  }
  if (status === 404) return new ProviderError(`模型不存在：${snippet}`, "MODEL_NOT_FOUND", false);
  if (status >= 500) return new ProviderError(`服务端错误 ${status}：${snippet}`, "SERVER", true);
  return new ProviderError(`HTTP ${status}：${snippet}`, "UNKNOWN", false);
}

/** 带超时的 fetch */
export async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } catch (e: any) {
    if (e?.name === "AbortError") throw new ProviderError(`请求超时（${timeoutMs}ms）`, "TIMEOUT", true);
    throw new ProviderError(`网络错误：${e?.message || e}`, "SERVER", true);
  } finally { clearTimeout(timer); }
}
