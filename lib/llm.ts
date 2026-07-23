// ============================================================
// 多模型路由：
//  - 复杂方案与代码 → 强推理模型（默认 provider 主模型）
//  - 规则校验（接口/电压/BOM合并）→ 不使用 LLM（见 lib/rules/*）
//  - 图片（LabSight）→ 传 images 时自动走多模态消息格式
// 通过环境变量切换 provider，避免锁死在单一 Agent 框架 / 单一模型上。
// ============================================================

export interface LlmMessage {
  role: "user" | "assistant";
  content: string;
  images?: { media_type: string; data_base64: string }[];
}

export interface LlmOptions {
  system: string;
  messages: LlmMessage[];
  maxTokens?: number;
  json?: boolean;   // 请求提供方以 JSON 模式输出（Gemini/OpenAI 支持）
  // 以下字段供网关做策略路由、缓存与可追踪记账
  taskType?: string;
  owner?: string | null;
  projectId?: string | null;
  taskId?: string | null;
  allowCache?: boolean;
  temperature?: number;
}

/** 迁移兼容层：旧调用点继续可用，内部统一走 modelGateway。
 *  新代码请直接使用 modelGateway.run()，以获得 taskType 级策略、缓存与遥测。 */
export async function llmComplete(opts: LlmOptions): Promise<string> {
  if (process.env.GATEWAY_ENABLED !== "0") {
    const r = await modelGateway.run({
      taskType: (opts.taskType as any) || "GENERAL_QA",
      system: opts.system,
      messages: opts.messages as any,
      json: !!opts.json,
      maxOutputTokens: opts.maxTokens,
      owner: opts.owner ?? null,
      projectId: opts.projectId ?? null,
      taskId: opts.taskId ?? null,
      allowCache: opts.allowCache,
    });
    if (!r.ok) throw new Error(r.message || "模型调用失败");
    return r.rawText;
  }
  return llmCompleteDirect(opts);
}

/** 直连实现（GATEWAY_ENABLED=0 时的回滚路径） */
async function llmCompleteDirect(opts: LlmOptions): Promise<string> {
  const provider = process.env.LLM_PROVIDER || "anthropic";
  if (provider === "anthropic") return anthropicComplete(opts);
  if (provider === "gemini") return geminiComplete(opts);
  return openaiComplete(opts);
}

// repairTruncatedJson 已移到 lib/json-repair.ts（打破与 model-gateway 的循环依赖），此处转出以兼容既有引用
export { repairTruncatedJson } from "./json-repair";

// 静态 import：动态 import 在 tsx 的 data: URL 编译模式下无法解析相对路径
import { modelGateway } from "./model-gateway";
import { AGENT_TASK_TYPE } from "./model-gateway/task-policy";
import { currentAgentContext, markPartial } from "./agents/base";


/** 兼容层：旧 Agent 调用点继续可用，内部**单次转发**到网关。
 *  JSON 解析、截断修复、重试全部由网关统一负责，此处不得重复实现
 *  （否则重试次数翻倍、修复逻辑分叉，且模块级状态会并发串线）。 */
export async function llmJson<T = unknown>(opts: LlmOptions): Promise<T> {

  // 自动附加当前 Agent 上下文（ALS，天然并发安全）
  let auto: Partial<LlmOptions> = {};
  let signal: AbortSignal | undefined;
  try {
    const c = currentAgentContext();
    auto = {
      owner: opts.owner ?? c.owner,
      projectId: opts.projectId ?? c.projectId,
      taskId: opts.taskId ?? c.taskId,
      taskType: opts.taskType ?? (c.agent ? AGENT_TASK_TYPE[c.agent] : undefined),
    };
    signal = c.signal;
  } catch { /* 非 Agent 环境（如自检）忽略 */ }

  const r = await modelGateway.run<T>({
    taskType: (auto.taskType || opts.taskType || "GENERAL_QA") as any,
    system: opts.system +
      "\n\n输出要求：只输出一个合法 JSON 对象，不要输出 Markdown 代码围栏、前言或解释文字。" +
      "\n务必控制篇幅：描述性字段简明扼要，确保 JSON 在 token 限额内完整闭合。",
    messages: opts.messages as any,
    json: true,
    maxOutputTokens: opts.maxTokens,
    owner: auto.owner ?? null,
    projectId: auto.projectId ?? null,
    taskId: auto.taskId ?? null,
    allowCache: opts.allowCache,
    signal,
  });

  if (!r.ok) throw new GatewayCallError(r.message || "模型调用失败", r.errorCode, r.validation?.issues);
  if (r.partial) {
    try { markPartial(); } catch { /* 非 Agent 环境 */ }
  }
  return r.output as T;
}

/** 网关调用失败的结构化错误，供 Agent 区分 Schema 失败与 Provider 失败 */
export class GatewayCallError extends Error {
  constructor(message: string, readonly errorCode?: string, readonly issues?: string[]) {
    super(message);
    this.name = "GatewayCallError";
  }
}

async function anthropicComplete(opts: LlmOptions): Promise<string> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("缺少 ANTHROPIC_API_KEY");
  const messages = opts.messages.map((m) => ({
    role: m.role,
    content: m.images?.length
      ? [
          ...m.images.map((img) => ({
            type: "image",
            source: { type: "base64", media_type: img.media_type, data: img.data_base64 },
          })),
          { type: "text", text: m.content },
        ]
      : m.content,
  }));
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
      max_tokens: opts.maxTokens ?? 4096,
      temperature: opts.temperature ?? 0.3,
      system: opts.system,
      messages,
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (data.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
}

// ---------- OpenAI 兼容（可指向 DeepSeek / Qwen 等）----------
async function openaiComplete(opts: LlmOptions): Promise<string> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("缺少 OPENAI_API_KEY");
  const base = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const messages = [
    { role: "system", content: opts.system },
    ...opts.messages.map((m) => ({
      role: m.role,
      content: m.images?.length
        ? [
            { type: "text", text: m.content },
            ...m.images.map((img) => ({
              type: "image_url",
              image_url: { url: `data:${img.media_type};base64,${img.data_base64}` },
            })),
          ]
        : m.content,
    })),
  ];
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      max_tokens: opts.maxTokens ?? 4096,
      temperature: opts.temperature ?? 0.3,
      ...(opts.json ? { response_format: { type: "json_object" } } : {}),
      messages,
    }),
  });
  if (!res.ok) throw new Error(`OpenAI API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const choice = data.choices?.[0];
  const text = choice?.message?.content ?? "";
  if (!text) throw new Error(`模型未返回内容（finish_reason=${choice?.finish_reason || "未知"}）`);
  if (choice?.finish_reason === "length") console.warn("[openai] 输出达到 max_tokens 被截断");
  return text;
}

// ---------- Gemini ----------
async function geminiComplete(opts: LlmOptions): Promise<string> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("缺少 GEMINI_API_KEY");
  const model = process.env.GEMINI_MODEL || "gemini-2.0-flash";
  const contents = opts.messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [
      ...(m.images || []).map((img) => ({
        inline_data: { mime_type: img.media_type, data: img.data_base64 },
      })),
      { text: m.content },
    ],
  }));
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: opts.system }] },
        contents,
        generationConfig: {
          maxOutputTokens: opts.maxTokens ?? 4096,
          temperature: opts.temperature ?? 0.3,
          responseMimeType: opts.json ? "application/json" : undefined,
          // Gemini 2.5 的 thinking token 会吃掉输出配额，导致正文被腰斩甚至为空 —— 显式关闭
          thinkingConfig: /2\.5|thinking/i.test(model) ? { thinkingBudget: 0 } : undefined,
        },
      }),
    }
  );
  if (!res.ok) throw new Error(`Gemini API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const cand = data.candidates?.[0];
  const text = cand?.content?.parts?.map((p: any) => p.text).filter(Boolean).join("\n") ?? "";
  const reason = cand?.finishReason;
  const usage = data.usageMetadata;
  // 把真实失败原因暴露出来，不再被静默吞掉
  if (!text) {
    throw new Error(
      `Gemini 未返回内容（finishReason=${reason || "未知"}${usage ? `, 输出token=${usage.candidatesTokenCount ?? 0}/${opts.maxTokens ?? 4096}` : ""}）。` +
      (reason === "SAFETY" ? "内容被安全策略拦截。" :
       reason === "MAX_TOKENS" ? "输出额度被耗尽（可能是 thinking token 占用），请缩短输入或提高 maxTokens。" :
       reason === "RECITATION" ? "被判定为重复引用而中断。" : "")
    );
  }
  if (reason === "MAX_TOKENS") {
    console.warn(`[gemini] 输出达到上限被截断（${usage?.candidatesTokenCount}/${opts.maxTokens}），将尝试修复`);
  }
  return text;
}
