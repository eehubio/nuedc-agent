/** @type {import('next').NextConfig} */
const nextConfig = {
  async headers() {
    return [
      {
        // 允许被 ezPLM 以 iframe 嵌入；生产环境请把 ALLOWED_EMBED_ORIGIN 收紧
        source: "/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value: `frame-ancestors 'self' ${process.env.ALLOWED_EMBED_ORIGIN || "https://www.ezplm.cn https://*.ezplm.cn"};`,
          },
        ],
      },
      {
        source: "/api/:path*",
        headers: [
          { key: "Access-Control-Allow-Origin", value: process.env.ALLOWED_API_ORIGIN || "*" },
          { key: "Access-Control-Allow-Methods", value: "GET,POST,PATCH,DELETE,OPTIONS" },
          { key: "Access-Control-Allow-Headers", value: "Content-Type, Authorization, X-Api-Key" },
        ],
      },
    ];
  },
};
module.exports = nextConfig;
