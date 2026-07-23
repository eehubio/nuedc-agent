import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 存活探针（liveness）。
 *  只回答「进程是否活着」，不查数据库、不依赖下游 —— 依赖挂了不应导致容器被反复重启。
 *  容器编排（K8s livenessProbe / Docker HEALTHCHECK）应指向这里。 */
export async function GET() {
  return NextResponse.json({
    status: "ok",
    service: "nuedc-agent-web",
    uptime_sec: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
}
