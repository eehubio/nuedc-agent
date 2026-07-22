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

  // 专项自检：用真实的方案生成提示词跑一次，复现线上失败场景
  if (new URL(req.url).searchParams.get("solution") === "1") {
    const t2 = Date.now();
    try {
      const { loadModuleIndex, moduleCatalogForLlm } = await import("@/lib/agents/base");
      const index = await loadModuleIndex();
      const catalog = moduleCatalogForLlm(index, { limit: 40 });
      const demoReqs = {
        requirements: [
          { id: "REQ-001", type: "functional", description: "系统能够模拟产生无线传输信号", priority: "mandatory", source: "题面", verification_method: "measurement", status: "CONFIRMED" },
          { id: "REQ-002", type: "performance", description: "直达信号的初相可设置", priority: "mandatory", source: "题面", verification_method: "measurement", status: "CONFIRMED" },
          { id: "REQ-003", type: "performance", description: "多径信号相对直达信号的时延可设置", priority: "mandatory", source: "题面", verification_method: "measurement", status: "CONFIRMED" },
        ],
      };
      const raw = await llmJson<any>({
        system: `你是电赛系统方案架构师。要求：
1. 优先使用模块目录中的模块（引用真实 module_id）
2. 每个 block 标注 covers_requirements（引用 REQ id）
3. connections 写清接口端点、protocol、voltage_from/voltage_to
4. power_tree 写清每条电源轨的电压、来源、负载和电流预算 budget_ma
5. 给出优缺点、风险等级、预计实现小时数
6. 篇幅控制：summary ≤50 字，功能块 4~8 个
模块目录：
${catalog}

本次只生成【一套】方案，solution_id 固定为 "SOL-DIAG"。
输出格式（严格遵守，blocks 至少 4 项）：
{"solution":{"solution_id":"SOL-DIAG","name":"方案名","summary":"概述","blocks":[{"block_id":"B1","name":"主控","module_id":"","role":"mcu","covers_requirements":["REQ-001"]}],"connections":[],"power_tree":[],"advantages":[],"disadvantages":[],"risk_level":"low","implementation_hours":40,"uncovered_requirements":[]}}`,
        messages: [{ role: "user", content: `结构化需求：\n${JSON.stringify(demoReqs)}` }],
        maxTokens: 10240,
        temperature: 0.4,
      });
      const sol = raw?.solution || raw;
      const blocks = sol?.blocks || sol?.modules || sol?.components || [];
      out.solution_generation = {
        ok: Array.isArray(blocks) && blocks.length > 0,
        ms: Date.now() - t2,
        blocks: Array.isArray(blocks) ? blocks.length : 0,
        top_keys: Object.keys(raw || {}).slice(0, 10),
        solution_keys: Object.keys(sol || {}).slice(0, 15),
        catalog_chars: catalog.length,
      };
    } catch (e: any) {
      out.solution_generation = { ok: false, ms: Date.now() - t2, error: String(e?.message || e).slice(0, 800) };
    }
  }

  out.verdict = out.solution_generation
    ? (out.solution_generation.ok
        ? `方案生成自检通过（${out.solution_generation.blocks} 个功能块，${out.solution_generation.ms}ms）—— 说明 Agent 链路本身没问题`
        : `方案生成自检失败 —— 见 solution_generation.error，这就是界面报错的真实原因`)
    : out.json_generation
    ? (out.json_generation.ok ? "全链路正常：Key、连通性、JSON 生成均通过" : "连通正常但 JSON 生成异常 —— 见 json_generation.error")
    : "Key 与连通性正常。加 ?full=1 可测试 JSON 生成能力。";
  return NextResponse.json(out);
}
