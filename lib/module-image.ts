/** 模块图片处理（浏览器端）。
 *
 *  设计取舍：在浏览器里用 canvas 缩放，而不是在服务端用 sharp。
 *  原因：
 *    1. sharp 是原生依赖，本地服务器部署需要额外编译环境，安装易失败
 *    2. 浏览器端缩放后再上传，网络只传几十 KB 而不是原始的几 MB
 *    3. 缩放后的尺寸完全可控，服务端只做尺寸与格式的兜底校验
 *
 *  统一输出 WEBP（体积约为 JPEG 的 70%），不支持时回退 JPEG。
 */

/** 模块图片的目标规格 */
export const MODULE_IMAGE = {
  /** 最长边像素。模块图用于列表缩略图与详情页，480 足够清晰 */
  MAX_EDGE: 480,
  /** 压缩质量 */
  QUALITY: 0.82,
  /** 服务端接受的最大 base64 字节数（约 300KB，正常缩放后远小于此） */
  MAX_BYTES: 300 * 1024,
  /** 允许的输入类型 */
  ACCEPT: "image/png,image/jpeg,image/webp,image/gif",
} as const;

export interface ResizeResult {
  /** data URL，可直接存库与 <img src> */
  dataUrl: string;
  width: number;
  height: number;
  /** 编码后字节数（估算） */
  bytes: number;
  mime: string;
}

/** 把用户选择的图片文件缩放为统一规格的 data URL。
 *  等比缩放，不裁剪、不拉伸 —— 模块外形比例本身是有意义的信息。 */
export async function resizeModuleImage(
  file: File,
  maxEdge: number = MODULE_IMAGE.MAX_EDGE,
): Promise<ResizeResult> {
  if (!file.type.startsWith("image/")) {
    throw new Error("请选择图片文件");
  }

  const bitmap = await loadBitmap(file);
  try {
    const { width, height } = fitWithin(bitmap.width, bitmap.height, maxEdge);

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("浏览器不支持 canvas，无法处理图片");

    // 透明底图（如 PNG 去背）转成 JPEG 会变黑，这里统一垫白底
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, width, height);

    // 优先 WEBP，浏览器不支持时回退 JPEG
    let mime = "image/webp";
    let dataUrl = canvas.toDataURL(mime, MODULE_IMAGE.QUALITY);
    if (!dataUrl.startsWith("data:image/webp")) {
      mime = "image/jpeg";
      dataUrl = canvas.toDataURL(mime, MODULE_IMAGE.QUALITY);
    }

    return { dataUrl, width, height, bytes: dataUrlBytes(dataUrl), mime };
  } finally {
    bitmap.close?.();
  }
}

/** 等比缩放到最长边不超过 maxEdge；小图不放大 */
export function fitWithin(w: number, h: number, maxEdge: number) {
  if (w <= maxEdge && h <= maxEdge) return { width: w, height: h };
  const scale = maxEdge / Math.max(w, h);
  return { width: Math.round(w * scale), height: Math.round(h * scale) };
}

/** 估算 data URL 的实际字节数（base64 每 4 字符表示 3 字节） */
export function dataUrlBytes(dataUrl: string): number {
  const i = dataUrl.indexOf(",");
  if (i < 0) return 0;
  const b64 = dataUrl.slice(i + 1);
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}

async function loadBitmap(file: File): Promise<ImageBitmap & { close?: () => void }> {
  // createImageBitmap 在主流浏览器都可用，且比 <img> 解码更快
  if (typeof createImageBitmap === "function") {
    return (await createImageBitmap(file)) as any;
  }
  // 回退：老浏览器用 <img>
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("图片解码失败，请换一张试试"));
      el.src = url;
    });
    return { width: img.naturalWidth, height: img.naturalHeight, ...(img as any) } as any;
  } finally {
    URL.revokeObjectURL(url);
  }
}
