import type { Provider } from "./base";
import { geminiProvider } from "./gemini";
import { createOpenAICompatibleProvider } from "./openai-compatible";
import { mockProvider } from "./mock";

/** 已注册 Provider。国内厂商全部走 OpenAI 兼容工厂 —— 配好环境变量即启用，不改代码。
 *
 *  接入任意厂商只需三个环境变量，例如通义千问：
 *    QWEN_API_KEY=sk-xxx
 *    QWEN_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
 *    QWEN_MODEL_TEXT=qwen-plus
 *  或 DeepSeek：
 *    DEEPSEEK_API_KEY=sk-xxx
 *    DEEPSEEK_BASE_URL=https://api.deepseek.com/v1
 *    DEEPSEEK_MODEL_TEXT=deepseek-chat
 *  还可用 CUSTOM_* 接入自建网关或任何未列出的厂商。 */
export const PROVIDERS: Record<string, Provider> = {
  gemini: geminiProvider,

  qwen: createOpenAICompatibleProvider({
    id: "qwen", label: "通义千问", envPrefix: "QWEN",
    defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultTextModel: "qwen-plus", defaultVisionModel: "qwen-vl-plus",
    pricing: { inputPerMillion: 0.11, outputPerMillion: 0.28 },
  }),

  deepseek: createOpenAICompatibleProvider({
    id: "deepseek", label: "DeepSeek", envPrefix: "DEEPSEEK",
    defaultBaseUrl: "https://api.deepseek.com/v1",
    defaultTextModel: "deepseek-chat",
    capabilities: { vision: false },
    pricing: { inputPerMillion: 0.14, outputPerMillion: 0.28 },
  }),

  glm: createOpenAICompatibleProvider({
    id: "glm", label: "智谱 GLM", envPrefix: "GLM",
    defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
    defaultTextModel: "glm-4-flash", defaultVisionModel: "glm-4v-flash",
    pricing: { inputPerMillion: 0.014, outputPerMillion: 0.014 },
  }),

  moonshot: createOpenAICompatibleProvider({
    id: "moonshot", label: "Kimi", envPrefix: "MOONSHOT",
    defaultBaseUrl: "https://api.moonshot.cn/v1",
    defaultTextModel: "moonshot-v1-8k",
    pricing: { inputPerMillion: 1.68, outputPerMillion: 1.68 },
  }),

  // 自建网关 / 任何未列出的厂商（vLLM、Ollama、一站式聚合服务等）
  custom: createOpenAICompatibleProvider({
    id: "custom", label: "自定义", envPrefix: "CUSTOM",
  }),

  mock: mockProvider,
};

/** 已配置（可用）的 Provider id 列表 */
export function configuredProviders(): string[] {
  return Object.entries(PROVIDERS).filter(([, p]) => p.isConfigured()).map(([id]) => id);
}

export function getProvider(id: string): Provider | null {
  return PROVIDERS[id] || null;
}

export * from "./base";
