import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 存活探针：只回答「进程是否在跑」，不查数据库、不调模型。
 *  用于容器编排与 CI 等待服务启动 —— 必须极轻量且永远快速返回。 */
export async function GET() {
  return NextResponse.json({
    status: "ok",
    uptime_seconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
}
