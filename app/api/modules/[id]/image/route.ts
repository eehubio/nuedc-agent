import { NextRequest, NextResponse } from "next/server";
import { db, ensureSchema } from "@/lib/db";
import { resolveTier } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 服务端兜底限制。浏览器端已缩放，但客户端可绕过，服务端必须独立校验。 */
const MAX_BYTES = 300 * 1024;
const ALLOWED_MIME = ["image/webp", "image/jpeg", "image/png"];

function parseDataUrl(dataUrl: string): { mime: string; buf: Buffer } | null {
  const m = /^data:([a-z]+\/[a-z0-9.+-]+);base64,(.+)$/i.exec(dataUrl.trim());
  if (!m) return null;
  try {
    return { mime: m[1].toLowerCase(), buf: Buffer.from(m[2], "base64") };
  } catch {
    return null;
  }
}

/** GET /api/modules/[id]/image —— 返回图片本体（带缓存头）。
 *  单独成端点而不是塞进模块 JSON：列表接口不必携带几十 KB 的 base64，
 *  且浏览器可按 ETag 缓存，翻页时不会重复下载。 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  await ensureSchema();
  const rs = await db().execute({
    sql: "SELECT image, image_updated_at FROM modules WHERE id=?",
    args: [params.id],
  });
  const row: any = rs.rows[0];
  if (!row?.image) return new NextResponse(null, { status: 404 });

  const parsed = parseDataUrl(String(row.image));
  if (!parsed) return new NextResponse(null, { status: 404 });

  // 以更新时间做 ETag：图片变了才重新下载
  const etag = `"${params.id}-${new Date(String(row.image_updated_at || 0)).getTime()}"`;
  if (req.headers.get("if-none-match") === etag) {
    return new NextResponse(null, { status: 304 });
  }

  return new NextResponse(new Uint8Array(parsed.buf), {
    status: 200,
    headers: {
      "Content-Type": parsed.mime,
      "Content-Length": String(parsed.buf.length),
      "Cache-Control": "public, max-age=300, must-revalidate",
      ETag: etag,
    },
  });
}

/** PUT /api/modules/[id]/image —— 上传/替换图片（工作人员）。
 *  Body: { image: "data:image/webp;base64,..." } */
export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const tier = resolveTier(req);
  if (!["admin", "lab"].includes(tier)) {
    return NextResponse.json({ error: "仅工作人员可维护模块图片" }, { status: 403 });
  }
  await ensureSchema();

  const body = await req.json().catch(() => ({}));
  const dataUrl = String(body?.image || "");
  if (!dataUrl) return NextResponse.json({ error: "缺少 image 字段" }, { status: 400 });

  const parsed = parseDataUrl(dataUrl);
  if (!parsed) {
    return NextResponse.json({ error: "image 必须是 data:<mime>;base64,<data> 格式" }, { status: 400 });
  }
  if (!ALLOWED_MIME.includes(parsed.mime)) {
    return NextResponse.json(
      { error: `不支持的图片格式：${parsed.mime}（允许 ${ALLOWED_MIME.join(" / ")}）` },
      { status: 400 },
    );
  }
  if (parsed.buf.length > MAX_BYTES) {
    return NextResponse.json(
      { error: `图片过大：${Math.round(parsed.buf.length / 1024)}KB，上限 ${MAX_BYTES / 1024}KB。请压缩后重试。` },
      { status: 413 },
    );
  }

  const exist = await db().execute({ sql: "SELECT id FROM modules WHERE id=?", args: [params.id] });
  if (!exist.rows.length) return NextResponse.json({ error: "模块不存在" }, { status: 404 });

  await db().execute({
    sql: "UPDATE modules SET image=?, image_updated_at=now(), updated_at=now() WHERE id=?",
    args: [dataUrl, params.id],
  });

  return NextResponse.json({ ok: true, bytes: parsed.buf.length, mime: parsed.mime });
}

/** DELETE /api/modules/[id]/image —— 移除图片，回退为分类图标占位 */
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const tier = resolveTier(req);
  if (!["admin", "lab"].includes(tier)) {
    return NextResponse.json({ error: "仅工作人员可维护模块图片" }, { status: 403 });
  }
  await ensureSchema();
  await db().execute({
    sql: "UPDATE modules SET image=NULL, image_updated_at=NULL, updated_at=now() WHERE id=?",
    args: [params.id],
  });
  return NextResponse.json({ ok: true });
}
