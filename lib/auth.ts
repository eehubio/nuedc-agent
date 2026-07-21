import type { NextRequest } from "next/server";
import type { UserTier, ModuleCertState } from "./types";
import { MODULE_CERT_STATES, PAID_DOWNLOAD_MIN_STATE } from "./types";

// ============================================================
// 鉴权策略：
//  - 独立部署：X-Api-Key 匹配 ADMIN_API_KEY → admin
//  - 嵌入 ezPLM：ezPLM 服务端用 EZPLM_API_KEY 调用，并在
//    X-User-Tier 头里声明用户等级（ezPLM 已经管理付费状态，
//    本应用信任其声明，不重复做一套账号体系）
//  - 其他请求 → free
// ============================================================

export function resolveTier(req: NextRequest): UserTier {
  const key = req.headers.get("x-api-key") || "";
  if (process.env.ADMIN_API_KEY && key === process.env.ADMIN_API_KEY) return "admin";
  if (process.env.EZPLM_API_KEY && key === process.env.EZPLM_API_KEY) {
    const declared = (req.headers.get("x-user-tier") || "free") as UserTier;
    return (["free", "paid", "lab", "admin"] as UserTier[]).includes(declared) ? declared : "free";
  }
  return "free";
}

export function canDownloadAssets(tier: UserTier, cert: ModuleCertState): boolean {
  if (tier === "admin" || tier === "lab") return true;
  if (tier === "paid") {
    return MODULE_CERT_STATES.indexOf(cert) >= MODULE_CERT_STATES.indexOf(PAID_DOWNLOAD_MIN_STATE);
  }
  return false; // 免费用户只能浏览基础资料
}

export function canReviewModules(tier: UserTier): boolean {
  return tier === "admin" || tier === "lab";
}

export function canUploadModules(tier: UserTier): boolean {
  return tier !== "free";
}

/** 免费用户可见的模块字段（隐藏原理图/PCB/代码仓库等完整资产） */
export function stripPaidFields(moduleData: any) {
  const { schematic_assets, pcb_assets, code_repositories, ...rest } = moduleData;
  return {
    ...rest,
    schematic_assets: [],
    pcb_assets: [],
    code_repositories: [],
    assets_locked: true,
  };
}
