import { NextRequest, NextResponse } from "next/server";
import { llmComplete, llmJson } from "@/lib/llm";

export const runtime = "nodejs";
export const maxDuration = 120;

/** 自检端点：直接暴露 LLM 链路的真实状态，避免"猜哪一环坏了"。
 *  GET /api/diag —— 环境变量与连通性
 *  GET /api/diag?full=1 —— 额外跑一次真实 JSON 生成（消耗少量 token） */
export async function GET(req: NextRequest) {
  const provider = process.env.LLM_PROVIDER || "anthropic";
  const model = provider === "gemini" ? (process.env.GEMINI_MODEL || "gemini-2.0-flash")
    : provider === "openai" ? (process.env.OPENAI_MODEL || "gpt-4o-mini")
    : (process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6");
  const keyName = provider === "gemini" ? "GEMINI_API_KEY" : provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
  const hasKey = !!process.env[keyName];

  const out: any = {
    provider, model, key_configured: hasKey,
    thinking_disabled: provider === "gemini" && /2\.5|thinking/i.test(model),
    database_configured: !!process.env.DATABASE_URL,
    admin_key_configured: !!process.env.ADMIN_API_KEY,
  };
  if (!hasKey) {
    out.verdict = `未配置 ${keyName} —— 所有 LLM 功能都会失败。请在 Vercel 环境变量中添加后 Redeploy。`;
    return NextResponse.json(out, { status: 200 });
  }

  // 连通性：一次极小调用
  const t0 = Date.now();
  try {
    const text = await llmComplete({ system: "只回复两个字：正常", messages: [{ role: "user", content: "自检" }], maxTokens: 32 });
    out.connectivity = { ok: true, ms: Date.now() - t0, sample: text.slice(0, 40) };
  } catch (e: any) {
    out.connectivity = { ok: false, ms: Date.now() - t0, error: String(e?.message || e).slice(0, 500) };
    out.verdict = "LLM 调用失败 —— 见 connectivity.error（常见：Key 无效、模型名不存在、配额用尽、地区限制）";
    return NextResponse.json(out, { status: 200 });
  }

  if (new URL(req.url).searchParams.get("full") === "1") {
    const t1 = Date.now();
    try {
      const r = await llmJson<any>({
        system: '输出一个 JSON：{"solution":{"solution_id":"SOL-TEST","name":"自检方案","blocks":[{"block_id":"B1","name":"主控"},{"block_id":"B2","name":"传感"}]}}',
        messages: [{ role: "user", content: "按格式输出" }],
        maxTokens: 2048,
      });
      const blocks = r?.solution?.blocks || r?.blocks || [];
      out.json_generation = { ok: Array.isArray(blocks) && blocks.length > 0, ms: Date.now() - t1, blocks: blocks.length, keys: Object.keys(r || {}) };
    } catch (e: any) {
      out.json_generation = { ok: false, ms: Date.now() - t1, error: String(e?.message || e).slice(0, 500) };
    }
  }

  out.verdict = out.json_generation
    ? (out.json_generation.ok ? "全链路正常：Key、连通性、JSON 生成均通过" : "连通正常但 JSON 生成异常 —— 见 json_generation.error")
    : "Key 与连通性正常。加 ?full=1 可测试 JSON 生成能力。";
  return NextResponse.json(out);
}
