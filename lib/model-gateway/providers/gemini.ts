import {
  type Provider, type ProviderRequest, type ProviderResponse,
  ProviderError, classifyHttpError, fetchWithTimeout,
} from "./base";

/** Gemini（Google AI Studio）。默认主模型。 */
export const geminiProvider: Provider = {
  id: "gemini",
  label: "Gemini",
  capabilities: { vision: true, pdf: true, jsonMode: true, thinkingControl: true },
  pricing: { inputPerMillion: 0.30, outputPerMillion: 2.50 },   // 2.5 Flash 参考价

  isConfigured: () => !!process.env.GEMINI_API_KEY,
  modelFor(kind) {
    if (kind === "vision" || kind === "ocr") return process.env.GEMINI_MODEL_VISION || process.env.GEMINI_MODEL || "gemini-2.5-flash";
    return process.env.GEMINI_MODEL || "gemini-2.5-flash";
  },

  async complete(req: ProviderRequest, model: string): Promise<ProviderResponse> {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new ProviderError("未配置 GEMINI_API_KEY", "AUTH", false);

    const parts: any[] = [];
    if (req.pdfBase64) parts.push({ inline_data: { mime_type: "application/pdf", data: req.pdfBase64 } });
    if (req.imageBase64) parts.push({ inline_data: { mime_type: req.imageMime || "image/png", data: req.imageBase64 } });

    const contents = req.messages.map((m, i) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: i === req.messages.length - 1 && parts.length ? [...parts, { text: m.content }] : [{ text: m.content }],
    }));

    // 2.5 系列的 thinking token 计入输出配额 —— 显式控制
    const supportsThinking = /2\.5|thinking/i.test(model);
    const res = await fetchWithTimeout(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: req.system }] },
          contents,
          generationConfig: {
            maxOutputTokens: req.maxOutputTokens,
            temperature: req.temperature,
            responseMimeType: req.json ? "application/json" : undefined,
            thinkingConfig: supportsThinking ? { thinkingBudget: req.thinkingBudget ?? 0 } : undefined,
          },
        }),
      },
      req.timeoutMs,
      req.signal,
    );
    if (!res.ok) throw classifyHttpError(res.status, await res.text());

    const data = await res.json();
    const cand = data.candidates?.[0];
    const text = cand?.content?.parts?.map((p: any) => p.text).filter(Boolean).join("\n") ?? "";
    const reason = cand?.finishReason;
    const usage = data.usageMetadata || {};

    if (!text) {
      if (reason === "SAFETY") throw new ProviderError("内容被安全策略拦截", "SAFETY", false);
      throw new ProviderError(`未返回内容（finishReason=${reason || "未知"}）`, "SERVER", true);
    }
    return {
      text,
      inputTokens: usage.promptTokenCount ?? 0,
      outputTokens: usage.candidatesTokenCount ?? 0,
      finishReason: reason,
      truncated: reason === "MAX_TOKENS",
    };
  },
};
