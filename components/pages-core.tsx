"use client";
import { useEffect, useMemo, useState } from "react";
import { PREP_TASKS, KNOWLEDGE_POINTS, TYPICAL_DIRECTIONS, FEATURES, COMPETITION_DATE, COMPETITION_NAME } from "../data/prep-content";
import { CATEGORY_TREE, CAT_ICON, categoryLabel } from "../data/categories";
import { STAGES, STAGE_LABEL } from "./Platform";

const CERT_LABEL: Record<string, [string, string]> = {
  DRAFT: ["待审核", "chip"], DOCUMENTED: ["已建档", "chip"], POWER_TESTED: ["电测通过", "chip"],
  FUNCTION_TESTED: ["功能实测", "chip green"], BENCHMARKED: ["已标定", "chip green"],
  COMPETITION_READY: ["赛用认证", "chip gold"], DEPRECATED: ["已弃用", "chip red"],
};
export function CertBadge({ s }: { s: string }) {
  const [label, cls] = CERT_LABEL[s] || [s, "chip"];
  return <span className={cls}>{label}</span>;
}
function modIcon(cat: string) { return CAT_ICON[String(cat).split(".")[0]] || "🔲"; }

/* ================= 首页 ================= */
export function HomePage({ ctx }: { ctx: any }) {
  const [done, setDone] = useState<boolean[]>(PREP_TASKS.map(() => false));
  const doneN = done.filter(Boolean).length;
  const hot = useMemo(
    () => [...ctx.modules].sort((a, b) => (b.downloads || 0) - (a.downloads || 0) || (b.price || 0) - (a.price || 0)).slice(0, 5),
    [ctx.modules]
  );
  return (
    <>
      <div className="hero">
        <div className="kicker">智能 · 高效 · 严谨</div>
        <h2>电赛智能体 你的全能备赛伙伴</h2>
        <div className="feats">
          <span>结构化模块库</span><span>AI 方案生成 + 规则接口检查</span>
          <span>代码与调试支持</span><span>报告一键成稿</span>
        </div>
        <div className="chiptags">
          <i>DDS</i><i>ADC / DAC</i><i>视觉 / K230</i><i>电源管理</i><i>电机驱动</i>
        </div>
      </div>

      <div className="grid cols-5 feature-cards" style={{ marginBottom: 16 }}>
        {FEATURES.map((f) => (
          <button key={f.key} className="fcard" onClick={() => ctx.setPage(f.key)}>
            <span className="fi" style={{ background: f.color }}>{f.icon}</span>
            <b>{f.name}</b><small>{f.desc}</small>
          </button>
        ))}
      </div>

      <Dashboard ctx={ctx} />

      <div className="grid" style={{ gridTemplateColumns: "1fr 300px", alignItems: "start" }}>
        <div style={{ display: "grid", gap: 14 }}>
          <div className="card">
            <h3>热门模块推荐 <span className="more" onClick={() => ctx.setPage("modules")}>更多模块 →</span></h3>
            <div className="grid cols-5">
              {hot.map((m) => (
                <div key={m.id} className="mod-card">
                  <div className="thumb">{modIcon(m.category)}</div>
                  <div>
                    <CertBadge s={m.certification_status} />
                    {(m.tags || []).slice(0, 1).map((t: string) => <span key={t} className="chip">{t}</span>)}
                  </div>
                  <b>{m.name}</b>
                  <span className="hint">{m.main_chip}</span>
                </div>
              ))}
              {!hot.length && <span className="hint">模块库为空 —— 运行 npm run db:seed 导入种子模块。</span>}
            </div>
          </div>

          <div className="card">
            <h3>典型应用方向 <span className="hint" style={{ fontWeight: 400 }}>点击即用该方向示例开始方案设计</span></h3>
            <div className="grid cols-5">
              {TYPICAL_DIRECTIONS.map((d) => (
                <button key={d.name} className="fcard" onClick={() => ctx.startFromDirection(d.seed)}>
                  <span className="fi" style={{ background: "#eef3fd", color: "#1d4ed8", fontSize: 22 }}>{d.icon}</span>
                  <b>{d.name}</b>
                  <small>{d.tags.join(" / ")}</small>
                </button>
              ))}
            </div>
          </div>
        </div>

        <div style={{ display: "grid", gap: 14 }}>
          <div className="card">
            <h3>今日备赛任务 <span className="hint" style={{ fontWeight: 400 }}>{doneN}/{PREP_TASKS.length}</span></h3>
            <div className="progress"><i style={{ width: `${(doneN / PREP_TASKS.length) * 100}%` }} /></div>
            <div className="tasklist">
              {PREP_TASKS.map((t, i) => (
                <label key={t} className={done[i] ? "done" : ""}>
                  <input type="checkbox" checked={done[i]} onChange={() => setDone((d) => d.map((v, j) => (j === i ? !v : v)))} />
                  {t}
                </label>
              ))}
            </div>
          </div>
          <div className="card">
            <h3>热门知识点</h3>
            <div className="klist">
              {KNOWLEDGE_POINTS.map((k) => (
                <div key={k.t} className="krow">{k.t}<span className="heat">{k.heat}</span></div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="statsbar">
        <span><b>{ctx.modules.length}</b> 个结构化模块</span>
        <span><b>11</b> 个专业 Agent</span>
        <span><b>3</b> 套确定性规则引擎</span>
        <span><b>7</b> 级模块认证状态机</span>
        <span style={{ marginLeft: "auto" }}>🔄 模块库持续更新中</span>
      </div>
    </>
  );
}

/* ================= 模块选型 ================= */
export function ModulesPage({ ctx }: { ctx: any }) {
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("");
  const [detail, setDetail] = useState<any>(null);
  const list = useMemo(() => ctx.modules.filter((m: any) => {
    if (cat && !String(m.category).startsWith(cat)) return false;
    if (q) {
      const hay = `${m.name} ${m.main_chip} ${m.description} ${(m.tags || []).join(" ")}`.toLowerCase();
      if (!hay.includes(q.toLowerCase())) return false;
    }
    return true;
  }), [ctx.modules, q, cat]);

  return (
    <>
      <div className="filterbar">
        <input placeholder="搜索模块 / 型号 / 功能 / 芯片…" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className={"fchip" + (cat === "" ? " on" : "")} onClick={() => setCat("")}>全部</button>
        {CATEGORY_TREE.map((c) => (
          <button key={c.key} className={"fchip" + (cat === c.key ? " on" : "")} onClick={() => setCat(c.key)}>{c.icon} {c.label}</button>
        ))}
        <span className="hint" style={{ marginLeft: "auto" }}>
          已选用 {ctx.shortlist.length} 个 · 生成方案时优先考虑
        </span>
      </div>

      <div className="grid cols-3">
        {list.map((m: any) => {
          const picked = ctx.shortlist.includes(m.id);
          return (
            <div key={m.id} className="card mod-card">
              <div style={{ display: "flex", gap: 12 }}>
                <div className="thumb" style={{ width: 84, flexShrink: 0 }}>{modIcon(m.category)}</div>
                <div style={{ minWidth: 0 }}>
                  <b>{m.name}</b>
                  <div className="hint">{m.main_chip} · {m.description?.slice(0, 34)}…</div>
                  <div style={{ marginTop: 4 }}>
                    <CertBadge s={m.certification_status} />
                    {(m.tags || []).slice(0, 2).map((t: string) => <span key={t} className="chip">{t}</span>)}
                    {m.assets_locked && <span className="chip violet">🔒 资料需付费</span>}
                  </div>
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
                <span className="price">¥{m.price}</span>
                <span className="hint">{m.source_snapshot?.source === "taobao" ? "淘宝快照" : m.source_snapshot?.source === "lab" ? "实验室" : "官方"}</span>
                <span style={{ flex: 1 }} />
                <button className="btn ghost sm" onClick={() => setDetail(m)}>详情</button>
                <button className={"btn sm" + (picked ? " ok" : "")}
                  onClick={() => ctx.setShortlist((s: string[]) => picked ? s.filter((x) => x !== m.id) : [...s, m.id])}>
                  {picked ? "✓ 已选用" : "选用"}
                </button>
              </div>
            </div>
          );
        })}
        {!list.length && <p className="hint">没有匹配的模块。</p>}
      </div>

      {detail && (
        <div className="modal-mask" onClick={() => setDetail(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>{detail.name} <CertBadge s={detail.certification_status} />
              {detail._completeness != null && <span className="chip">数据完整度 {detail._completeness}%</span>}</h3>
            <p className="hint">{detail.description}</p>
            <h4>接口定义</h4>
            <table className="data"><thead><tr><th>接口</th><th>类型</th><th>电平</th><th>约束</th></tr></thead>
              <tbody>
                {(detail.interfaces || []).map((it: any, i: number) => (
                  <tr key={i}>
                    <td>{it.name}</td>
                    <td>{it.interface_type}</td>
                    <td>{it.voltage_level}V{it.five_v_tolerant ? "（5V 容忍）" : ""}</td>
                    <td>{(it.constraints || []).join("；") || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <h4>电气参数</h4>
            <p className="hint">供电 {detail.power?.input_voltage_range?.join("~")}V · 典型电流 {detail.power?.typical_current_ma}mA{detail.power?.peak_current_ma ? ` · 峰值 ${detail.power.peak_current_ma}mA` : ""}</p>
            {detail.usage_notes?.length > 0 && (<><h4>使用要点</h4><ul>{detail.usage_notes.map((n: string) => <li key={n}>{n}</li>)}</ul></>)}
            {detail.known_issues?.length > 0 && (<><h4>已知坑点</h4>{detail.known_issues.map((n: string) => <div key={n} className="issue warning">⚠ {n}</div>)}</>)}
            {detail.competition_cases?.length > 0 && (<><h4>历届应用</h4><p className="hint">{detail.competition_cases.map((c: any) => `${c.year} ${c.problem}（${c.note}）`).join("；")}</p></>)}
            {detail.assets_locked
              ? <div className="issue info">🔒 原理图 / PCB / 代码仓库为付费资料，且仅开放「功能实测」及以上认证等级的模块。</div>
              : detail.schematic_assets?.length > 0 && <p className="hint">含原理图等完整资料 {detail.schematic_assets.length} 份。</p>}
            <div style={{ textAlign: "right", marginTop: 12 }}>
              <button className="btn ghost sm" onClick={() => setDetail(null)}>关闭</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/* ================= 我的项目 ================= */
function ArtifactHistory({ projectId, onRestored }: { projectId: string; onRestored: () => void }) {
  const [rows, setRows] = useState<any[]>([]);
  useEffect(() => {
    fetch(`/api/projects/${projectId}`).then((r) => r.json()).then((d) => setRows(d.artifacts || []));
  }, [projectId]);
  const TYPE_CN: Record<string, string> = {
    requirements: "需求", solution_proposal: "候选方案", solution: "确认方案", bom: "BOM",
    integration_report: "接口检查", code_bundle: "代码", code_verification: "代码验证",
    test_plan: "测试计划", test_record: "实测记录", score: "得分", test_report: "测试汇总", report: "报告",
  };
  async function restore(a: any) {
    const r = await fetch(`/api/projects/${projectId}/artifacts/${a.artifact_id}/restore`, { method: "POST" }).then((x) => x.json());
    if (r.version) { onRestored(); }
  }
  return (
    <table className="data" style={{ marginTop: 8 }}>
      <thead><tr><th>产物</th><th>版本</th><th>状态</th><th>来源</th><th>时间</th><th></th></tr></thead>
      <tbody>
        {rows.slice(0, 30).map((a) => (
          <tr key={a.artifact_id}>
            <td>{TYPE_CN[a.type] || a.type}</td><td>v{a.version}</td>
            <td>{a.status === "stale" ? <span className="chip gold">已过期</span> : a.status}</td>
            <td className="hint">{a.created_by}</td>
            <td className="hint">{String(a.created_at).slice(5, 16).replace("T", " ")}</td>
            <td><button className="btn ghost sm" onClick={() => restore(a)}>恢复为最新</button></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ProjectsPage({ ctx }: { ctx: any }) {
  const [historyOf, setHistoryOf] = useState<string | null>(null);
  return (
    <div className="grid cols-2">
      {ctx.projects.map((p: any) => {
        const idx = STAGES.indexOf(p.stage);
        return (
          <div key={p.project_id} className="card">
            <h3>{p.name}
              <span className="more" onClick={() => setHistoryOf(historyOf === p.project_id ? null : p.project_id)}>{historyOf === p.project_id ? "收起历史" : "版本历史"}</span>
              <span className="more" onClick={() => { ctx.setProjectId(p.project_id); ctx.setPage("solution"); }}>打开 →</span></h3>
            <p className="hint">阶段：{STAGE_LABEL[p.stage] || p.stage} · 更新于 {String(p.updated_at).slice(0, 10)}</p>
            <div className="progress"><i style={{ width: `${((idx + 1) / STAGES.length) * 100}%` }} /></div>
            <div className="hint" style={{ display: "flex", justifyContent: "space-between" }}>
              <span>备赛</span><span>方案</span><span>开发</span><span>测试</span><span>提交</span>
            </div>
            {historyOf === p.project_id && <ArtifactHistory projectId={p.project_id} onRestored={() => { if (ctx.projectId === p.project_id) ctx.setProjectId(p.project_id); }} />}
          </div>
        );
      })}
      {!ctx.projects.length && <p className="hint">还没有项目 —— 到「方案生成」页粘贴赛题即会自动创建。</p>}
    </div>
  );
}


/* ============ 项目驾驶舱 + 比赛倒计时 ============ */
function Dashboard({ ctx }: { ctx: any }) {
  const days = Math.ceil((new Date(COMPETITION_DATE).getTime() - Date.now()) / 86400000);
  const reqs: any[] = (ctx.requirements?.requirements || []).filter((r: any) => r.status !== "REJECTED");
  const mand = reqs.filter((r: any) => r.priority === "mandatory");
  const confirmed = mand.filter((r: any) => r.status === "CONFIRMED").length;
  const sum = ctx.testResult?.summary;
  const hasProject = !!ctx.projectId;
  return (
    <div className="statsbar" style={{ marginBottom: 16 }}>
      <span>⏱ {COMPETITION_NAME} {days > 0 ? <>还有 <b style={{ fontSize: 18 }}>{days}</b> 天</> : days > -5 ? <b style={{ color: "var(--red)" }}>比赛进行中</b> : <b>已结束</b>}</span>
      {hasProject ? (
        <>
          <span>阶段 <b>{STAGE_LABEL[ctx.stage] || ctx.stage}</b></span>
          {mand.length > 0 && <span>需求确认 <b style={{ color: confirmed === mand.length ? "var(--ok)" : "var(--amber)" }}>{confirmed}/{mand.length}</b></span>}
          {ctx.chosenSolution && <span>主方案 <b>{ctx.chosenSolution.solution_id}</b>{ctx.backupSolution && <span className="chip violet" style={{ marginLeft: 4 }}>备 {ctx.backupSolution.solution_id}</span>}</span>}
          {sum && <span>基本要求 <b style={{ color: sum.blockers.length ? "var(--red)" : "var(--ok)" }}>{sum.mandatory_passed}/{sum.mandatory_total}</b> · 预计 <b>{sum.score_low}~{sum.score_high}</b> 分</span>}
          {sum?.blockers?.length > 0 && <span className="chip red">阻断 {sum.blockers.length}：{sum.blockers[0].slice(0, 16)}…</span>}
        </>
      ) : (
        <span className="hint">还没有进行中的项目 —— 到「方案生成」粘贴赛题开始</span>
      )}
    </div>
  );
}
