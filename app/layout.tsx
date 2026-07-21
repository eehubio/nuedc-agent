import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "NUEDC Agent · 电赛智能体",
  description: "赛题理解 / 模块数据库 / 方案生成 / 代码生成 / LabSight 调试 / 报告生成",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
