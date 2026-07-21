"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { callAgent, api, getEmbedParams, emitToEzplm } from "./api";

const STAGES = [
  "PREPARATION","PROBLEM_RECEIVED","REQUIREMENTS_PARSED","SOLUTION_CANDIDATES","SOLUTION_APPROVED",
  "BOM_CONFIRMED","HARDWARE_BUILD","SOFTWARE_BUILD","INTEGRATION","TESTING","OPTIMIZATION","REPORTING","SUBMITTED",
] as const;
const STAGE_LABEL: Record<string, string> = {
  PREPARATION:"备赛", PROBLEM_RECEIVED:"拿题", REQUIREMENTS_PARSED:"需求", SOLUTION_CANDIDATES:"候选方案",
  SOLUTION_APPROVED:"方案确认", BOM_CONFIRMED:"BOM", HARDWARE_BUILD:"硬件", SOFTWARE_BUILD:"软件",
  INTEGRATION:"联调", TESTING:"测试", OPTIMIZATION:"优化", REPORTING:"报告", SUBMITTED:"提交",
};

const TABS = [
  { key: "problem",  n: "01", label: "赛题与需求" },
  { key: "forecast", n: "02", label: "题目预测" },
  { key: "solution", n: "03", label: "方案设计" },
  { key: "modules",  n: "04", label: "模块与BOM" },
  { key: "code",     n: "05", label: "软件与代码" },
  { key: "debug",    n: "06", label: "调试助手" },
  { key: "report",   n: "07", label: "报告与提交" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

// 各页签默认对接的专业 Agent（右侧面板随页签切换）
const TAB_AGENT: Record<TabKey, { agent: string; name: string }> = {
  problem:  { agent: "problem_interpreter", name: "赛题理解 Agent" },
  forecast: { agent: "topic_forecast", name: "题目预测 Agent" },
  solution: { agent: "solution_architect", name: "方案架构 Agent" },
  modules:  { agent: "module_knowledge", name: "模块知识库 Agent" },
  code:     { agent: "code_generator", name: "代码生成 Agent" },
  debug:    { agent: "labsight_debug", name: "LabSight 调试 Agent" },
  report:   { agent: "report_composer", name: "报告 Agent" },
};

interface Msg { who: "user" | "agent"; text: string }

export default function Workspace({ embed }: { embed: boolean }) {
  const params = useMemo(getEmbedParams, []);
  const [tab, setTab] = useState<TabKey>("problem");
  const [projectId, setProjectId] = useState<string | null>(null);
  const [projects, setProjects] = useState<any[]>([]);
  const [stage, setStage] = useState<string>("PREPARATION");
  const [busy, setBusy] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([
    { who: "agent", text: "我是电赛智能体总控。粘贴赛题开始解析，或直接告诉我你现在处于哪个阶段。" },
  ]);

  // 项目内产物（跨页签共享）
  const [problemText, setProblemText] = useState("");
  const [requirements, setRequirements] = useState<any>(null);
  const [forecast, setForecast] = useState<any>(null);
  const [solutions, setSolutions] = useState<any>(null);
  const [chosenSolution, setChosenSolution] = useState<any>(null);
  const [bom, setBom] = useState<any>(null);
  const [codeBundle, setCodeBundle] = useState<any>(null);
  const [debugSession, setDebugSession] = useState<any>(null);
  const [report, setReport] = useState<any>(null);

  const logRef = useRef<HTMLDivElement>(null);
  const say = useCallback((who: Msg["who"], text: string) => {
    setMsgs((m) => [...m, { who, text }]);
    setTimeout(() => logRef.current?.scrollTo({ top: 1e9 }), 30);
  }, []);

  // ---- 项目加载 ----
  useEffect(() => {
    api("/api/projects").then((d) => setProjects(d.projects || [])).catch(() => {});
  }, []);
  useEffect(() => {
    if (!projectId) return;
    api(`/api/projects/${projectId}`).then((d) => {
      if (d.project) {
        setStage(String(d.project.stage));
        if (d.project.problem_text) setProblemText(String(d.project.problem_text));
      }
      for (const a of d.artifacts || []) {
        if (a.type === "requirements" && !requirements) setRequirements(a.content);
        if (a.type === "solution_proposal" && !solutions) setSolutions(a.content);
        if (a.type === "bom" && !bom) setBom(a.content);
        if (a.type === "report" && !report) setReport(a.content);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // ---- ezPLM → 智能体 消息桥 ----
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (!e.data?.__ezplm) return;
      if (e.data.type === "set_problem") setProblemText(String(e.data.payload || ""));
      if (e.data.type === "set_project") setProjectId(String(e.data.payload || "") || null);
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  async function ensureProject(): Promise<string> {
    if (projectId) return projectId;
    const d = await api("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name: "电赛项目 " + new Date().toLocaleDateString(), problem_text: problemText, ezplm_project_id: params.ezplmProjectId }),
    });
    setProjectId(d.project_id);
    setProjects((p) => [{ project_id: d.project_id, name: "新项目", stage: "PREPARATION" }, ...p]);
    return d.project_id;
  }

  async function advanceStage(to: string) {
    if (!projectId) return;
    await api(`/api/projects/${projectId}`, { method: "PATCH", body: JSON.stringify({ stage: to }) });
    setStage(to);
    emitToEzplm("stage_changed", { project_id: projectId, stage: to });
  }

  // ---- 各页签动作 ----
  async function runInterpret() {
    if (!problemText.trim()) return say("agent", "请先粘贴赛题原文。");
    setBusy(true);
    const pid = await ensureProject();
    await api(`/api/projects/${pid}`, { method: "PATCH", body: JSON.stringify({ problem_text: problemText, stage: "PROBLEM_RECEIVED" }) });
    setStage("PROBLEM_RECEIVED");
    say("user", "解析赛题");
    const r = await callAgent("problem_interpreter", { problem_text: problemText }, pid);
    setBusy(false);
    if (r.ok) {
      setRequirements(r.output);
      say("agent", r.message || "赛题解析完成。");
      await advanceStage("REQUIREMENTS_PARSED");
      emitToEzplm("requirements_ready", r.output);
    } else say("agent", "解析失败：" + (r.message || ""));
  }

  async function runForecast() {
    setBusy(true);
    say("user", "运行题目预测");
    const r = await callAgent("topic_forecast", { device_list: (problemText || "").split(/[\n,，、]/).filter(Boolean) }, projectId);
    setBusy(false);
    if (r.ok) { setForecast(r.output); say("agent", "预测完成（规则评分 + 检索统计，分档表示，不是统计概率）。"); }
    else say("agent", "预测失败：" + (r.message || ""));
  }

  async function runSolution() {
    if (!requirements) return say("agent", "请先在「赛题与需求」页完成解析。");
    setBusy(true);
    say("user", "生成候选方案");
    const r = await callAgent("solution_architect", { requirements }, projectId);
    setBusy(false);
    if (r.ok) {
      setSolutions(r.output);
      say("agent", (r.message || "候选方案已生成。") + " 请人工选择一套方案后进入 BOM。");
      if (projectId) await advanceStage("SOLUTION_CANDIDATES");
    } else say("agent", "生成失败：" + (r.message || ""));
  }

  async function approveSolution(sol: any) {
    setChosenSolution(sol);
    say("agent", `已确认方案 ${sol.solution_id}（${sol.name}）。接口预检 ${sol.integration_precheck?.passed ? "通过" : "存在阻断项，请先处理"}。`);
    if (projectId) await advanceStage("SOLUTION_APPROVED");
    emitToEzplm("solution_approved", { solution_id: sol.solution_id });
  }

  async function runBomFromSolution() {
    if (!chosenSolution) return say("agent", "请先在「方案设计」页确认一套方案。");
    setBusy(true);
    say("user", "从方案生成 BOM");
    const r = await callAgent("bom_agent", { solution: chosenSolution }, projectId);
    setBusy(false);
    if (r.ok) {
      setBom(r.output);
      say("agent", r.message || "BOM 已生成。");
      if (projectId) await advanceStage("BOM_CONFIRMED");
      emitToEzplm("bom_ready", r.output); // ezPLM 可直接接走 BOM
    } else say("agent", "失败：" + (r.message || ""));
  }

  async function runBomFromText(raw: string) {
    setBusy(true);
    say("user", "整理粘贴的物料清单");
    const r = await callAgent("bom_agent", { raw_bom: raw }, projectId);
    setBusy(false);
    if (r.ok) { setBom(r.output); say("agent", r.message || "BOM 整理完成。"); emitToEzplm("bom_ready", r.output); }
    else say("agent", "失败：" + (r.message || ""));
  }

  async function runCode(target: string) {
    if (!chosenSolution) return say("agent", "代码生成需要已确认的方案（状态门禁）。");
    const pre = chosenSolution.integration_precheck;
    if (pre && !pre.passed) return say("agent", "接口检查存在阻断项，禁止进入代码生成 —— 请先在方案页处理。");
    setBusy(true);
    say("user", `生成模块代码：${target || "自动选择"}`);
    if (projectId && stage === "SOLUTION_APPROVED") await advanceStage("BOM_CONFIRMED");
    const r = await callAgent("code_generator", { solution: chosenSolution, target_module: target }, projectId);
    setBusy(false);
    if (r.ok) { setCodeBundle(r.output); say("agent", r.message || "代码已生成（状态 GENERATED，编译通过前不得视为可用）。"); }
    else say("agent", "失败：" + (r.message || ""));
  }

  async function runDebug(symptom: string, logs: string) {
    if (!symptom.trim()) return say("agent", "请描述故障现象。");
    setBusy(true);
    say("user", "调试：" + symptom);
    const r = await callAgent("labsight_debug", {
      symptom, logs,
      context: { solution: chosenSolution?.name },
      history: debugSession ? [debugSession] : [],
    }, projectId);
    setBusy(false);
    if (r.ok) { setDebugSession(r.output); say("agent", "已更新故障树与下一步测量动作。这是循环调试：拿到新测量结果后继续提交。"); }
    else say("agent", "失败：" + (r.message || ""));
  }

  async function runReport() {
    if (!chosenSolution) return say("agent", "报告必须基于已确认方案生成。");
    setBusy(true);
    say("user", "生成设计报告");
    if (projectId) await advanceStage("REPORTING");
    const r = await callAgent("report_composer", {
      requirements, solution: chosenSolution, bom,
      test_results: null, debug_notes: debugSession ? [debugSession.symptom] : [],
    }, projectId);
    setBusy(false);
    if (r.ok) {
      setReport(r.output);
      const issues = r.output.consistency_issues?.length || 0;
      say("agent", `报告初稿已生成${issues ? `，${issues} 处一致性问题需核实` : ""}。测试数据缺失处已用【待补充】占位，不会编造数值。`);
      emitToEzplm("report_ready", { project_id: projectId });
    } else say("agent", "失败：" + (r.message || ""));
  }

  // 右侧面板自由对话 → 总控编排
  async function chat(text: string) {
    if (!text.trim()) return;
    say("user", text);
    setBusy(true);
    const r = await callAgent("orchestrator", { user_request: text }, projectId);
    setBusy(false);
    if (r.ok) {
      const o = r.output;
      say("agent", (o.reply || "") + (o.tasks?.length ? "\n\n计划任务：\n" + o.tasks.map((t: any) => `· ${t.agent} — ${t.task}`).join("\n") : ""));
    } else say("agent", r.message || "调用失败");
  }

  const stageIdx = STAGES.indexOf(stage as any);

  return (
    <div className={"app" + (embed ? " embed" : "")}>
      {!embed && (
        <header className="masthead">
          <span className="brand">NUEDC<span className="dot">·</span>AGENT</span>
          <span className="sub">电赛智能体 — 1 个总控 + 专业 Agent + 模块数据库</span>
          <span style={{ flex: 1 }} />
          <select value={projectId || ""} onChange={(e) => setProjectId(e.target.value || null)} aria-label="选择项目">
            <option value="">— 选择项目 —</option>
            {projects.map((p) => <option key={p.project_id} value={p.project_id}>{p.name}（{STAGE_LABEL[p.stage] || p.stage}）</option>)}
          </select>
          <button className="new-proj" onClick={() => { setProjectId(null); setRequirements(null); setSolutions(null); setChosenSolution(null); setBom(null); setReport(null); setStage("PREPARATION"); }}>新建项目</button>
        </header>
      )}

      {/* 签名元素：状态机刻度条 */}
      <nav className="stagebar" aria-label="项目阶段">
        {STAGES.map((s, i) => (
          <button key={s} className={"tick" + (i < stageIdx ? " done" : i === stageIdx ? " current" : "")}
            onClick={() => projectId && advanceStage(s)} title={s}>
            {STAGE_LABEL[s]}
          </button>
        ))}
      </nav>

      <div className="main">
        <nav className="tabs" aria-label="工作区页签">
          {TABS.map((t) => (
            <button key={t.key} className={tab === t.key ? "active" : ""} onClick={() => setTab(t.key)}>
              <span className="k">{t.n}</span>{t.label}
            </button>
          ))}
        </nav>

        <main className="content">
          {tab === "problem" && (
            <ProblemTab problemText={problemText} setProblemText={setProblemText} requirements={requirements} onRun={runInterpret} busy={busy} />
          )}
          {tab === "forecast" && <ForecastTab forecast={forecast} onRun={runForecast} busy={busy} />}
          {tab === "solution" && (
            <SolutionTab solutions={solutions} chosen={chosenSolution} onRun={runSolution} onApprove={approveSolution} busy={busy} />
          )}
          {tab === "modules" && <ModulesTab bom={bom} onFromSolution={runBomFromSolution} onFromText={runBomFromText} busy={busy} hasSolution={!!chosenSolution} />}
          {tab === "code" && <CodeTab bundle={codeBundle} onRun={runCode} busy={busy} />}
          {tab === "debug" && <DebugTab session={debugSession} onRun={runDebug} busy={busy} />}
          {tab === "report" && <ReportTab report={report} onRun={runReport} busy={busy} projectId={projectId} />}
        </main>

        <aside className="agent-panel">
          <div className="head">
            <span>{TAB_AGENT[tab].name}</span>
            <span className="live">{busy ? <span className="spinner" aria-label="运行中" /> : "READY"}</span>
          </div>
          <div className="log" ref={logRef}>
            {msgs.map((m, i) => (
              <div key={i} className={"msg " + m.who}>
                <div className="who">{m.who === "user" ? "你" : "AGENT"}</div>
                <div className="body">{m.text}</div>
              </div>
            ))}
          </div>
          <ChatInput onSend={chat} disabled={busy} />
        </aside>
      </div>
    </div>
  );
}

// ================= 子组件 =================

function ChatInput({ onSend, disabled }: { onSend: (t: string) => void; disabled: boolean }) {
  const [text, setText] = useState("");
  return (
    <div className="input">
      <textarea value={text} placeholder="向总控智能体描述你要做什么…" onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSend(text); setText(""); } }} />
      <button className="btn" disabled={disabled || !text.trim()} onClick={() => { onSend(text); setText(""); }}>发送</button>
    </div>
  );
}

function ProblemTab({ problemText, setProblemText, requirements, onRun, busy }: any) {
  return (
    <>
      <h2>赛题与需求</h2>
      <p className="lede">粘贴赛题原文，赛题理解 Agent 会转换成带编号、可追踪的结构化需求（后续方案 / BOM / 代码 / 报告都引用 REQ id）。</p>
      <div className="card">
        <textarea rows={9} value={problemText} onChange={(e: any) => setProblemText(e.target.value)}
          placeholder="在此粘贴赛题 PDF 的文字内容，包括基本要求、发挥部分与说明…" />
        <div className="row">
          <button className="btn" onClick={onRun} disabled={busy}>解析赛题</button>
          <span className="hint">歧义与隐含约束会被标出，不会被擅自补全</span>
        </div>
      </div>
      {requirements ? (
        <div className="card">
          <h3>{requirements.title || "结构化需求"} <span className="badge ok">{requirements.requirements?.length || 0} 条</span></h3>
          <table className="data">
            <thead><tr><th>ID</th><th>需求</th><th>指标</th><th>优先级</th><th>验证方式</th><th>来源</th></tr></thead>
            <tbody>
              {(requirements.requirements || []).map((r: any) => (
                <tr key={r.id}>
                  <td className="readout">{r.id}</td>
                  <td>{r.description}</td>
                  <td className="readout">{r.target != null ? `${r.target}${r.unit || ""}` : "—"}</td>
                  <td><span className={"badge " + (r.priority === "mandatory" ? "err" : "warn")}>{r.priority === "mandatory" ? "基本" : "发挥"}</span></td>
                  <td className="readout">{r.verification_method}</td>
                  <td className="hint">{r.source}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {requirements.ambiguities?.length > 0 && (
            <><h3 style={{ marginTop: 14 }}>歧义 · 需人工确认</h3>
            <ul>{requirements.ambiguities.map((a: string, i: number) => <li key={i}>{a}</li>)}</ul></>
          )}
        </div>
      ) : <div className="empty">尚未解析。粘贴赛题后点击「解析赛题」。</div>}
    </>
  );
}

function ForecastTab({ forecast, onRun, busy }: any) {
  return (
    <>
      <h2>题目预测</h2>
      <p className="lede">规则评分（历年周期 + 器件清单相关度 + 新增器件 + 厂商方向 − 重复惩罚）排序，LLM 只负责解释与备赛建议。结果分档呈现，不宣称统计概率。</p>
      <div className="row"><button className="btn" onClick={onRun} disabled={busy}>运行预测</button>
        <span className="hint">可先在「赛题与需求」页粘贴当年器件清单，预测会读取其中的器件名</span></div>
      {forecast ? (
        <div className="card">
          <table className="data">
            <thead><tr><th>方向</th><th>分档</th><th>排序分</th><th>依据</th></tr></thead>
            <tbody>
              {(forecast.predictions || []).map((p: any) => (
                <tr key={p.direction}>
                  <td><strong>{p.direction}</strong></td>
                  <td><span className={"badge " + (p.band === "高可能" ? "ok" : p.band.includes("中") ? "warn" : "")}>{p.band}</span></td>
                  <td className="readout">{p.score}</td>
                  <td className="hint">{(p.evidence || []).join("；") || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {forecast.commentary?.analysis && (
            <><h3 style={{ marginTop: 14 }}>备赛建议</h3><p style={{ whiteSpace: "pre-wrap" }}>{forecast.commentary.analysis}</p></>
          )}
          <p className="hint">{forecast.disclaimer}</p>
        </div>
      ) : <div className="empty">尚未运行预测。</div>}
    </>
  );
}

function SolutionTab({ solutions, chosen, onRun, onApprove, busy }: any) {
  return (
    <>
      <h2>方案设计</h2>
      <p className="lede">方案架构 Agent 生成两套候选，生成后立即经过接口规则引擎预检（电平 / 引脚冲突 / 电源预算）。候选方案必须人工确认才会成为最终方案。</p>
      <div className="row"><button className="btn" onClick={onRun} disabled={busy}>生成候选方案</button></div>
      {solutions?.candidate_solutions?.length ? (
        <div className="grid2">
          {solutions.candidate_solutions.map((sol: any) => {
            const pre = sol.integration_precheck;
            const blockers = (pre?.issues || []).filter((i: any) => i.severity === "blocker");
            return (
              <div className="card" key={sol.solution_id}>
                <h3>{sol.solution_id} · {sol.name}{" "}
                  {chosen?.solution_id === sol.solution_id && <span className="badge ok">已确认</span>}
                  {solutions.recommended_solution === sol.solution_id && <span className="badge">推荐</span>}
                </h3>
                <p>{sol.summary}</p>
                <p className="readout">风险 {sol.risk_level} · 预计 {sol.implementation_hours}h · 接口预检{" "}
                  {pre?.passed ? <span className="badge ok">通过</span> : <span className="badge err">{blockers.length} 阻断</span>}
                </p>
                <table className="data">
                  <thead><tr><th>子系统</th><th>模块</th><th>覆盖需求</th></tr></thead>
                  <tbody>{(sol.blocks || []).map((b: any) => (
                    <tr key={b.block_id}><td>{b.name}</td><td className="readout">{b.module_id || b.module_name || "—"}</td>
                      <td className="readout">{(b.covers_requirements || []).join(" ")}</td></tr>
                  ))}</tbody>
                </table>
                {(pre?.issues || []).length > 0 && (
                  <ul style={{ fontSize: 12.5, paddingLeft: 18 }}>
                    {pre.issues.map((i: any, k: number) => (
                      <li key={k}><span className={"badge " + (i.severity === "blocker" ? "err" : "warn")}>{i.rule}</span> {i.message}</li>
                    ))}
                  </ul>
                )}
                {sol.uncovered_requirements?.length > 0 && (
                  <p className="hint">未覆盖需求：{sol.uncovered_requirements.join("、")}</p>
                )}
                <button className="btn ghost" onClick={() => onApprove(sol)}>确认采用此方案</button>
              </div>
            );
          })}
        </div>
      ) : <div className="empty">尚无候选方案。先完成赛题解析，再点「生成候选方案」。</div>}
    </>
  );
}

function ModulesTab({ bom, onFromSolution, onFromText, busy, hasSolution }: any) {
  const [raw, setRaw] = useState("");
  const [mods, setMods] = useState<any[]>([]);
  useEffect(() => { api("/api/modules").then((d) => setMods(d.modules || [])); }, []);
  const groups: Record<string, any[]> = {};
  for (const it of bom?.items || []) (groups[it.group || "必须具备"] ||= []).push(it);
  return (
    <>
      <h2>模块与 BOM</h2>
      <p className="lede">左：模块数据库（含认证状态与来源）。右：BOM 整理 —— 粘贴任意格式清单或从已确认方案生成，数量规则与人工审核标记由规则引擎处理。</p>
      <div className="grid2">
        <div className="card">
          <h3>模块数据库 <span className="badge">{mods.length}</span></h3>
          <table className="data">
            <thead><tr><th>模块</th><th>芯片</th><th>认证</th><th>来源</th></tr></thead>
            <tbody>{mods.map((m: any) => (
              <tr key={m.id}>
                <td><strong>{m.name}</strong><br /><span className="hint">{m.category}</span></td>
                <td className="readout">{m.main_chip || "—"}</td>
                <td><span className={"badge " + (m.certification_status === "COMPETITION_READY" ? "ok" : m.certification_status === "DRAFT" ? "" : "warn")}>{m.certification_status}</span></td>
                <td className="readout">{m.source_snapshot?.source || "lab"}{m.assets_locked ? " 🔒" : ""}</td>
              </tr>
            ))}</tbody>
          </table>
          <p className="hint">🔒 = 完整工程资料（原理图/PCB/代码）需付费账户且模块通过功能验证后可下载。实验室上传的模块进入 DRAFT 待审核。</p>
        </div>
        <div className="card">
          <h3>BOM 整理</h3>
          <textarea className="mono" rows={5} value={raw} onChange={(e) => setRaw(e.target.value)}
            placeholder={"粘贴任意格式物料清单，例如：\nMSPM0G3507 x2\n тб6612 电机驱动 3个\n0.1uF 电容若干"} />
          <div className="row">
            <button className="btn" onClick={() => onFromText(raw)} disabled={busy || !raw.trim()}>整理清单</button>
            <button className="btn ghost" onClick={onFromSolution} disabled={busy || !hasSolution}>从已确认方案生成</button>
          </div>
        </div>
      </div>
      {bom?.items?.length > 0 && (
        <div className="card">
          <h3>项目 BOM <span className="badge ok">{bom.items.length} 项</span></h3>
          {Object.entries(groups).map(([g, items]: any) => (
            <div key={g}>
              <h3 style={{ marginTop: 12 }}>{g}</h3>
              <table className="data">
                <thead><tr><th>型号</th><th>名称</th><th>数量</th><th>类型</th><th>置信度</th><th>审核</th></tr></thead>
                <tbody>{items.map((it: any) => (
                  <tr key={it.line_id}>
                    <td className="readout">{it.mpn}</td><td>{it.name}</td>
                    <td className="readout">{it.quantity}</td><td className="readout">{it.source_type}</td>
                    <td className="readout">{Math.round((it.confidence || 0) * 100)}%</td>
                    <td>{it.needs_review ? <span className="badge warn">需人工确认</span> : <span className="badge ok">OK</span>}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          ))}
          {bom.unresolved_items?.length > 0 && <p className="hint">未解析行：{bom.unresolved_items.join(" | ")}</p>}
        </div>
      )}
    </>
  );
}

function CodeTab({ bundle, onRun, busy }: any) {
  const [target, setTarget] = useState("");
  return (
    <>
      <h2>软件与代码</h2>
      <p className="lede">模块级生成（一次一个驱动/协议/算法模块），不一次性生成整个工程。生成状态为 GENERATED，编译通过前不得标记为可用 —— 未验证代码不会被冒充为"已验证"。</p>
      <div className="card">
        <input type="text" value={target} onChange={(e) => setTarget(e.target.value)}
          placeholder="要生成的模块，例如：K230 与 MSPM0 的 UART 协议帧收发（含 CRC）" />
        <div className="row">
          <button className="btn" onClick={() => onRun(target)} disabled={busy}>生成模块代码</button>
          <span className="hint">前置条件：方案已确认且接口检查无阻断（状态门禁）</span>
        </div>
      </div>
      {bundle?.files?.length ? (
        <>
          <div className="row"><span className="badge warn">verification: {bundle.verification_status}</span>
            {bundle.unsupported_items?.length > 0 && <span className="badge err">未确认 API × {bundle.unsupported_items.length}</span>}</div>
          {bundle.files.map((f: any) => (
            <div className="card" key={f.path}>
              <h3 className="readout">{f.path}</h3>
              {f.notes && <p className="hint">需人工验证：{f.notes}</p>}
              <pre className="json">{f.content}</pre>
            </div>
          ))}
        </>
      ) : <div className="empty">尚未生成代码。</div>}
    </>
  );
}

function DebugTab({ session, onRun, busy }: any) {
  const [symptom, setSymptom] = useState("");
  const [logs, setLogs] = useState("");
  return (
    <>
      <h2>调试助手 · LabSight</h2>
      <p className="lede">描述故障现象并粘贴串口日志/测量数据，输出按置信度排序的故障树与下一步测量动作。这是循环：拿到新测量结果再提交，假设会被更新。</p>
      <div className="card">
        <input type="text" value={symptom} onChange={(e) => setSymptom(e.target.value)} placeholder="故障现象，例如：电机一启动 MCU 就复位" />
        <textarea className="mono" rows={4} value={logs} onChange={(e) => setLogs(e.target.value)} placeholder="串口日志 / 示波器读数 / 万用表测量（可选）…" style={{ marginTop: 8 }} />
        <div className="row">
          <button className="btn" onClick={() => onRun(symptom, logs)} disabled={busy}>分析</button>
          <span className="hint">接入 LabSight 摄像头后可附 PCB 照片（API 已支持 images 字段）</span>
        </div>
      </div>
      {session ? (
        <div className="card">
          <h3>故障树</h3>
          <table className="data">
            <thead><tr><th>假设</th><th>置信度</th><th>证据</th></tr></thead>
            <tbody>{(session.hypotheses || []).map((h: any, i: number) => (
              <tr key={i}><td>{h.cause}</td>
                <td className="readout">{Math.round((h.confidence || 0) * 100)}%</td>
                <td className="hint">{(h.evidence || []).join("；")}</td></tr>
            ))}</tbody>
          </table>
          <h3 style={{ marginTop: 14 }}>下一步测量</h3>
          <table className="data">
            <thead><tr><th>仪器</th><th>测量点</th><th>预期</th><th>说明</th></tr></thead>
            <tbody>{(session.next_actions || []).map((a: any, i: number) => (
              <tr key={i}><td className="readout">{a.instrument}</td><td className="readout">{a.probe_point}</td>
                <td>{a.expect}</td><td className="hint">{a.note}</td></tr>
            ))}</tbody>
          </table>
          {session.safety_warnings?.length > 0 && (
            <p><span className="badge err">安全</span> {session.safety_warnings.join("；")}</p>
          )}
        </div>
      ) : <div className="empty">尚无调试会话。</div>}
    </>
  );
}

function ReportTab({ report, onRun, busy, projectId }: any) {
  return (
    <>
      <h2>报告与提交</h2>
      <p className="lede">报告 Agent 从项目真实数据（需求 / 最终方案 / BOM / 调试记录）生成，按电赛设计报告规范分章。数据缺失处用【待补充】占位 —— 不虚构测试数值，生成后自动做一致性检查。</p>
      <div className="row">
        <button className="btn" onClick={onRun} disabled={busy}>生成设计报告</button>
        {report && projectId && <a className="btn ghost" href={`/api/report?project_id=${projectId}`} style={{ textDecoration: "none" }}>下载 Markdown</a>}
      </div>
      {report?.consistency_issues?.length > 0 && (
        <div className="card">
          <h3>一致性检查 <span className="badge warn">{report.consistency_issues.length}</span></h3>
          <ul>{report.consistency_issues.map((c: string, i: number) => <li key={i}>{c}</li>)}</ul>
        </div>
      )}
      {report?.markdown ? <div className="report-md">{report.markdown}</div>
        : <div className="empty">尚未生成报告。前置条件：已确认方案。</div>}
    </>
  );
}
