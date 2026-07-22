"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { callAgent, api, getEmbedParams, emitToEzplm } from "./api";
import { HomePage, ModulesPage, ProjectsPage } from "./pages-core";
import { SolutionPage, WiringPage, CodePage, DebugPage, ReportPage } from "./pages-build";
import { BomPage, TestingPage } from "./pages-work";

export const STAGES = [
  "PREPARATION","PROBLEM_RECEIVED","REQUIREMENTS_PARSED","SOLUTION_CANDIDATES","SOLUTION_APPROVED",
  "BOM_CONFIRMED","HARDWARE_BUILD","SOFTWARE_BUILD","INTEGRATION","TESTING","OPTIMIZATION","REPORTING","SUBMITTED",
] as const;
export const STAGE_LABEL: Record<string, string> = {
  PREPARATION:"备赛", PROBLEM_RECEIVED:"拿题", REQUIREMENTS_PARSED:"需求解析", SOLUTION_CANDIDATES:"候选方案",
  SOLUTION_APPROVED:"方案确认", BOM_CONFIRMED:"BOM确认", HARDWARE_BUILD:"硬件搭建", SOFTWARE_BUILD:"软件开发",
  INTEGRATION:"联调", TESTING:"测试", OPTIMIZATION:"优化", REPORTING:"报告", SUBMITTED:"提交",
};

const NAV = [
  { key: "home",     label: "首页",     icon: "🏠" },
  { key: "solution", label: "方案生成", icon: "🧠" },
  { key: "modules",  label: "模块选型", icon: "🔲" },
  { key: "wiring",   label: "电路连线", icon: "🔌" },
  { key: "bom",      label: "物料清单", icon: "📦" },
  { key: "code",     label: "代码生成", icon: "⌨️" },
  { key: "debug",    label: "调试助手", icon: "🔬" },
  { key: "testing",  label: "测试评分", icon: "🧪" },
  { key: "projects", label: "我的项目", icon: "📁" },
  { key: "report",   label: "报告生成", icon: "📄" },
] as const;
const NAV_SOON = [
  { label: "仿真验证", icon: "📈" },
  { label: "实验平台", icon: "⚗️" },
];
export type PageKey = (typeof NAV)[number]["key"];
const PAGE_TITLE: Record<PageKey, string> = {
  home: "首页", solution: "方案生成", modules: "模块选型",
  wiring: "电路连线与接口检查", bom: "物料清单（BOM 工作台）", code: "代码生成",
  debug: "调试助手（LabSight）", testing: "测试与评分",
  report: "报告生成", projects: "我的项目",
};

export interface Msg { who: "user" | "agent"; text: string }

export default function Platform({ embed }: { embed: boolean }) {
  const params = useMemo(getEmbedParams, []);
  const [page, setPage] = useState<PageKey>("home");
  const [projectId, setProjectId] = useState<string | null>(null);
  const [projects, setProjects] = useState<any[]>([]);
  const [stage, setStage] = useState<string>("PREPARATION");
  const [busy, setBusy] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([
    { who: "agent", text: "你好，我是电赛设计助手。把赛题原文粘贴给我，或点击下方典型方向快速开始 —— 我会先帮你把题目拆成可核对的指标清单，确认后再生成两套候选方案。" },
  ]);

  // 项目内产物（跨页共享）
  const [problemText, setProblemText] = useState("");
  const [requirements, setRequirements] = useState<any>(null);
  const [solutions, setSolutions] = useState<any>(null);
  const [chosenSolution, setChosenSolution] = useState<any>(null);
  const [wiringReport, setWiringReport] = useState<any>(null);
  const [bom, setBom] = useState<any>(null);
  const [codeBundle, setCodeBundle] = useState<any>(null);
  const [debugSession, setDebugSession] = useState<any>(null);
  const [report, setReport] = useState<any>(null);
  const [modules, setModules] = useState<any[]>([]);
  const [backupSolution, setBackupSolution] = useState<any>(null);   // 备用方案
  const [testPlan, setTestPlan] = useState<any>(null);
  const [testRecords, setTestRecords] = useState<any[]>([]);
  const [testResult, setTestResult] = useState<any>(null);           // verdicts + summary
  const [shortlist, setShortlist] = useState<string[]>([]); // 模块选型页「选用」的备选模块

  const say = useCallback((who: Msg["who"], text: string) => {
    setMsgs((m) => [...m, { who, text }]);
  }, []);

  // ---- 初始加载：项目列表 + 模块库 ----
  useEffect(() => {
    api("/api/projects").then((d) => setProjects(d.projects || [])).catch(() => {});
    api(`/api/modules?tier=${params.tier}`).then((d) => setModules(d.modules || [])).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!projectId) return;
    api(`/api/projects/${projectId}`).then((d) => {
      if (d.project) {
        setStage(String(d.project.stage));
        if (d.project.problem_text) setProblemText(String(d.project.problem_text));
      }
      for (const a of d.artifacts || []) {
        if (a.type === "requirements") setRequirements((v: any) => v ?? a.content);
        if (a.type === "solution_proposal") setSolutions((v: any) => v ?? a.content);
        if (a.type === "bom") setBom((v: any) => v ?? a.content);
        if (a.type === "report") setReport((v: any) => v ?? a.content);
      }
    });
  }, [projectId]);

  // ---- ezPLM → 智能体 消息桥 ----
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (!e.data?.__ezplm) return;
      if (e.data.type === "set_problem") { setProblemText(String(e.data.payload || "")); setPage("solution"); }
      if (e.data.type === "set_project") setProjectId(String(e.data.payload || "") || null);
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  async function ensureProject(seedProblem?: string): Promise<string> {
    if (projectId) return projectId;
    const d = await api("/api/projects", {
      method: "POST",
      body: JSON.stringify({
        name: "电赛项目 " + new Date().toLocaleDateString(),
        problem_text: seedProblem || problemText,
        ezplm_project_id: params.ezplmProjectId,
      }),
    });
    setProjectId(d.project_id);
    api("/api/projects").then((r) => setProjects(r.projects || []));
    return d.project_id;
  }

  async function advanceStage(to: string, pid?: string) {
    const id = pid || projectId;
    if (!id) return;
    await api(`/api/projects/${id}`, { method: "PATCH", body: JSON.stringify({ stage: to }) });
    setStage(to);
    emitToEzplm("stage_changed", { project_id: id, stage: to });
  }

  function resetProject() {
    setProjectId(null); setStage("PREPARATION"); setProblemText("");
    setRequirements(null); setSolutions(null); setChosenSolution(null);
    setWiringReport(null); setBom(null); setCodeBundle(null); setDebugSession(null); setReport(null);
    setMsgs((m) => m.slice(0, 1));
  }

  // ============ Agent 动作 ============

  /** 赛题解析：对话式入口（方案生成页） */
  async function runInterpret(text: string) {
    const t = (text || problemText).trim();
    if (!t) { say("agent", "请先粘贴赛题原文或描述设计需求。"); return; }
    setProblemText(t);
    setBusy(true);
    say("user", t.length > 160 ? t.slice(0, 160) + "…" : t);
    let r: any, pid: string | null = null;
    try {
      pid = await ensureProject(t);
      if (!pid) { say("agent", "项目创建失败，请检查数据库连接后重试。"); return; }
      await api(`/api/projects/${pid}`, { method: "PATCH", body: JSON.stringify({ problem_text: t, stage: "PROBLEM_RECEIVED" }) });
      setStage("PROBLEM_RECEIVED");
      r = await callAgent("problem_interpreter", { problem_text: t }, pid);
    } finally { setBusy(false); }
    if (r.ok) {
      setRequirements(r.output);
      const amb = r.output?.ambiguities?.length || 0;
      say("agent", `已把题目拆成 ${r.output?.requirements?.length ?? 0} 条可核对指标（见右侧）。` +
        (amb ? `其中 ${amb} 处题面有歧义，我按常规理解做了标注，请核对。` : "") +
        `\n确认无误后点「生成候选方案」，我会给出两套不同取舍的方案。`);
      await advanceStage("REQUIREMENTS_PARSED", pid || undefined);
      emitToEzplm("requirements_ready", r.output);
    } else say("agent", "解析失败：" + (r.message || ""));
  }

  // ============ 需求编辑器动作 ============
  function updateRequirement(id: string, patch: any) {
    setRequirements((rq: any) => ({
      ...rq,
      requirements: (rq.requirements || []).map((r: any) => r.id === id ? { ...r, ...patch } : r),
    }));
  }
  function setReqStatus(id: string, status: string) {
    updateRequirement(id, { status, confirmed_at: status === "CONFIRMED" ? new Date().toISOString() : undefined });
  }
  function confirmAllExtracted() {
    setRequirements((rq: any) => ({
      ...rq,
      requirements: (rq.requirements || []).map((r: any) =>
        !r.status || r.status === "AI_EXTRACTED" ? { ...r, status: "CONFIRMED", confirmed_at: new Date().toISOString() } : r),
    }));
  }
  function addRequirement() {
    setRequirements((rq: any) => {
      const list = rq?.requirements || [];
      const nextId = "REQ-" + String(list.length + 1).padStart(3, "0") + "M";
      return { ...(rq || {}), requirements: [...list, {
        id: nextId, type: "functional", description: "", priority: "mandatory",
        source: "人工补充", verification_method: "measurement", status: "CONFIRMED",
        confirmed_at: new Date().toISOString(),
      }] };
    });
  }

  // ============ 方案编辑动作 ============
  async function replaceBlock(solutionId: string, blockId: string, mod: any) {
    const apply = (sol: any) => sol.solution_id !== solutionId ? sol : {
      ...sol,
      blocks: sol.blocks.map((b: any) => b.block_id === blockId
        ? { ...b, module_id: mod.id, name: mod.name.length > 14 ? mod.name.slice(0, 14) : mod.name }
        : b),
      integration_precheck: undefined,   // 改动后预检失效
    };
    let updated: any = null;
    setSolutions((ss: any) => {
      if (!ss) return ss;
      const next = { ...ss, solutions: ss.solutions.map(apply) };
      updated = next.solutions.find((x: any) => x.solution_id === solutionId);
      return next;
    });
    setChosenSolution((c: any) => (c?.solution_id === solutionId ? apply(c) : c));
    setBackupSolution((c: any) => (c?.solution_id === solutionId ? apply(c) : c));
    // 改动后立刻重跑接口检查（规则引擎，快）
    setBusy(true);
    const target = updated || (chosenSolution?.solution_id === solutionId ? apply(chosenSolution) : null);
    if (target) {
      const r = await callAgent("integration_checker", { solution: target }, projectId);
      if (r.ok) {
        const attach = (sol: any) => sol.solution_id === solutionId ? { ...sol, integration_precheck: r.output } : sol;
        setSolutions((ss: any) => ss ? { ...ss, solutions: ss.solutions.map(attach) } : ss);
        setChosenSolution((c: any) => c ? attach(c) : c);
        setBackupSolution((c: any) => c ? attach(c) : c);
        if (chosenSolution?.solution_id === solutionId) setWiringReport(r.output);
        say("agent", `已把模块替换为「${mod.name}」并重跑接口检查：${r.output.passed ? "通过 ✓" : `发现 ${r.output.issues.filter((i: any) => i.severity === "blocker").length} 个阻断项`}`);
      }
    }
    setBusy(false);
  }
  function markBackup(sol: any) {
    setBackupSolution(sol);
    say("agent", `已将 ${sol.solution_id}「${sol.name}」标记为备用方案。主方案受阻时可一键切换。`);
  }
  function swapToBackup() {
    if (!backupSolution) return;
    const prev = chosenSolution;
    setChosenSolution(backupSolution);
    setBackupSolution(prev);
    setWiringReport(backupSolution.integration_precheck || null);
    say("agent", `已切换到备用方案 ${backupSolution.solution_id}。原主方案转为备用。`);
  }

  // ============ 测试评分动作 ============
  async function runTestPlan() {
    if (!requirements) return { ok: false, message: "请先完成需求确认" } as any;
    setBusy(true);
    if (projectId && ["BOM_CONFIRMED", "HARDWARE_BUILD", "SOFTWARE_BUILD", "INTEGRATION"].includes(stage)) await advanceStage("TESTING");
    const r = await callAgent("test_scoring", { requirements, records: testRecords }, projectId);
    setBusy(false);
    if (r.ok) { setTestPlan(r.output.plan); setTestResult(r.output); }
    return r;
  }
  async function runScore(records: any[]) {
    setTestRecords(records);
    setBusy(true);
    const r = await callAgent("test_scoring", { requirements, records, existing_plan: testPlan, generate_plan: false }, projectId);
    setBusy(false);
    if (r.ok) setTestResult(r.output);
    return r;
  }

  // ============ 代码验证动作 ============
  async function runVerify() {
    if (!codeBundle?.files?.length) return { ok: false, message: "请先生成代码" } as any;
    setBusy(true);
    const r = await callAgent("code_verifier", { files: codeBundle.files }, projectId);
    setBusy(false);
    if (r.ok) setCodeBundle((b: any) => ({ ...b, verification_status: r.output.verification_status, verify_issues: r.output.issues, honest_note: r.output.honest_note }));
    return r;
  }

  async function runSolution() {
    if (!requirements) { say("agent", "请先把赛题发给我完成需求解析。"); return; }
    setBusy(true);
    say("user", "生成候选方案");
    say("agent", "正在设计两套候选方案（含框图与接口预检），通常需要 1~2 分钟，请稍候……");
    const r = await callAgent("solution_architect", {
      requirements,
      preferred_modules: shortlist.length ? shortlist : undefined,
    }, projectId);
    setBusy(false);
    if (r.ok) {
      setSolutions(r.output);
      const n = r.output?.solutions?.length ?? 0;
      say("agent", `已生成 ${n} 套候选方案（含框图与接口预检，见右侧）。两套方案的取舍不同，请对比后人工确认一套 —— 这是硬性流程，方案不确认无法进入 BOM 和代码。`);
      if (projectId) await advanceStage("SOLUTION_CANDIDATES");
    } else say("agent", "生成失败：" + (r.message || ""));
  }

  async function approveSolution(sol: any) {
    setChosenSolution(sol);
    const pre = sol.integration_precheck;
    say("agent", `已确认方案 ${sol.solution_id}「${sol.name}」。接口预检${pre?.passed ? "通过 ✓" : `发现 ${pre?.issues?.filter((i: any) => i.severity === "blocker").length ?? 0} 个阻断项`}` +
      (pre?.passed ? "，可以进入模块 BOM 和代码生成。" : "，请到「电路连线」页处理后再进代码生成。"));
    if (projectId) await advanceStage("SOLUTION_APPROVED");
    emitToEzplm("solution_approved", { solution_id: sol.solution_id });
  }

  async function runWiringCheck() {
    if (!chosenSolution) return null;
    setBusy(true);
    const r = await callAgent("integration_checker", { solution: chosenSolution }, projectId);
    setBusy(false);
    if (r.ok) setWiringReport(r.output);
    return r;
  }

  async function runBomFromSolution() {
    if (!chosenSolution) { say("agent", "请先在「方案生成」页确认一套方案。"); return; }
    setBusy(true);
    const r = await callAgent("bom_agent", { solution: chosenSolution }, projectId);
    setBusy(false);
    if (r.ok) {
      setBom(r.output);
      if (projectId) await advanceStage("BOM_CONFIRMED");
      emitToEzplm("bom_ready", r.output);
    }
    return r;
  }

  async function runBomFromText(raw: string) {
    setBusy(true);
    const r = await callAgent("bom_agent", { raw_bom: raw }, projectId);
    setBusy(false);
    if (r.ok) { setBom(r.output); emitToEzplm("bom_ready", r.output); }
    return r;
  }

  async function runCode(target: string) {
    if (!chosenSolution) return { ok: false, message: "代码生成需要已确认的方案（状态门禁）" } as any;
    const pre = wiringReport || chosenSolution.integration_precheck;
    if (pre && !pre.passed) return { ok: false, message: "接口检查存在阻断项，禁止进入代码生成 —— 请先到「电路连线」页处理" } as any;
    setBusy(true);
    if (projectId && stage === "SOLUTION_APPROVED") await advanceStage("BOM_CONFIRMED");
    const r = await callAgent("code_generator", { solution: chosenSolution, target_module: target }, projectId);
    setBusy(false);
    if (r.ok) setCodeBundle(r.output);
    return r;
  }

  async function runDebug(symptom: string, logs: string, images: { media_type: string; data_base64: string }[]) {
    setBusy(true);
    const r = await callAgent("labsight_debug", {
      symptom, logs, images: images.length ? images : undefined,
      context: { solution: chosenSolution?.name },
      history: debugSession ? [debugSession] : [],
    }, projectId);
    setBusy(false);
    if (r.ok) setDebugSession(r.output);
    return r;
  }

  async function runReport(opts: { includeBom: boolean; includeCode: boolean; includeDebug: boolean }) {
    if (!chosenSolution) return { ok: false, message: "报告必须基于已确认方案生成（请先完成方案确认）" } as any;
    setBusy(true);
    if (projectId) await advanceStage("REPORTING");
    const r = await callAgent("report_composer", {
      requirements,
      solution: chosenSolution,
      bom: opts.includeBom ? bom : null,
      code_files: opts.includeCode ? codeBundle?.files?.map((f: any) => f.path) : null,
      test_results: null,
      debug_notes: opts.includeDebug && debugSession ? [debugSession.symptom] : [],
    }, projectId);
    setBusy(false);
    if (r.ok) { setReport(r.output); emitToEzplm("report_ready", { project_id: projectId }); }
    return r;
  }

  /** 方案页对话：长文本视为赛题；已有需求后的短文本走总控 */
  async function chat(text: string) {
    const t = text.trim();
    if (!t) return;
    if (!requirements && t.length > 60) return runInterpret(t);
    say("user", t);
    setBusy(true);
    const r = await callAgent("orchestrator", { user_request: t, context: { stage, has_requirements: !!requirements, has_solution: !!chosenSolution } }, projectId);
    setBusy(false);
    if (r.ok) {
      const o = r.output;
      say("agent", (o.reply || "") + (o.tasks?.length ? "\n\n建议步骤：\n" + o.tasks.map((tk: any) => `· ${tk.task}`).join("\n") : ""));
    } else say("agent", r.message || "调用失败");
  }

  function startFromDirection(seed: string) {
    setPage("solution");
    runInterpret(seed);
  }

  const stageIdx = STAGES.indexOf(stage as any);
  const ctx = {
    params, busy, stage, stageIdx, projectId, projects, setProjectId, resetProject,
    problemText, setProblemText, requirements, solutions, chosenSolution,
    wiringReport, bom, codeBundle, debugSession, report, modules, shortlist, setShortlist,
    backupSolution, testPlan, testRecords, testResult,
    msgs, chat, runInterpret, runSolution, approveSolution, runWiringCheck,
    runBomFromSolution, runBomFromText, runCode, runDebug, runReport, startFromDirection,
    updateRequirement, setReqStatus, confirmAllExtracted, addRequirement,
    replaceBlock, markBackup, swapToBackup, runTestPlan, runScore, runVerify,
    setPage, advanceStage,
  };

  return (
    <div className={"shell" + (embed ? " embed" : "")}>
      <aside className="sidebar">
        <div className="logo">
          <div className="mark">电</div>
          <div><b>电赛智能体</b><small>NUEDC AGENT</small></div>
        </div>
        {NAV.map((n) => (
          <button key={n.key} className={"navitem" + (page === n.key ? " active" : "")} onClick={() => setPage(n.key)}>
            <span className="ic">{n.icon}</span>{n.label}
          </button>
        ))}
        {NAV_SOON.map((n) => (
          <button key={n.label} className="navitem disabled" disabled>
            <span className="ic">{n.icon}</span>{n.label}<span className="soon">二期</span>
          </button>
        ))}
        <div className="promo">
          <b>2026 电赛备战</b>
          <p>方案 + 代码 + 调试 + 报告<br />一站式备赛</p>
          <div className="stage-mini" title={`当前阶段：${STAGE_LABEL[stage]}`}>
            {STAGES.map((s, i) => <i key={s} className={i <= stageIdx ? "on" : ""} />)}
          </div>
        </div>
      </aside>

      <div className="workarea">
        <header className="topbar">
          <h1>{PAGE_TITLE[page]}</h1>
          <span className="crumb">{busy ? <><span className="spinner" /> 智能体运行中…</> : ""}</span>
          <select value={projectId || ""} onChange={(e) => setProjectId(e.target.value || null)} aria-label="选择项目">
            <option value="">— 选择项目 —</option>
            {projects.map((p) => <option key={p.project_id} value={p.project_id}>{p.name}</option>)}
          </select>
          <span className="stagepill">{STAGE_LABEL[stage] || stage}</span>
          <button className="btn ghost sm" onClick={resetProject}>新建项目</button>
        </header>

        {page !== "home" && (
          <nav className="worktabs" aria-label="工作流程">
            {NAV.filter((n) => n.key !== "home").map((n) => (
              <button key={n.key} className={page === n.key ? "active" : ""} onClick={() => setPage(n.key)}>
                <span className="ic">{n.icon}</span>{n.label}
              </button>
            ))}
          </nav>
        )}

        <div className="page">
          {page === "home" && <HomePage ctx={ctx} />}
          {page === "solution" && <SolutionPage ctx={ctx} />}
          {page === "modules" && <ModulesPage ctx={ctx} />}
          {page === "wiring" && <WiringPage ctx={ctx} />}
          {page === "bom" && <BomPage ctx={ctx} />}
          {page === "code" && <CodePage ctx={ctx} />}
          {page === "debug" && <DebugPage ctx={ctx} />}
          {page === "testing" && <TestingPage ctx={ctx} />}
          {page === "report" && <ReportPage ctx={ctx} />}
          {page === "projects" && <ProjectsPage ctx={ctx} />}
        </div>
      </div>
    </div>
  );
}
