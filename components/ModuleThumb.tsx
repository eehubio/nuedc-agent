"use client";
import { useState } from "react";

/** 模块缩略图：有图片就显示图片，否则回退分类图标。
 *
 *  图片走 /api/modules/:id/image 单独请求，不随列表 JSON 一起下发 ——
 *  否则一页 20 个模块就要多传近 1MB 的 base64。
 *  加载失败（图片被删、后端 404）时静默回退图标，不显示破图。 */
export function ModuleThumb({
  id, hasImage, icon, size, className, style,
}: {
  id: string;
  hasImage?: boolean;
  /** 无图时显示的分类 emoji */
  icon: string;
  /** 方形边长，不传则铺满容器 */
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  const [failed, setFailed] = useState(false);
  const showImage = hasImage && !failed;

  const box: React.CSSProperties = {
    ...(size ? { width: size, height: size } : null),
    ...style,
  };

  if (!showImage) {
    return <div className={className ?? "thumb"} style={box}>{icon}</div>;
  }

  return (
    <div className={className ?? "thumb"} style={{ ...box, padding: 0, overflow: "hidden" }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`/api/modules/${encodeURIComponent(id)}/image`}
        alt=""
        loading="lazy"
        onError={() => setFailed(true)}
        style={{ width: "100%", height: "100%", objectFit: "contain", display: "block" }}
      />
    </div>
  );
}
