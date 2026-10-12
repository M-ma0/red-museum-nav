/* ==========================================================================
   http 入口跳转页（go.html）
   依据源表「配置检查清单」第 4 条：
     http 链接需经自有 https 域跳转，或在聚合页加"复制链接到浏览器打开"兜底按钮。
   本站是 https 页面，微信能正常打开；会被拦的是再往下的 http 目标页。
   所以这一页负责三件事：说清原因、给出可执行的打开方式、不让点击静默失败。

   用法：
     go.html?e=e31            按入口 ID（数据来自 data/entries.js）
     go.html?u=<url>&t=<标题>  收口任意外链（公众号图文等处可直接用）
   ========================================================================== */
(function () {
  "use strict";

  var U = window.RMUtil;
  var esc = U.esc;
  var DATA = window.__NAV_DATA__ || {};
  var ENTRIES = DATA.entries || [];
  var byId = {};
  ENTRIES.forEach(function (e) { byId[e.id] = e; });

  function qs(name) {
    var m = new RegExp("[?&]" + name + "=([^&#]*)").exec(location.search);
    if (!m) return "";
    try { return decodeURIComponent(m[1].replace(/\+/g, " ")); } catch (e) { return m[1]; }
  }

  var toastEl = document.getElementById("toast");
  function toast(msg) {
    if (!toastEl) return;
    toastEl.innerHTML = '<svg viewBox="0 0 24 24"><path d="M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg><span>' +
      esc(msg) + "</span>";
    toastEl.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { toastEl.classList.remove("show"); }, 3200);
  }

  function copy(text, doneMsg) {
    U.copyText(text, function () { toast(doneMsg); },
      function () { toast("复制失败，请长按上方链接选中后手动复制"); });
  }

  /* ------------------------------------------------------------ 解析目标 */
  var entry = byId[qs("e")] || null;
  var target = entry ? U.trackedUrl(entry) : qs("u");
  var isHttp = /^http:\/\//i.test(target) || (entry && entry.risk === "http");
  var inWeChat = U.isWeChat();

  var $ = function (s) { return document.querySelector(s); };
  var panel = $("#goPanel"), miss = $("#goMissing");

  /* 顶部吸顶偏移与 index.html 口径一致（--topbar-h 供锚点滚动使用） */
  function syncChrome() {
    var tb = $(".topbar");
    if (tb) document.documentElement.style.setProperty("--topbar-h", tb.offsetHeight + "px");
  }

  /* ------------------------------------------------------------ 渲染 */
  function render() {
    if (!target) {
      if (panel) panel.hidden = true;
      if (miss) miss.hidden = false;
      return;
    }
    document.title = (entry ? entry.venue + " · " + entry.name : "正在前往") + " · 红色博物馆云上观展导航";
    if (entry) {
      $("#goVenue").textContent = entry.venue + (entry.region ? " · " + entry.region : "");
      $("#goName").textContent = entry.name;
      $("#goType").textContent = entry.etype;
      $("#goType").hidden = false;
    } else {
      $("#goVenue").textContent = "外部链接";
      $("#goName").textContent = qs("t") || "即将离开本站";
    }
    /* 框里显示入口本身的地址（短、可读、可长按手抄）；
       真正复制/打开时再附加 UTM 埋点，便于馆方后台统计来源（配置检查清单第 8 条）。 */
    var shown = entry ? entry.url : target;
    $("#goUrl").textContent = shown;
    $("#goUrl2").textContent = shown;
    $("#goCopy").setAttribute("data-copy", target);

    if (!isHttp) {
      /* 非 http 目标（例如把本页当通用跳转页用）：直接放行即可 */
      $("#goEyebrow").textContent = "正在前往";
      $("#goHttpBlock").hidden = true;
      $("#goDirectBlock").hidden = false;
      $("#goAlert").hidden = true;
    } else {
      $("#goEyebrow").textContent = "该入口使用 http 链接";
      $("#goHttpBlock").hidden = false;
      $("#goDirectBlock").hidden = true;
      $("#goAlert").hidden = false;
      $("#goAlert").innerHTML = inWeChat
        ? "<b>微信内置浏览器会拦截 http 网页</b>，直接点开只会白屏或提示风险，" +
          "所以这一页不会自动跳转。请按下面三步，用手机浏览器打开。"
        : "<b>正在自动前往该入口…</b>若没有反应，请点「直接打开」，或复制链接到浏览器粘贴打开。";
    }
  }

  /* ------------------------------------------------------------ 交互 */
  function bind() {
    $("#goCopy").addEventListener("click", function () {
      copy(this.getAttribute("data-copy") || target,
        isHttp ? "链接已复制，请打开手机浏览器粘贴打开" : "链接已复制");
    });
    $("#goOpen").addEventListener("click", tryOpen);
    $("#goOpen2").addEventListener("click", tryOpen);
    $("#goQr").addEventListener("click", showQr);
    $("#goBackTop").addEventListener("click", function () { location.href = "index.html"; });
  }

  /* 真正去打开目标页 */
  function tryOpen() {
    if (!target) return;
    try { window.location.href = target; } catch (e) {}
    if (!inWeChat) return;
    /* 微信内如果被拦下，页面会原地不动 —— 别让用户以为"点了没反应" */
    setTimeout(function () {
      if (document.visibilityState === "visible") {
        toast("这多半是被微信拦下了，请用「复制链接」到手机浏览器打开");
        $("#goCopy").focus();
      }
    }, 1600);
  }

  function showQr() {
    var box = $("#goQrBox");
    box.hidden = !box.hidden;
    if (box.hidden || box.dataset.done) return;
    var dataUrl = "";
    try {
      var qr = window.RMQr ? window.RMQr.encode(target) : null;
      if (qr) dataUrl = window.RMQr.toCanvas(qr, 7).toDataURL("image/jpeg", 0.92);
    } catch (e) { dataUrl = ""; }
    if (dataUrl) {
      box.querySelector(".qrbox").innerHTML =
        '<img src="' + dataUrl + '" alt="目标入口二维码" width="190" height="190">' +
        '<div class="qrtip">用手机<b>相机</b>扫码（微信「扫一扫」扫出来同样会被拦），' +
        "或直接在其它设备的浏览器里打开上面的链接</div>";
    } else {
      box.querySelector(".qrbox").innerHTML =
        '<div class="qrtip">该链接超出本地二维码容量，请在其它设备浏览器中打开上面的链接</div>';
    }
    box.dataset.done = "1";
  }

  /* ------------------------------------------------------------ 启动 */
  render();
  bind();
  syncChrome();
  window.addEventListener("resize", syncChrome, { passive: true });
  if (window.ResizeObserver) new ResizeObserver(syncChrome).observe($(".topbar"));

  /* 非微信环境（桌面浏览器、系统自带浏览器）能直接打开 http，自动放行，少一次点击 */
  if (target && !inWeChat) {
    setTimeout(function () { window.location.replace(target); }, 700);
  }
})();
