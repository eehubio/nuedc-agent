// ============================================================
// NUEDC Agent — 核心类型
// 设计原则（来自方案文档）：
//  1) Agent 之间不传聊天记录，只传 Task / Artifact / Review / Event 四种对象
//  2) 项目状态机决定允许调用哪些 Agent
//  3) 模块必须结构化（接口/电气/认证状态），否则只能"推荐"不能"组合"
// ============================================================

// ---------- 项目状态机 ----------
export const PROJECT_STAGES = [
  "PREPARATION",          // 备赛
  "PROBLEM_RECEIVED",     // 已拿到赛题
  "REQUIREMENTS_PARSED",  // 需求解析完成
  "SOLUTION_CANDIDATES",  // 候选方案已生成
  "SOLUTION_APPROVED",    // 方案已人工确认
  "BOM_CONFIRMED",        // BOM 已确认
  "HARDWARE_BUILD",
  "SOFTWARE_BUILD",
  "INTEGRATION",
  "TESTING",
  "OPTIMIZATION",
  "REPORTING",
  "SUBMITTED",
] as const;
export type ProjectStage = (typeof PROJECT_STAGES)[number];

// 每个状态允许调用的 Agent（状态门禁）
export const STAGE_ALLOWED_AGENTS: Record<ProjectStage, AgentType[]> = {
  PREPARATION: ["orchestrator", "topic_forecast", "module_knowledge", "bom_agent", "procurement_planner"],
  PROBLEM_RECEIVED: ["orchestrator", "problem_interpreter", "module_knowledge"],
  REQUIREMENTS_PARSED: ["orchestrator", "solution_architect", "module_knowledge", "integration_checker"],
  SOLUTION_CANDIDATES: ["orchestrator", "solution_architect", "integration_checker", "module_knowledge", "bom_agent"],
  SOLUTION_APPROVED: ["orchestrator", "bom_agent", "procurement_planner", "integration_checker", "code_generator"],
  BOM_CONFIRMED: ["orchestrator", "code_verifier", "code_generator", "integration_checker", "labsight_debug"],
  HARDWARE_BUILD: ["orchestrator", "labsight_debug", "module_knowledge", "integration_checker"],
  SOFTWARE_BUILD: ["orchestrator", "code_verifier", "code_generator", "labsight_debug"],
  INTEGRATION: ["orchestrator", "code_verifier", "integration_checker", "labsight_debug", "code_generator"],
  TESTING: ["orchestrator", "code_verifier", "labsight_debug", "test_scoring"],
  OPTIMIZATION: ["orchestrator", "test_scoring", "code_generator", "labsight_debug"],
  REPORTING: ["orchestrator", "report_composer", "test_scoring"],
  SUBMITTED: ["orchestrator"],
};

// ---------- Agent 类型 ----------
export const CODE_VERIFY_STATES = ["GENERATED", "SYNTAX_CHECKED", "COMPILED", "UNIT_TESTED", "HIL_TESTED", "FIELD_VERIFIED"] as const;
export type CodeVerifyState = (typeof CODE_VERIFY_STATES)[number];

export const AGENT_TYPES = [
  "orchestrator",         // 总控编排
  "problem_interpreter",  // 赛题理解
  "topic_forecast",       // 题目预测
  "bom_agent",            // 物料清单整理
  "module_ingestion",     // 模块采集（淘宝/实验室）
  "module_review",        // 模块审核
  "module_knowledge",     // 模块知识库检索推荐
  "solution_architect",   // 方案生成
  "integration_checker",  // 接口与集成检查（纯规则，不用 LLM）
  "procurement_planner",  // 备料规划
  "code_generator",       // 代码生成
  "code_verifier",        // 代码验证（二期，预留）
  "labsight_debug",       // LabSight 调试助手
  "test_scoring",         // 测试评分（二期，预留）
  "report_composer",      // 报告生成
] as const;
export type AgentType = (typeof AGENT_TYPES)[number];

// ---------- Agent 间传递的四种标准对象 ----------
export interface AgentTask {
  task_id: string;
  project_id: string | null;
  agent_type: AgentType;
  objective: string;
  inputs: Record<string, unknown>;
  constraints?: string[];
  priority?: "high" | "normal" | "low";
}

export interface Artifact {
  artifact_id: string;
  project_id: string | null;
  type:
    | "requirements"
    | "forecast"
    | "solution_proposal"
    | "integration_report"
    | "bom"
    | "procurement_plan"
    | "code_bundle"
    | "debug_session"
    | "report"
    | "module_recommendation";
  version: number;
  status: "draft" | "reviewed" | "approved" | "rejected";
  created_by: AgentType | "human";
  content: unknown;
  created_at?: string;
}

export interface Review {
  review_id: string;
  artifact_id: string;
  reviewer: AgentType | "human";
  result: "approved" | "changes_required" | "rejected";
  issues: { severity: "high" | "medium" | "low"; message: string }[];
}

export interface AgentEvent {
  event_type: string;
  project_id?: string;
  task_id?: string;
  payload: unknown;
  timestamp: string;
}

// ---------- 模块认证状态机 ----------
export const MODULE_CERT_STATES = [
  "DRAFT",             // 草稿
  "DOCUMENTED",        // 资料已完整
  "POWER_TESTED",      // 已上电测试
  "FUNCTION_TESTED",   // 功能已验证
  "BENCHMARKED",       // 指标已验证
  "COMPETITION_READY", // 电赛可用
  "DEPRECATED",        // 已废弃
] as const;
export type ModuleCertState = (typeof MODULE_CERT_STATES)[number];

// 只有达到该状态及以上，模块的完整工程资料才对付费用户开放下载
export const PAID_DOWNLOAD_MIN_STATE: ModuleCertState = "FUNCTION_TESTED";

export type ModuleSourceType = "official" | "taobao" | "lab" | "opensource";

// ---------- 需求对象（赛题理解 Agent 输出）----------
export const REQ_STATUSES = ["AI_EXTRACTED", "NEEDS_REVIEW", "CONFIRMED", "REJECTED", "AMBIGUOUS"] as const;
export type ReqStatus = (typeof REQ_STATUSES)[number];

export interface Requirement {
  id: string;                       // REQ-001
  type: "functional" | "performance" | "constraint" | "bonus";
  description: string;
  target?: number | string;
  unit?: string;
  tolerance?: string;               // 允许误差，如 "±1%" / "≤5cm"
  priority: "mandatory" | "bonus";
  source: string;                   // 出自赛题哪一条（原文引用）
  verification_method: "measurement" | "demonstration" | "inspection" | "analysis";
  status?: ReqStatus;               // 需求确认工作流：AI 提取 → 人工确认/驳回
  confirmed_at?: string;
}

// ---------- 方案对象 ----------
export interface SolutionBlock {
  block_id: string;
  name: string;                     // 例如 "主控" / "视觉" / "电机驱动"
  module_id?: string;               // 关联模块库
  module_name?: string;
  role: string;
  covers_requirements: string[];    // REQ id 列表
}

export interface SolutionConnection {
  from: string;                     // "K230.UART1_TX"
  to: string;                       // "MSPM0.UART0_RX"
  protocol: string;
  voltage_from?: number;
  voltage_to?: number;
  note?: string;
}

export interface SolutionProposal {
  solution_id: string;              // SOL-A
  name: string;
  summary: string;
  blocks: SolutionBlock[];
  connections: SolutionConnection[];
  power_tree: { rail: string; voltage: number; source: string; loads: string[]; budget_ma?: number }[];
  advantages: string[];
  disadvantages: string[];
  risk_level: "low" | "medium" | "high";
  implementation_hours: number;
  uncovered_requirements: string[];
}

// ---------- BOM ----------
export interface BomItem {
  line_id: string;
  mpn: string;
  name: string;
  manufacturer?: string;
  category: string;
  package?: string;
  quantity: number;
  source_type: "component" | "module";
  inventory_status?: "available" | "shortage" | "unknown";
  substitutes?: string[];
  unit_price?: number;
  purchase_url?: string;
  confidence: number;               // 型号识别置信度；<0.8 需人工确认
  needs_review?: boolean;
  group?: "必须具备" | "建议备份" | "可选发挥" | "通用耗材" | "机械材料" | "高风险短缺";
}

// ---------- 用户分级 ----------
export type UserTier = "free" | "paid" | "lab" | "admin";
