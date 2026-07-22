import { NextResponse } from "next/server";
import { configuredProviders } from "@/lib/model-gateway";
import { policyFor } from "@/lib/model-gateway/task-policy";
import { route } from "@/lib/model-gateway/router";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";   // 必须运行时求值，不能构建期固化

/** 只读选路预览：公开可访问，不消耗任何 token。
 *  用途：压测前确认服务端是否处于 mock 模式，避免误烧真实费用；
 *  也便于排查"环境变量改了但没重新部署"这类问题。
 *  不返回任何密钥或敏感信息。 */
export async function GET() {
  const mockEnabled = process.env.ENABLE_MOCK_PROVIDER === "1";
  let primary: string | null = null;
  let chain: string[] = [];
  try {
    const cands = await route(policyFor("SOLUTION_PRIMARY"));
    chain = cands.map((c) => `${c.provider.id}:${c.model}`);
    primary = cands[0] ? `${cands[0].provider.id}:${cands[0].model}` : null;
  } catch { /* 选路失败时返回空 */ }

  return NextResponse.json({
    mock_enabled: mockEnabled,
    primary_candidate: primary,
    routing_chain: chain,
    configured_providers: configuredProviders(),
    // 便于确认部署是否包含最新环境变量
    primary_env: process.env.MODEL_PROVIDER_PRIMARY || "gemini",
    fallback_env: (process.env.MODEL_PROVIDER_FALLBACK || "").split(",").filter(Boolean),
  });
}
