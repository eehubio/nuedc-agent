import type { Requirement } from "../types";

/* 测试与评分 —— 纯规则部分。
 * 判定与得分不经过 LLM：给定实测值和需求指标（target ± tolerance），
 * 程序判定通过与否；得分估算 = 通过的分值占比区间。 */

export interface TestRecord {
  requirement_id: string;
  measured_value?: number | string;   // 实测值
  measured_unit?: string;
  pass_override?: boolean | null;     // 无法自动判定时的人工判定
  evidence?: string[];                // 图片/CSV/波形 URL 或说明
  tested_at?: string;
  repeats?: number;
}

export interface TestVerdict {
  requirement_id: string;
  auto_evaluable: boolean;
  passed: boolean | null;             // null = 未测/无法判定
  detail: string;
}

export interface ScoringItem {
  item: string;
  points: number | null;
  points_type: "official" | "estimated";
  requirement_ids: string[];
  source?: string;
}

export interface ScoreSummary {
  mandatory_total: number;
  mandatory_passed: number;
  bonus_total: number;
  bonus_passed: number;
  untested: number;
  blockers: string[];                 // 未通过的基本要求
  score_basis: "official" | "estimated";   // 分值口径：题面官方分值 / 60+40 结构估算
  official_total?: number;                 // 官方口径时的题面总分
  score_low: number;                  // 预计得分区间
  score_high: number;
  next_best_actions: string[];        // 收益最高的下一步（规则生成）
}

/** 解析 tolerance："±1%" | "±0.5" | "≤5" | "≥90" 等 */
function parseTolerance(tol?: string): { kind: "pct" | "abs" | "max" | "min"; v: number } | null {
  if (!tol) return null;
  const t = tol.replace(/\s/g, "");
  let m = t.match(/^[±+\-]?([\d.]+)%$/);
  if (m) return { kind: "pct", v: parseFloat(m[1]) };
  m = t.match(/^±([\d.]+)$/);
  if (m) return { kind: "abs", v: parseFloat(m[1]) };
  m = t.match(/^[≤<=]+([\d.]+)/);
  if (m) return { kind: "max", v: parseFloat(m[1]) };
  m = t.match(/^[≥>=]+([\d.]+)/);
  if (m) return { kind: "min", v: parseFloat(m[1]) };
  return null;
}

export function judge(req: Requirement, rec?: TestRecord): TestVerdict {
  const rid = req.id;
  if (!rec || (rec.measured_value == null && rec.pass_override == null)) {
    return { requirement_id: rid, auto_evaluable: false, passed: null, detail: "未录入实测数据" };
  }
  if (rec.pass_override != null) {
    return { requirement_id: rid, auto_evaluable: false, passed: rec.pass_override, detail: "人工判定" };
  }
  const measured = Number(rec.measured_value);
  const target = Number(req.target);
  const tol = parseTolerance(req.tolerance);
  if (Number.isNaN(measured)) {
    return { requirement_id: rid, auto_evaluable: false, passed: null, detail: "实测值非数值，需人工判定" };
  }
  // 只有误差约束、无标称值（如"停车误差≤5cm"）：直接用界限判定实测值
  if (Number.isNaN(target) && tol && (tol.kind === "max" || tol.kind === "min")) {
    const ok = tol.kind === "max" ? measured <= tol.v : measured >= tol.v;
    return { requirement_id: rid, auto_evaluable: true, passed: ok,
      detail: `实测 ${measured}（要求 ${tol.kind === "max" ? "≤" : "≥"}${tol.v}）` };
  }
  // 标称值 + 误差约束：按偏差判定
  if (!Number.isNaN(target) && tol) {
    let ok: boolean;
    let detail: string;
    if (tol.kind === "pct") {
      const dev = Math.abs(measured - target) / (Math.abs(target) || 1) * 100;
      ok = dev <= tol.v;
      detail = `偏差 ${dev.toFixed(2)}%（允许 ±${tol.v}%）`;
    } else if (tol.kind === "abs") {
      const dev = Math.abs(measured - target);
      ok = dev <= tol.v;
      detail = `偏差 ${dev}（允许 ±${tol.v}）`;
    } else if (tol.kind === "max") {
      ok = measured <= tol.v;
      detail = `实测 ${measured}（要求 ≤${tol.v}）`;
    } else {
      ok = measured >= tol.v;
      detail = `实测 ${measured}（要求 ≥${tol.v}）`;
    }
    return { requirement_id: rid, auto_evaluable: true, passed: ok, detail };
  }
  if (!Number.isNaN(target)) {
    // 无误差声明：默认"达到即通过"（measured ≥ target 视性能类；无法判方向时相等±5%）
    const dev = Math.abs(measured - target) / (Math.abs(target) || 1);
    const ok = measured >= target || dev <= 0.05;
    return { requirement_id: rid, auto_evaluable: true, passed: ok, detail: `实测 ${measured} / 指标 ${target}（未声明误差，按达标或 ±5% 判定，可人工覆盖）` };
  }
  return { requirement_id: rid, auto_evaluable: false, passed: null, detail: "指标非数值，需人工判定" };
}

export function computeScore(requirements: Requirement[], records: TestRecord[], scoringItems?: ScoringItem[]): { verdicts: TestVerdict[]; summary: ScoreSummary } {
  const active = requirements.filter((r) => r.status !== "REJECTED");
  const recMap = new Map(records.map((r) => [r.requirement_id, r]));
  const verdicts = active.map((r) => judge(r, recMap.get(r.id)));
  const vMap = new Map(verdicts.map((v) => [v.requirement_id, v]));

  const mand = active.filter((r) => r.priority === "mandatory");
  const bonus = active.filter((r) => r.priority !== "mandatory");
  const mp = mand.filter((r) => vMap.get(r.id)?.passed === true).length;
  const bp = bonus.filter((r) => vMap.get(r.id)?.passed === true).length;
  const untested = verdicts.filter((v) => v.passed === null).length;
  const blockers = mand.filter((r) => vMap.get(r.id)?.passed === false).map((r) => `${r.id} ${r.description.slice(0, 24)}`);

  // ---- 官方口径：题面明示分值 + requirement 关联 ----
  const official = (scoringItems || []).filter((s) => s.points_type === "official" && typeof s.points === "number" && s.requirement_ids?.length);
  if (official.length) {
    const total = official.reduce((a, s) => a + (s.points as number), 0);
    let low = 0, high = 0;
    for (const item of official) {
      const linked = item.requirement_ids.map((id) => vMap.get(id)).filter(Boolean);
      if (!linked.length) { high += item.points as number; continue; }   // 未关联到判定 → 视为未测
      const passed = linked.filter((v) => v!.passed === true).length;
      const failed = linked.filter((v) => v!.passed === false).length;
      const frac = passed / linked.length;
      low += (item.points as number) * frac;
      high += (item.points as number) * (failed ? frac : 1);             // 未测部分计入上限
    }
    return {
      verdicts,
      summary: {
        mandatory_total: mand.length, mandatory_passed: mp,
        bonus_total: bonus.length, bonus_passed: bp,
        untested, blockers,
        score_basis: "official", official_total: total,
        score_low: Math.round(low), score_high: Math.round(Math.min(total, high)),
        next_best_actions: blockers.length ? [`优先修复未通过的基本要求：${blockers[0]}`]
          : untested ? [`还有 ${untested} 项未测，按官方分值口径它们决定得分上限`]
          : ["全部通过 —— 按官方评分表整理测试证据进报告"],
      },
    };
  }

  // ---- 估算口径：电赛通行结构 基本约 60 / 发挥约 40 ----
  const mandScore = mand.length ? (mp / mand.length) * 60 : 0;
  const bonusScore = bonus.length ? (bp / bonus.length) * 40 : 0;
  const mandUntested = mand.filter((r) => vMap.get(r.id)?.passed === null).length;
  const bonusUntested = bonus.filter((r) => vMap.get(r.id)?.passed === null).length;
  const high = mandScore + bonusScore
    + (mand.length ? (mandUntested / mand.length) * 60 : 0)
    + (bonus.length ? (bonusUntested / bonus.length) * 40 : 0);

  const actions: string[] = [];
  if (blockers.length) actions.push(`优先修复未通过的基本要求：${blockers[0]}`);
  if (mandUntested) actions.push(`还有 ${mandUntested} 条基本要求未测 —— 基本分每条价值约 ${(60 / Math.max(mand.length, 1)).toFixed(0)} 分，先测它们`);
  if (!blockers.length && !mandUntested && bonusUntested) actions.push(`基本要求已全部通过，开始测发挥项（还剩 ${bonusUntested} 条）`);
  if (!untested && !blockers.length) actions.push("全部通过 —— 把测试数据整理进报告的测试章节");

  return {
    verdicts,
    summary: {
      mandatory_total: mand.length, mandatory_passed: mp,
      bonus_total: bonus.length, bonus_passed: bp,
      untested, blockers,
      score_basis: "estimated",
      score_low: Math.round(mandScore + bonusScore),
      score_high: Math.round(Math.min(100, high)),
      next_best_actions: actions,
    },
  };
}
