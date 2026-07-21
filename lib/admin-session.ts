import { createHmac, timingSafeEqual } from "node:crypto";

/** 管理后台短期会话令牌：HMAC(ADMIN_API_KEY) 签名，8 小时过期，
 *  经 httpOnly cookie 下发 —— 浏览器不再持有长期共享密钥。 */
export const ADMIN_COOKIE = "nuedc_admin";
export const ADMIN_TTL_MS = 8 * 3600 * 1000;

function sign(payload: string, secret: string) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}
export function makeAdminToken(secret: string): string {
  const payload = Buffer.from(JSON.stringify({ r: "admin", exp: Date.now() + ADMIN_TTL_MS })).toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}
export function verifyAdminToken(token: string | undefined, secret: string | undefined): boolean {
  if (!token || !secret) return false;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return false;
  const expect = sign(payload, secret);
  try {
    const a = Buffer.from(sig), b = Buffer.from(expect);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    return data.r === "admin" && data.exp > Date.now();
  } catch { return false; }
}
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
