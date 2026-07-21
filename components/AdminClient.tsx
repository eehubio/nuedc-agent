"use client";
import { useCallback, useEffect, useState } from "react";
import { CertBadge } from "./pages-core";

/** 编辑后台 —— 对齐 ai-hardware-genesis-platform 的 /admin：
 *  密钥登录 → 治理总览（平均完整度/低分名单/待审核）→ 审核工作流 →
 *  模块 JSON 编辑 / 新增 / 全量导出。密钥即 .env 的 ADMIN_API_KEY。 */

export default function AdminClient() {
  const [key, setKey] = useState("");
  const [authed, setAuthed] = useState(false);
  const [err, setErr] = useState("");
  const [gov, setGov] = useState<any>(null);
  const [mods, setMods] = useState<any[]>([]);
  const [editing, setEditing] = useState<any>(null);   // { id, json }
  const [creating, setCreating] = useState(false);
  const [newJson, setNewJson] = useState("");
  const [toast, setToast] = useState("");

  const H = useCallback((k: string) => ({ "content-type": "application/json", "X-Api-Key": k }), []);

  const load = useCallback(async (k: string) => {
    const g = await fetch("/api/modules/governance", { headers: H(k) });
    if (!g.ok) throw new Error((await g.json()).error || "未授权");
    setGov(await g.json());
    const m = await fetch("/api/modules?status=all&limit=500", { headers: H(k) });
    setMods((await m.json()).modules || []);
  }, [H]);

  useEffect(() => {
    const saved = sessionStorage.getItem("nuedc_admin_key");
    if (saved) { setKey(saved); load(saved).then(() => setAuthed(true)).catch(() => {}); }
  }, [load]);

  async function login() {
    setErr("");
    try {
      await load(key);
      sessionStorage.setItem("nuedc_admin_key", key);
      setAuthed(true);
    } catch (e: any) { setErr(e.message || "密钥错误"); }
  }

  async function review(id: string, result: "approved" | "rejected") {
    const r = await fetch(`/api/modules/${id}/review`, { method: "POST", headers: H(key), body: JSON.stringify({ result }) });
    const d = await r.json();
    setToast(r.ok ? `${id}：${d.from_status} → ${d.to_status}` : d.error);
    load(key);
  }

  async function saveEdit() {
    try {
      const data = JSON.parse(editing.json);
      const r = await fetch(`/api/modules/${editing.id}`, { method: "PATCH", headers: H(key), body: JSON.stringify(data) });
      const d = await r.json();
      setToast(r.ok ? `${editing.id} 已保存` : d.error);
      if (r.ok) { setEditing(null); load(key); }
    } catch { setToast("JSON 格式错误"); }
  }

  async function create() {
    try {
      const data = JSON.parse(newJson);
      const r = await fetch("/api/modules", { method: "POST", headers: H(key), body: JSON.stringify(data) });
      const d = await r.json();
      setToast(r.ok ? `已创建 ${d.id}（DRAFT 待审核）` : d.error);
      if (r.ok) { setCreating(false); setNewJson(""); load(key); }
    } catch { setToast("JSON 格式错误"); }
  }

  function exportAll() {
    const blob = new Blob([JSON.stringify(mods, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `nuedc-modules-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
  }

  if (!authed) return (
    <div className="page" style={{ maxWidth: 420, paddingTop: 80 }}>
      <div className="card">
        <h3>模块数据库 · 编辑后台</h3>
        <p className="hint">请输入管理员密钥（部署环境变量 <code>ADMIN_API_KEY</code>）。实验室账户由 ezPLM 服务端代理接入。</p>
        <input type="password" value={key} onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && login()} placeholder="ADMIN_API_KEY"
          style={{ width: "100%", padding: 9, borderRadius: 8, border: "1px solid var(--line)", margin: "8px 0" }} />
        {err && <div className="issue blocker">{err}</div>}
        <button className="btn" style={{ width: "100%" }} onClick={login}>进入后台</button>
      </div>
    </div>
  );

  return (
    <div className="page">
      {toast && <div className="issue info" onClick={() => setToast("")}>{toast}（点击关闭）</div>}

      <div className="statsbar" style={{ marginBottom: 14 }}>
        <span><b>{gov?.totalModules}</b> 个模块</span>
        <span>平均完整度 <b>{gov?.averageCompleteness}%</b></span>
        <span><b>{gov?.pendingReview?.length ?? 0}</b> 个待审核</span>
        {gov?.bySource?.map((s: any) => <span key={s.source}>{s.source}: <b>{s.count}</b></span>)}
        <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button className="btn ghost sm" onClick={() => setCreating(true)}>＋ 新增模块</button>
          <button className="btn ghost sm" onClick={exportAll}>⬇ 导出 JSON</button>
          <button className="btn ghost sm" onClick={() => { sessionStorage.removeItem("nuedc_admin_key"); setAuthed(false); }}>退出</button>
        </span>
      </div>

      <div className="grid cols-2" style={{ alignItems: "start" }}>
        <div style={{ display: "grid", gap: 14 }}>
          <div className="card">
            <h3>待审核（DRAFT）</h3>
            {(gov?.pendingReview || []).map((p: any) => (
              <div key={p.id} className="req-item" style={{ alignItems: "center" }}>
                <span className="rid">{p.id}</span>
                <span>{p.name}<span className="chip" style={{ marginLeft: 6 }}>{p.source}</span></span>
                <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                  <button className="btn sm ok" onClick={() => review(p.id, "approved")}>通过 →DOCUMENTED</button>
                  <button className="btn ghost sm" onClick={() => review(p.id, "rejected")}>驳回</button>
                </span>
              </div>
            ))}
            {!gov?.pendingReview?.length && <p className="hint">没有待审核模块。用户/实验室上传的模块会强制进入这里，审核通过后沿认证状态机逐级推进。</p>}
          </div>

          <div className="card">
            <h3>低完整度名单（&lt;60 分）</h3>
            <p className="hint">完整度是透明的加权评分：接口引脚/约束、电源峰值、使用要点、坑点、历届案例、原理图与代码资产等。缺什么补什么。</p>
            {(gov?.lowCompleteness || []).map((l: any) => (
              <div key={l.id} className="req-item">
                <span className="rid">{l.score}</span>
                <span><b>{l.name}</b><br /><span className="hint">缺：{l.missing.join("、")}</span></span>
              </div>
            ))}
            {!gov?.lowCompleteness?.length && <p className="hint">全部模块完整度达标 ✓</p>}
          </div>
        </div>

        <div className="card">
          <h3>全部模块（含 DRAFT）</h3>
          <table className="data">
            <thead><tr><th>模块</th><th>认证</th><th>完整度</th><th></th></tr></thead>
            <tbody>
              {mods.map((m: any) => (
                <tr key={m.id}>
                  <td><b>{m.name}</b><br /><span className="hint">{m.id}</span></td>
                  <td><CertBadge s={m.certification_status} /></td>
                  <td>
                    <div className="heatbar" style={{ width: 70 }}><i style={{ width: `${m._completeness ?? 0}%` }} /></div>
                    <span className="hint">{m._completeness ?? "—"}%</span>
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <button className="btn ghost sm" onClick={() => setEditing({ id: m.id, json: JSON.stringify(m, null, 2) })}>编辑</button>{" "}
                    {m.certification_status !== "COMPETITION_READY" && m.certification_status !== "DRAFT" && (
                      <button className="btn sm" onClick={() => review(m.id, "approved")}>晋级 ↑</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {(editing || creating) && (
        <div className="modal-mask" onClick={() => { setEditing(null); setCreating(false); }}>
          <div className="modal" style={{ maxWidth: 760 }} onClick={(e) => e.stopPropagation()}>
            <h3>{creating ? "新增模块（JSON，按 moduleInputSchema）" : `编辑 ${editing.id}`}</h3>
            <textarea className="area" style={{ minHeight: 380, fontFamily: "var(--mono)", fontSize: 12 }}
              value={creating ? newJson : editing.json}
              onChange={(e) => creating ? setNewJson(e.target.value) : setEditing({ ...editing, json: e.target.value })}
              placeholder={creating ? '{"id": "sensor-xxx", "name": "…", "category": "sensor.xxx", "interfaces": [...], "power": {...}}' : ""} />
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 10 }}>
              <button className="btn ghost sm" onClick={() => { setEditing(null); setCreating(false); }}>取消</button>
              <button className="btn sm" onClick={creating ? create : saveEdit}>{creating ? "创建（进入 DRAFT）" : "保存"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
