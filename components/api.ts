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
const ASYNC_AGENTS = new Set(["solution_architect", "code_generator", "report_composer"]);

async function safeJson(res: Response): Promise<any> {
  try { return await res.json(); } catch { return { error: `HTTP ${res.status}（响应不是 JSON，可能是服务端错误页）` }; }
}

/** 永不抛异常：任何网络/解析失败都返回 { ok:false, message }，
 *  否则异常会跳过调用方的 setBusy(false)，界面卡在"思考中"。 */
export async function callAgent(agent: string, input: any, projectId: string | null): Promise<AgentResult> {
  try {
    const body = JSON.stringify({ agent, input, project_id: projectId });
    const headers = { "content-type": "application/json" };

    if (ASYNC_AGENTS.has(agent)) {
      const res = await fetch("/api/agent-runs", { method: "POST", headers, body });
      const start = await safeJson(res);
      if (!res.ok || !start.run_id) return { ok: false, output: null, message: start.error || `启动失败 HTTP ${res.status}` };
      const t0 = Date.now();
      while (Date.now() - t0 < 300_000) {
        await new Promise((r) => setTimeout(r, Date.now() - t0 < 20_000 ? 1500 : 3000));
        const st = await fetch(`/api/agent-runs/${start.run_id}`).then(safeJson).catch(() => null);
        if (!st || st.error) continue;
        if (st.status === "ok") return st.result as AgentResult;
        if (st.status === "error") return (st.result as AgentResult) || { ok: false, output: null, message: st.error || "运行失败" };
      }
      return { ok: false, output: null, message: `任务超时。运行编号 ${start.run_id}，可到 Vercel Runtime Logs 查看该请求日志。` };
    }

    const res = await fetch("/api/agent", { method: "POST", headers, body });
    const data = await safeJson(res);
    if (!res.ok && !data.message) data.message = data.error || `HTTP ${res.status}`;
    return data as AgentResult;
  } catch (e: any) {
    return { ok: false, output: null, message: `请求失败：${e?.message || e}` };
  }
}

export async function api(path: string, init?: RequestInit) {
  try {
    const res = await fetch(path, { headers: { "content-type": "application/json" }, ...init });
    return await res.json();
  } catch (e: any) {
    return { error: `请求失败：${e?.message || e}` };
  }
}

/** 向父页面（ezPLM）回传事件 */
export function emitToEzplm(type: string, payload: any) {
  if (typeof window !== "undefined" && window.parent !== window) {
    window.parent.postMessage({ __nuedc_agent: true, type, payload }, "*");
  }
}
