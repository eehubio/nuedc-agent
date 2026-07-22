import { NextRequest, NextResponse } from "next/server";
import { getRequestIdentity, withIdentityCookie } from "@/lib/identity";
import { reserveQuota, commitQuota, refundQuota } from "@/lib/usage";

/** PDF 魔数校验：base64 前几字节解码后必须以 %PDF- 开头 */
function isPdfBase64(b64: string): boolean {
  try {
    const head = Buffer.from(b64.slice(0, 16), "base64").toString("latin1");
    return head.startsWith("%PDF-");
  } catch { return false; }
}

export const runtime = "nodejs";
export const maxDuration = 60;

/** 赛题 PDF → 文本。电赛题目下发就是 PDF，直接上传比手动复制可靠。
 *  用 LLM 的多模态能力读取（对扫描件同样有效），失败时提示手动粘贴。 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body?.data_base64) return NextResponse.json({ error: "缺少 data_base64" }, { status: 400 });

  // 大小限制
  const sizeMB = (body.data_base64.length * 0.75) / 1024 / 1024;
  if (sizeMB > 8) return NextResponse.json({ error: `PDF 过大（${sizeMB.toFixed(1)}MB > 8MB），请压缩或直接粘贴文本` }, { status: 400 });

  // 魔数校验（诊断 P0-2）：必须是真正的 PDF，防止任意大文件被送进多模态接口
  if (!isPdfBase64(body.data_base64)) {
    return NextResponse.json({ error: "文件不是有效的 PDF（缺少 %PDF- 文件头）" }, { status: 400 });
  }

  // 鉴权 + 原子预占配额（免费 2 / 付费 20 / 实验室与管理员不限）
  const id = await getRequestIdentity(req);
  const { reservation, error: quotaErr } = await reserveQuota(id.owner, "pdf_extract", id.tier);
  if (!reservation) return withIdentityCookie(NextResponse.json({ error: quotaErr }, { status: 429 }), id);

  const extractPrompt = `这是全国大学生电子设计竞赛的赛题 PDF。请完整提取文字内容，要求：
1. 保持原有条目结构（任务、基本要求、发挥部分、说明、评分标准表）
2. 每页正文前加一行页码标记，格式：【第N页】
3. 评分标准表逐行转成"项目｜分值"的文字形式，不要遗漏分值
4. 表格用文字描述行列含义
5. 只输出提取的正文，不要添加任何解释或总结`;

  try {
    // 统一走模型网关：自动选多模态 Provider、容灾切换、缓存（同一 PDF 只解析一次）、计费追踪
    const { modelGateway } = await import("@/lib/model-gateway");
    const { createHash } = await import("node:crypto");
    const pdfHash = createHash("sha256").update(body.data_base64.slice(0, 200_000)).digest("hex").slice(0, 32);

    const r = await modelGateway.run<string>({
      taskType: "PDF_EXTRACT",
      system: extractPrompt,
      messages: [{ role: "user", content: "请提取该 PDF 的完整正文" }],
      pdfBase64: body.data_base64,
      json: false,
      owner: id.owner,
      allowCache: true,
      problemVersion: pdfHash,     // 同一份 PDF 命中全局缓存，不重复解析
    });

    if (!r.ok) {
      await refundQuota(id.owner, "pdf_extract", reservation.ref);
      return NextResponse.json({
        error: r.message || "PDF 解析失败。本次不计入配额。",
        degraded: r.degraded || null,
      }, { status: r.errorCode === "SYSTEM_MODE" || r.errorCode === "NO_PROVIDER" ? 503 : 500 });
    }

    const text = String(r.rawText || "").trim();
    if (!text) {
      await refundQuota(id.owner, "pdf_extract", reservation.ref);
      return NextResponse.json({ error: "未从 PDF 提取到文字（可能是纯图片扫描件且 OCR 失败）。本次不计入配额。" }, { status: 500 });
    }

    await commitQuota(reservation.ref);
    return withIdentityCookie(NextResponse.json({
      text, chars: text.length,
      provider: r.provider, cached: r.cacheHit,
      quota: reservation.quota === -1 ? null : { used: reservation.used, limit: reservation.quota },
    }), id);
  } catch (e: any) {
    await refundQuota(id.owner, "pdf_extract", reservation.ref);
    return NextResponse.json({ error: `PDF 解析失败：${e?.message || e}。本次不计入配额，可重试或改用「粘贴文本」。` }, { status: 500 });
  }
}
