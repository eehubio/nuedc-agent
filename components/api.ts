"use client";

// 前端调用后端的薄封装。嵌入模式下 tier 由 URL 参数带入（正式对接时
// 应由 ezPLM 服务端代理并携带 EZPLM_API_KEY，前端参数仅作演示）。

export function getEmbedParams() {
  if (typeof window === "undefined") return { embed: false, tier: "free", ezplmProjectId: "" };
  const p = new URLSearchParams(window.location.search);
  return {
    embed: p.get("embed") === "1",
    tier: p.get("tier") || "free",
    ezplmProjectId: p.get("ezplm_project_id") || "",
  };
}

export async function callAgent(agent: string, input: any, projectId: string | null) {
  const res = await fetch("/api/agent", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent, input, project_id: projectId }),
  });
  const data = await res.json();
  if (!res.ok && !data.message) data.message = data.error || `HTTP ${res.status}`;
  return data as { ok: boolean; output: any; message?: string; human_review_required?: boolean };
}

export async function api(path: string, init?: RequestInit) {
  const res = await fetch(path, { headers: { "content-type": "application/json" }, ...init });
  return res.json();
}

/** 向父页面（ezPLM）回传事件 */
export function emitToEzplm(type: string, payload: any) {
  if (typeof window !== "undefined" && window.parent !== window) {
    window.parent.postMessage({ __nuedc_agent: true, type, payload }, "*");
  }
}
