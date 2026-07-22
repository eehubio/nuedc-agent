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

type AgentResult = { ok: boolean; output: any; message?: string; human_review_required?: boolean };

// 慢 Agent（LLM 重活）走异步 run_id + 轮询，避免长请求被掐断与重复扣费；
// 快 Agent（纯规则/短调用）仍走同步端点。
const ASYNC_AGENTS = new Set(["solution_architect", "code_generator", "report_composer", "labsight_debug", "test_scoring", "problem_interpreter"]);

export async function callAgent(agent: string, input: any, projectId: string | null): Promise<AgentResult> {
  const body = JSON.stringify({ agent, input, project_id: projectId });
  const headers = { "content-type": "application/json" };

  if (ASYNC_AGENTS.has(agent)) {
    const res = await fetch("/api/agent-runs", { method: "POST", headers, body });
    const start = await res.json();
    if (!res.ok) return { ok: false, output: null, message: start.error || `HTTP ${res.status}` };
    // 轮询：前 20s 每 1.5s，之后每 3s，上限 5 分钟
    const t0 = Date.now();
    while (Date.now() - t0 < 300_000) {
      await new Promise((r) => setTimeout(r, Date.now() - t0 < 20_000 ? 1500 : 3000));
      const st = await fetch(`/api/agent-runs/${start.run_id}`).then((r) => r.json()).catch(() => null);
      if (!st) continue;
      if (st.status === "ok") return st.result as AgentResult;
      if (st.status === "error") return (st.result as AgentResult) || { ok: false, output: null, message: st.error || "运行失败" };
    }
    return { ok: false, output: null, message: "任务超时（5 分钟）。可稍后在项目产物历史中查看是否已完成。" };
  }

  const res = await fetch("/api/agent", { method: "POST", headers, body });
  const data = await res.json();
  if (!res.ok && !data.message) data.message = data.error || `HTTP ${res.status}`;
  return data as AgentResult;
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
