import {
  type Provider, type ProviderRequest, type ProviderResponse, type ProviderCapabilities,
  ProviderError, classifyHttpError, fetchWithTimeout,
} from "./base";

/** OpenAI 兼容 Provider 工厂。
 *  国内主流厂商（通义千问 DashScope、DeepSeek、智谱、Moonshot、MiniMax、百川…）
 *  以及自建 vLLM/Ollama 网关，几乎都提供 /chat/completions 兼容端点，
 *  因此一个适配器 + 环境变量即可接入任意厂商，不锁定供应商。 */
export function createOpenAICompatibleProvider(cfg: {
  id: string;
  label: string;
  envPrefix: string;               // 如 "QWEN" → QWEN_API_KEY / QWEN_BASE_URL / QWEN_MODEL_TEXT
  defaultBaseUrl?: string;
  defaultTextModel?: string;
  defaultVisionModel?: string;
  capabilities?: Partial<ProviderCapabilities>;
  pricing?: { inputPerMillion: number; outputPerMillion: number };
}): Provider {
  const env = (suffix: string) => process.env[`${cfg.envPrefix}_${suffix}`];

  return {
    id: cfg.id,
    label: cfg.label,
    capabilities: {
      vision: true, pdf: false, jsonMode: true, thinkingControl: false,
      ...(cfg.capabilities || {}),
    },
    pricing: cfg.pricing ?? null,   // 未声明定价 = 未知，不参与低价排序

    isConfigured: () => !!env("API_KEY"),

    modelFor(kind) {
      if (kind === "vision" || kind === "ocr") {
        return env("MODEL_VISION") || cfg.defaultVisionModel || env("MODEL_TEXT") || cfg.defaultTextModel || "";
      }
      return env("MODEL_TEXT") || env("MODEL") || cfg.defaultTextModel || "";
    },

    async complete(req: ProviderRequest, model: string): Promise<ProviderResponse> {
      const key = env("API_KEY");
      if (!key) throw new ProviderError(`未配置 ${cfg.envPrefix}_API_KEY`, "AUTH", false);
      const baseUrl = (env("BASE_URL") || cfg.defaultBaseUrl || "").replace(/\/+$/, "");
      if (!baseUrl) throw new ProviderError(`未配置 ${cfg.envPrefix}_BASE_URL`, "AUTH", false);

      // 多模态：OpenAI 兼容格式用 image_url + data URI
      const lastIdx = req.messages.length - 1;
      const messages: any[] = [
        { role: "system", content: req.system },
        ...req.messages.map((m, i) => {
          if (i === lastIdx && (req.imageBase64 || req.pdfBase64)) {
            const content: any[] = [{ type: "text", text: m.content }];
            if (req.imageBase64) {
              content.unshift({ type: "image_url", image_url: { url: `data:${req.imageMime || "image/png"};base64,${req.imageBase64}` } });
            }
            return { role: m.role, content };
          }
          return { role: m.role, content: m.content };
        }),
      ];

      const res = await fetchWithTimeout(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: req.maxOutputTokens,
          temperature: req.temperature,
          ...(req.json ? { response_format: { type: "json_object" } } : {}),
        }),
      }, req.timeoutMs);

      if (!res.ok) throw classifyHttpError(res.status, await res.text());

      const data = await res.json();
      const choice = data.choices?.[0];
      const text = choice?.message?.content ?? "";
      const usage = data.usage || {};
      if (!text) throw new ProviderError(`未返回内容（finish_reason=${choice?.finish_reason || "未知"}）`, "SERVER", true);

      return {
        text,
        inputTokens: usage.prompt_tokens ?? 0,
        outputTokens: usage.completion_tokens ?? 0,
        finishReason: choice?.finish_reason,
        truncated: choice?.finish_reason === "length",
      };
    },
  };
}
