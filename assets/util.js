/* ==========================================================================
   共享工具（index.html 与 go.html 共用）
   - esc / trackedUrl：转义与 UTM 埋点，保证两处外链埋点完全一致
     （对应源表「配置检查清单」第 8 条：每个入口加 UTM 参数）
   - isWeChat：微信内置浏览器识别（http 链接在微信内会被拦）
   - copyText：剪贴板写入，file:// 或非安全上下文下自动退回 execCommand
   ========================================================================== */
(function () {
  "use strict";

  var UTM_SOURCE = "cnyh_nav";

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function isWeChat() {
    return /MicroMessenger/i.test(navigator.userAgent || "");
  }

  /* 带 UTM 埋点的链接（对应配置检查清单第 8 条） */
  function trackedUrl(e) {
    if (!e || !e.url || !/^https?:/i.test(e.url)) return (e && e.url) || "";
    try {
      var u = new URL(e.url);
      u.searchParams.set("utm_source", UTM_SOURCE);
      u.searchParams.set("utm_medium", e.risk === "guide" ? "guide" : "referral");
      u.searchParams.set("utm_campaign", "red_museum_nav");
      u.searchParams.set("utm_content", e.id + "_" + (e.venue || ""));
      return u.toString();
    } catch (err) { return e.url; }
  }

  function copyText(text, onDone, onFail) {
    var ok = function () { if (onDone) onDone(); };
    var fail = function () { if (onFail) onFail(); };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(ok, fallback);
    } else {
      fallback();
    }
    function fallback() {
      try {
        var ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.cssText = "position:fixed;top:-1000px;opacity:0";
        document.body.appendChild(ta);
        ta.select();
        ta.setSelectionRange(0, text.length);
        document.execCommand("copy");
        document.body.removeChild(ta);
        ok();
      } catch (e) { fail(); }
    }
  }

  window.RMUtil = {
    UTM_SOURCE: UTM_SOURCE,
    esc: esc,
    isWeChat: isWeChat,
    trackedUrl: trackedUrl,
    copyText: copyText,
  };
})();
