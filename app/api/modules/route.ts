import { NextRequest, NextResponse } from "next/server";
import { db, ensureSchema } from "@/lib/db";
import { moduleInputSchema, zodMessage } from "@/lib/module-schema";
import { resolveTier, canUploadModules, canDownloadAssets, stripPaidFields } from "@/lib/auth";
import type { ModuleCertState } from "@/lib/types";

export const runtime = "nodejs";
export async function OPTIONS() { return new NextResponse(null, { status: 204 }); }

export async function GET(req: NextRequest) {
  await ensureSchema();
  const tier = resolveTier(req);
  const url = new URL(req.url);
  const q = url.searchParams.get("q") || "";
  const category = url.searchParams.get("category") || "";
  const rs = await db().execute({
    sql: `SELECT id, data, certification_status, downloads, rating FROM modules
          WHERE certification_status != 'DEPRECATED'
            AND (? = '' OR category LIKE ? ) AND (? = '' OR name LIKE ? OR id LIKE ?)
          ORDER BY updated_at DESC LIMIT 100`,
    args: [category, `${category}%`, q, `%${q}%`, `%${q}%`],
  });
  const modules = rs.rows.map((r) => {
    const data = JSON.parse(String(r.data));
    const cert = String(r.certification_status) as ModuleCertState;
    return canDownloadAssets(tier, cert)
      ? { ...data, downloads: r.downloads, rating: r.rating }
      : { ...stripPaidFields(data), downloads: r.downloads, rating: r.rating };
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
  return NextResponse.json({ id: mod.id, certification_status: "DRAFT", message: "已提交，等待管理员审核" }, { status: 201 });
}
