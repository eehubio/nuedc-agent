// ============================================================
// 题目预测评分 —— "规则评分 + 检索统计 + LLM 解释"，不是纯大模型猜测。
// 预测分数 = 历年周期权重 + 器件清单相关度 + 新增器件权重
//          + 厂商技术方向权重 + 可测试性权重 - 与上一届重复惩罚
// 输出分档（高/中高/中等/低），数字仅用于排序，不宣称统计概率。
// ============================================================

export interface DirectionScoreInput {
  direction: string;              // 例如 "视觉智能车"
  years_since_last: number;       // 距上次出题届数
  device_list_hits: string[];     // 当年器件清单中相关器件
  new_device_hits: string[];      // 新增器件中的相关器件
  vendor_push_weight: number;     // 0-10：TI 等厂商当年推广力度
  testability_weight: number;     // 0-10：赛场可测试性
  appeared_last_year: boolean;
}

export interface DirectionScore {
  direction: string;
  score: number;
  band: "高可能" | "中高可能" | "中等可能" | "低可能";
  evidence: string[];
}

export function scoreDirection(inp: DirectionScoreInput): DirectionScore {
  let score = 0;
  const evidence: string[] = [];

  // 历年周期：3~4 届未出的方向权重最高
  const cycle = Math.min(inp.years_since_last, 5) * 6;
  score += cycle;
  if (inp.years_since_last >= 3) evidence.push(`已 ${inp.years_since_last} 届未出该方向`);

  score += inp.device_list_hits.length * 8;
  if (inp.device_list_hits.length) evidence.push(`器件清单相关：${inp.device_list_hits.join("、")}`);

  score += inp.new_device_hits.length * 12;
  if (inp.new_device_hits.length) evidence.push(`新增器件：${inp.new_device_hits.join("、")}`);

  score += inp.vendor_push_weight * 2;
  if (inp.vendor_push_weight >= 6) evidence.push("厂商当年重点推广方向");

  score += inp.testability_weight * 1.5;

  if (inp.appeared_last_year) {
    score -= 25;
    evidence.push("上届已出，重复惩罚 -25");
  }

  const band = score >= 70 ? "高可能" : score >= 50 ? "中高可能" : score >= 30 ? "中等可能" : "低可能";
  return { direction: inp.direction, score: Math.round(score), band, evidence };
}
