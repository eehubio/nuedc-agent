import { NextRequest, NextResponse } from "next/server";
import { db, ensureSchema } from "@/lib/db";
import { moduleInputSchema, zodMessage } from "@/lib/module-schema";
import { resolveTier, canUploadModules, canDownloadAssets, stripPaidFields } from "@/lib/auth";
import type { ModuleCertState } from "@/lib/types";
import { queryCapabilities, audit } from "@/lib/module-query";

export const runtime = "nodejs";
export async function OPTIONS() { return new NextResponse(null, { status: 204 }); }

export async function GET(req: NextRequest) {
  await ensureSchema();
  const tier = resolveTier(req);
  const sp = new URL(req.url).searchParams;
  const num = (k: string) => (sp.get(k) === null ? undefined : Number(sp.get(k)));
  const bool = (k: string) => (sp.get(k) === null ? undefined : ["true", "1"].includes(sp.get(k)!));

  // 能力查询（对齐 genesis-platform /api/v1/modules/query）：
  //   ?interface=SPI&vAtMost=3.3&tolerant5v=false  → 找需要电平转换的 3.3V SPI 模块
  //   ?minPeak=500                                 → 找峰值电流 ≥500mA 的大负载
  //   ?chip=AD98&minCompleteness=70                → 按主芯片 + 数据完整度筛
  //   管理端加 &status=all 可见 DRAFT 待审核模块（需 lab/admin）
  const wantAll = sp.get("status") === "all" || sp.get("status") === "DRAFT";
  const list = await queryCapabilities({
    q: sp.get("q") || undefined,
    category: sp.get("category") || undefined,
    status: wantAll && ["lab", "admin"].includes(tier) ? sp.get("status")! : sp.get("status") && !wantAll ? sp.get("status")! : undefined,
    interfaceType: sp.get("interface") || undefined,
    vAtLeast: num("vAtLeast"),
    vAtMost: num("vAtMost"),
    fiveVTolerant: bool("tolerant5v"),
    minPeakMa: num("minPeak"),
    maxPeakMa: num("maxPeak"),
    usesChip: sp.get("chip") || undefined,
    minCompleteness: num("minCompleteness"),
    limit: num("limit"),
  });

  const modules = list.map((m: any) => {
    const cert = m.certification_status as ModuleCertState;
    return canDownloadAssets(tier, cert) ? m : stripPaidFields(m);
  });
  return NextResponse.json({ modules, tier });
}

// 上传模块（实验室/付费用户）：一律进入 DRAFT 待审核，不直接入正式库
export async function POST(req: NextRequest) {
  const tier = resolveTier(req);
  if (!canUploadModules(tier)) return NextResponse.json({ error: "上传模块需要付费或实验室账户" }, { status: 402 });
  await ensureSchema();
  const body = await req.json();
  const parsed = moduleInputSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });

  const mod = { ...parsed.data, certification_status: "DRAFT" as const }; // 强制草稿
  const srcType = mod.source_snapshot?.source || "lab";
  try {
    await db().execute({
      sql: `INSERT INTO modules (id, name, category, version, certification_status, source_type, price, data)
            VALUES (?, ?, ?, ?, 'DRAFT', ?, ?, ?)`,
      args: [mod.id, mod.name, mod.category, mod.version, srcType, mod.price, JSON.stringify(mod)],
    });
  } catch (e: any) {
    return NextResponse.json({ error: /UNIQUE/.test(String(e)) ? `模块 id "${mod.id}" 已存在` : String(e) }, { status: 409 });
  }
  await audit("upload", mod.id, tier);
  return NextResponse.json({ id: mod.id, certification_status: "DRAFT", message: "已提交，等待管理员审核" }, { status: 201 });
}
