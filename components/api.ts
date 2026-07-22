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

type AgentResult = {
  ok: boolean; output: any; message?: string; human_review_required?: boolean;
  agent?: string; queue?: { position: number; ahead: number; estimated_wait_seconds: number } | null;
  degraded?: { mode: string; reason: string } | null;
  provider?: string; cached?: boolean; fallback_used?: boolean;
};

/** 任务进度回调：用于显示排队位置与预计等待 */
export type ProgressFn = (p: { status: string; queue?: any; elapsed: number }) => void;

// 慢 Agent（LLM 重活）走异步 run_id + 轮询，避免长请求被掐断与重复扣费；
// 快 Agent（纯规则/短调用）仍走同步端点。
const ASYNC_AGENTS = new Set(["solution_architect", "code_generator", "report_composer"]);

async function safeJson(res: Response): Promise<any> {
  try { return await res.json(); } catch { return { error: `HTTP ${res.status}（响应不是 JSON，可能是服务端错误页）` }; }
}

/** 永不抛异常：任何网络/解析失败都返回 { ok:false, message }，
 *  否则异常会跳过调用方的 setBusy(false)，界面卡在"思考中"。 */
export async function callAgent(agent: string, input: any, projectId: string | null, onProgress?: ProgressFn): Promise<AgentResult> {
  try {
    const body = JSON.stringify({ agent, input, project_id: projectId });
    const headers = { "content-type": "application/json" };

    if (ASYNC_AGENTS.has(agent)) {
      const idem = `${agent}:${projectId || "np"}:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      const res = await fetch("/api/agent-tasks", { method: "POST", headers, body: JSON.stringify({ agent, input, project_id: projectId, idempotency_key: idem }) });
      const start = await safeJson(res);
      // 系统降级：明确告知用户仍可使用的能力，而不是失败弹窗
      if (res.status === 503 && start.degraded) {
        return { ok: false, output: null, message: start.error, degraded: { mode: start.system_mode, reason: start.error } };
      }
      if (!res.ok || !start.task_id) return { ok: false, output: null, message: start.error || `启动失败 HTTP ${res.status}` };
      return pollTask(start.task_id, true, onProgress);
    }

    const res = await fetch("/api/agent", { method: "POST", headers, body });
    const data = await safeJson(res);
    if (!res.ok && !data.message) data.message = data.error || `HTTP ${res.status}`;
    return data as AgentResult;
  } catch (e: any) {
    return { ok: false, output: null, message: `请求失败：${e?.message || e}` };
  }
}

let _activeTask: string | null = null;
export function activeTaskId() { return _activeTask; }
export async function cancelActiveTask() {
  if (!_activeTask) return;
  await fetch(`/api/agent-tasks/${_activeTask}/cancel`, { method: "POST" }).catch(() => {});
}

/** 轮询任务直到终态。ignite=true 时先点火；页面刷新恢复时 ignite=false（可能已在跑）。 */
export async function pollTask(taskId: string, ignite: boolean, onProgress?: ProgressFn): Promise<AgentResult & { agent?: string }> {
  _activeTask = taskId;
  let direct: AgentResult | null = null;
  // 点火请求本身会同步跑完并回传结果 —— 拿到就用（轮询仅作为刷新恢复/丢包时的后备）
  const fire = () => fetch(`/api/agent-tasks/${taskId}/execute`, { method: "POST", keepalive: true })
    .then(safeJson)
    .then((d) => {
      if (d?.status === "ok" && d.result) direct = d.result as AgentResult;
      else if (d?.status === "error") direct = (d.result as AgentResult) || { ok: false, output: null, message: d.error || "运行失败" };
      else if (d?.status === "canceled") direct = { ok: false, output: null, message: "任务已取消" };
    })
    .catch(() => {});
  if (ignite) fire();
  const t0 = Date.now();
  let reIgnited = false;
  try {
    while (Date.now() - t0 < 300_000) {
      if (direct) return direct;
      await new Promise((r) => setTimeout(r, Date.now() - t0 < 20_000 ? 1500 : 3000));
      if (direct) return direct;
      const st = await fetch(`/api/agent-tasks/${taskId}`).then(safeJson).catch(() => null);
      if (!st || st.error && !st.status) continue;
      onProgress?.({ status: st.status, queue: st.queue, elapsed: Date.now() - t0 });
      if (st.status === "ok") {
        return { ...(st.result as AgentResult), agent: st.agent, provider: st.model, fallback_used: st.fallback_used };
      }
      if (st.status === "canceled") return { ok: false, output: null, message: "任务已取消", agent: st.agent };
      if (st.status === "error") return (st.result && { ...(st.result as AgentResult), agent: st.agent }) || { ok: false, output: null, message: st.error || "运行失败", agent: st.agent };
      if (st.status === "queued" && !reIgnited && Date.now() - t0 > 12_000) { reIgnited = true; fire(); }
    }
    return { ok: false, output: null, message: `任务超时。任务编号 ${taskId}` };
  } finally { _activeTask = null; }
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
