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
  temperature?: number;
}

export async function llmComplete(opts: LlmOptions): Promise<string> {
  const provider = process.env.LLM_PROVIDER || "anthropic";
  if (provider === "anthropic") return anthropicComplete(opts);
  if (provider === "gemini") return geminiComplete(opts);
  return openaiComplete(opts);
}

/** 请求模型只输出 JSON，并做防御性解析（剥离 ```json 围栏、截取首尾大括号）。 */
export async function llmJson<T = unknown>(opts: LlmOptions): Promise<T> {
  const raw = await llmComplete({
    ...opts,
    system:
      opts.system +
      "\n\n输出要求：只输出一个合法 JSON 对象，不要输出 Markdown 代码围栏、前言或解释文字。",
  });
  const cleaned = raw.replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  const body = start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned;
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error("LLM 未返回合法 JSON：" + cleaned.slice(0, 400));
  }
}

// ---------- Anthropic ----------
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
      messages,
    }),
  });
  if (!res.ok) throw new Error(`OpenAI API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
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
        generationConfig: { maxOutputTokens: opts.maxTokens ?? 4096, temperature: opts.temperature ?? 0.3 },
      }),
    }
  );
  if (!res.ok) throw new Error(`Gemini API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join("\n") ?? "";
}
