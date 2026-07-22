import { NextRequest, NextResponse } from "next/server";
import { resolveTier, resolveOwner, withOwnerCookie } from "@/lib/auth";
import { checkAndConsume } from "@/lib/usage";

/** PDF 魔数校验：base64 前几字节解码后必须以 %PDF- 开头 */
function isPdfBase64(b64: string): boolean {
  try {
    const head = Buffer.from(b64.slice(0, 16), "base64").toString("latin1");
    return head.startsWith("%PDF-");
  } catch { return false; }
}

export const runtime = "nodejs";
export const maxDuration = 60;

/** 赛题 PDF → 文本。电赛题目下发就是 PDF，直接上传比手动复制可靠。
 *  用 LLM 的多模态能力读取（对扫描件同样有效），失败时提示手动粘贴。 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body?.data_base64) return NextResponse.json({ error: "缺少 data_base64" }, { status: 400 });

  // 大小限制
  const sizeMB = (body.data_base64.length * 0.75) / 1024 / 1024;
  if (sizeMB > 8) return NextResponse.json({ error: `PDF 过大（${sizeMB.toFixed(1)}MB > 8MB），请压缩或直接粘贴文本` }, { status: 400 });

  // 魔数校验（诊断 P0-2）：必须是真正的 PDF，防止任意大文件被送进多模态接口
  if (!isPdfBase64(body.data_base64)) {
    return NextResponse.json({ error: "文件不是有效的 PDF（缺少 %PDF- 文件头）" }, { status: 400 });
  }

  // 鉴权 + 每日配额（免费 2 次 / 付费 20 次 / 实验室与管理员不限）
  const tier = resolveTier(req);
  const { owner, isNew } = resolveOwner(req);
  const denied = await checkAndConsume(owner, "pdf_extract", tier);
  if (denied) return withOwnerCookie(NextResponse.json({ error: denied }, { status: 429 }), owner, isNew);

  const provider = process.env.LLM_PROVIDER || "anthropic";
  const prompt = `这是全国大学生电子设计竞赛的赛题 PDF。请完整提取文字内容，要求：
1. 保持原有条目结构（任务、基本要求、发挥部分、说明、评分标准表）
2. 每页正文前加一行页码标记，格式：【第N页】
3. 评分标准表逐行转成"项目｜分值"的文字形式，不要遗漏分值
4. 表格用文字描述行列含义
5. 只输出提取的正文，不要添加任何解释或总结`;

  try {
    let text = "";
    if (provider === "gemini") {
      const model = process.env.GEMINI_MODEL || "gemini-2.0-flash";
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [
            { inline_data: { mime_type: "application/pdf", data: body.data_base64 } },
            { text: prompt },
          ]}],
          generationConfig: { maxOutputTokens: 8192, temperature: 0, thinkingConfig: /2\.5/.test(model) ? { thinkingBudget: 0 } : undefined },
        }),
      });
      if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const d = await res.json();
      text = d.candidates?.[0]?.content?.parts?.map((p: any) => p.text).filter(Boolean).join("\n") || "";
      if (!text) throw new Error(`未提取到文字（finishReason=${d.candidates?.[0]?.finishReason}）`);
    } else if (provider === "anthropic") {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY || "", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
          max_tokens: 8192,
          messages: [{ role: "user", content: [
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: body.data_base64 } },
            { type: "text", text: prompt },
          ]}],
        }),
      });
      if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const d = await res.json();
      text = (d.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
    } else {
      return NextResponse.json({ error: "当前 LLM 提供商不支持 PDF 解析，请直接粘贴题面文本" }, { status: 400 });
    }
    return withOwnerCookie(NextResponse.json({ text: text.trim(), chars: text.trim().length }), owner, isNew);
  } catch (e: any) {
    return NextResponse.json({ error: `PDF 解析失败：${e?.message || e}。可改用「粘贴文本」方式。` }, { status: 500 });
  }
}
