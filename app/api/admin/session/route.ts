import { NextRequest, NextResponse } from "next/server";
import { ADMIN_COOKIE, ADMIN_TTL_MS, makeAdminToken, safeEqual } from "@/lib/admin-session";

export const runtime = "nodejs";

/** POST { key } → 校验 ADMIN_API_KEY，签发 8 小时 httpOnly 会话 cookie */
export async function POST(req: NextRequest) {
  const secret = process.env.ADMIN_API_KEY;
  if (!secret) return NextResponse.json({ error: "服务端未配置 ADMIN_API_KEY" }, { status: 500 });
  const { key } = await req.json().catch(() => ({}));
  if (!safeEqual(String(key || ""), secret)) return NextResponse.json({ error: "密钥错误" }, { status: 401 });
  const res = NextResponse.json({ ok: true, expires_in: ADMIN_TTL_MS / 1000 });
  res.cookies.set(ADMIN_COOKIE, makeAdminToken(secret), {
    httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production",
    maxAge: ADMIN_TTL_MS / 1000, path: "/",
  });
  return res;
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(ADMIN_COOKIE, "", { httpOnly: true, maxAge: 0, path: "/" });
  return res;
}
