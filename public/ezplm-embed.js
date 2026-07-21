/**
 * NUEDC Agent — ezPLM 嵌入脚本
 * 用法（在 ezPLM 页面中）：
 *   <div id="nuedc-agent"></div>
 *   <script src="https://your-vercel-app.vercel.app/ezplm-embed.js"><\/script>
 *   <script>
 *     NuedcAgent.mount("#nuedc-agent", {
 *       baseUrl: "https://your-vercel-app.vercel.app",
 *       ezplmProjectId: "EZ-2026-001",   // 关联 ezPLM 项目
 *       userTier: "paid",                 // ezPLM 已知的用户等级
 *       onEvent: (evt) => console.log("agent event", evt), // 回传给 ezPLM
 *     });
 *   <\/script>
 */
(function () {
  window.NuedcAgent = {
    mount: function (selector, opts) {
      opts = opts || {};
      var host = typeof selector === "string" ? document.querySelector(selector) : selector;
      if (!host) throw new Error("NuedcAgent.mount: 容器不存在 " + selector);
      var base = (opts.baseUrl || "").replace(/\/$/, "");
      var params = new URLSearchParams({
        embed: "1",
        ezplm_project_id: opts.ezplmProjectId || "",
        tier: opts.userTier || "free",
      });
      var iframe = document.createElement("iframe");
      iframe.src = base + "/embed?" + params.toString();
      iframe.style.cssText = "width:100%;height:100%;min-height:640px;border:0;";
      iframe.allow = "clipboard-write";
      host.appendChild(iframe);

      // 智能体 → ezPLM 事件（BOM 生成完成 / 报告完成 / 阶段变化等）
      window.addEventListener("message", function (e) {
        if (base && e.origin !== base) return;
        if (e.data && e.data.__nuedc_agent && typeof opts.onEvent === "function") {
          opts.onEvent(e.data);
        }
      });

      return {
        // ezPLM → 智能体：推送赛题、切换项目等
        post: function (type, payload) {
          iframe.contentWindow.postMessage({ __ezplm: true, type: type, payload: payload }, base || "*");
        },
        iframe: iframe,
      };
    },
  };
})();
