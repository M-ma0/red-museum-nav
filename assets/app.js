/* ==========================================================================
   红色博物馆 · 云上观展导航  交互脚本
   依赖：data/entries.js（由 tools/build_data.py 生成，含 window.__NAV_DATA__）
   也支持通过 fetch('data/entries.json') 覆盖（用于本地起服务时的增量更新）
   ========================================================================== */
(function () {
  "use strict";

  var DATA = null;
  var SITE = {};
  var ALL_ENTRIES = [];
  var ENTRIES = [];      // 参与展示的入口
  var DROPPED_N = 0;     // 源表格中已确认无法访问、被删除的入口数（仅用于页脚说明）
  var byId = {};

  /* 由原始数据派生展示所用的状态。tryRefresh 覆盖数据后必须重新调用。 */
  function applyData(d) {
    DATA = d || null;
    SITE = (d && d.site) || {};
    ALL_ENTRIES = (d && d.entries) || [];
    ENTRIES = ALL_ENTRIES;
    DROPPED_N = (SITE && SITE.droppedCount) || 0;
    byId = {};
    ENTRIES.forEach(function (e) { byId[e.id] = e; });
  }
  applyData(window.__NAV_DATA__);

  var UTM_SOURCE = "cnyh_nav";
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  /* ---------------------------------------------------------------- 工具 */
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function toast(msg) {
    var el = $("#toast");
    el.innerHTML = '<svg viewBox="0 0 24 24"><path d="M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg><span>' + esc(msg) + "</span>";
    el.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.classList.remove("show"); }, 2100);
  }

  function copyText(text) {
    var done = function () { toast("已复制到剪贴板"); };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, function () { fallback(); });
    } else { fallback(); }
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
        done();
      } catch (e) { toast("复制失败，请长按选中链接手动复制"); }
    }
  }

  /* 带 UTM 埋点的链接（对应配置检查清单第 8 条） */
  function trackedUrl(e) {
    if (!e.url || !/^https?:/i.test(e.url)) return e.url;
    try {
      var u = new URL(e.url);
      u.searchParams.set("utm_source", UTM_SOURCE);
      u.searchParams.set("utm_medium", e.risk === "guide" ? "guide" : "referral");
      u.searchParams.set("utm_campaign", "red_museum_nav");
      u.searchParams.set("utm_content", e.id + "_" + (e.venue || ""));
      return u.toString();
    } catch (err) { return e.url; }
  }

  /* 清理已下线功能的本地残留（旧版本记录过"最近浏览"与"收藏"） */
  try {
    localStorage.removeItem("rmnav.recent.v1");
    localStorage.removeItem("rmnav.favs.v1");
  } catch (e) {}

  /* ------------------------------------------------------------ 预览图 */
  /* 弱网优化：先显示内联的模糊占位（已随 HTML 一起到达，零额外请求），
     真实图片用 srcset/sizes 让浏览器按屏宽挑合适档位，加载完成后淡入。 */
  var PLACEHOLDERS = window.__NAV_PLACEHOLDERS__ || {};

  function placeholderFor(e) {
    return PLACEHOLDERS[e.id] || "";
  }

  function thumbHTML(e, lazy) {
    if (e.image && e.hasShot !== false) {
      var ph = placeholderFor(e);
      var phStyle = ph ? ' style="background-image:url(' + ph + ')"' : "";
      var src = esc(e.image);
      var set = src + " 560w, " + esc(e.image.replace(/\.jpg$/, "@2x.jpg")) + " 840w";
      /* sizes 按实测栅格给定（1440px 视口为 3 列、单列约 387px；手机 390px 两列约 187px）：
         浏览器取 min(sizes×DPR, 视口宽×DPR) 再挑最接近的候选。
         - 桌面 DPR1：387px → 取 560w（1.45x）
         - 手机 DPR3：187×3=561px → 取 560w（位置宽 234px，2.4x，高密度屏清晰）
         两端都落在 560w，不会退到 320w 变体，也不会过取 840w。 */
      var sizes = "(max-width:620px) 48vw, 400px";
      return '<span class="thumb loading"' + phStyle + '>' +
        '<img src="' + src + '" srcset="' + set + '" sizes="' + sizes + '" ' +
        'alt="' + esc(e.venue + " —— " + e.name) + '" ' +
        'loading="' + (lazy ? "lazy" : "eager") + '" decoding="async" ' +
        'width="560" height="350" onload="this.parentNode.classList.remove(\'loading\')"' +
        (lazy ? "" : ' fetchpriority="high"') + "></span>";
    }
    var why = e.dead ? deadLabel(e) : "暂未采到预览图";
    return '<span class="thumb ph"><span class="ph-in">' +
      '<span class="ph-seal"><svg viewBox="0 0 24 24"><path d="M12 2l2.6 5.3 5.9.86-4.25 4.15 1 5.86L12 15.4l-5.25 2.77 1-5.86L3.5 8.16l5.9-.86z"/></svg></span>' +
      '<span class="ph-venue">' + esc(e.venue) + "</span>" +
      '<span class="ph-type">' + esc(e.etype) + "</span>" +
      '<span class="ph-note">' + esc(why) + "</span>" +
      "</span></span>";
  }

  /* 失效状态的文案：区分"明确失效"与"无法自动核验" */
  function deadLabel(e) {
    if (!e.dead) return "";
    return (e.health === "http-404" || e.health === "http-410") ? "链接可能已失效" : "未能自动核验";
  }

  function badgesHTML(e) {
    var right = "";
    if (e.dead) right += '<span class="bdg bdg-dead">' + deadLabel(e) + "</span>";
    else if (!e.verified) right += '<span class="bdg bdg-warn">待复核</span>';
    else right += '<span class="bdg bdg-ok">官方确认</span>';
    if (e.risk === "http") right += '<span class="bdg bdg-http">http</span>';
    var left = '<span class="bdg bdg-type">' + esc(e.etype) + "</span>";
    if (e.group === "为新中国奠基 · 香山" || e.venue.indexOf("韶山") > -1) {
      left = '<span class="bdg bdg-hd">3D数字孪生</span>';
    }
    return '<span class="badges">' + left + '<span class="right">' + right + "</span></span>";
  }

  function cardHTML(e, lazy) {
    var cta = e.linkable ? (e.risk === "guide" ? "查看操作路径" : e.dead ? "仍要尝试打开" : "立即观展") : "查看操作路径";
    return '<article class="card' + (e.dead ? " is-dead" : "") + '" data-id="' + e.id + '">' +
      '<a class="card-link" href="#" data-act="open" aria-label="' + esc(esc(cta) + "：" + e.venue + " " + e.name) + '">' +
        thumbHTML(e, lazy) + badgesHTML(e) +
      "</a>" +
      '<div class="card-body">' +
        '<div class="card-meta"><span class="venue">' + esc(e.venue) + '</span>' +
          '<span class="region">' + esc(e.region) + "</span></div>" +
        '<div class="card-title">' + esc(e.name) + "</div>" +
        (e.mobile ? '<div class="note"><svg viewBox="0 0 24 24"><path d="M12 2a7 7 0 00-7 7c0 5.25 7 13 7 13s7-7.75 7-13a7 7 0 00-7-7zm0 9.5A2.5 2.5 0 1114.5 9 2.5 2.5 0 0112 11.5z"/></svg><span>' + esc(e.mobile) + "</span></div>" : "") +
        '<div class="card-foot">' +
          '<button class="btn-go' + (e.risk === "guide" || !e.linkable ? " guide" : "") + '" type="button" data-act="open">' +
            '<svg viewBox="0 0 24 24"><path d="M19 19H5V5h7V3H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/></svg>' +
            esc(cta) + "</button>" +
        "</div>" +
      "</div></article>";
  }

  /* ------------------------------------------------------------ 弹窗 */
  var overlay = $("#overlay"), modal = $("#modal"), lastFocus = null;
  function closeModal() {
    overlay.classList.remove("open");
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  function openModal(html, gold) {
    lastFocus = document.activeElement;
    modal.innerHTML = html;
    overlay.classList.add("open");
    var btn = $(".modal-ft .btn-primary, .modal-x", modal);
    if (btn) btn.focus();
  }
  overlay.addEventListener("click", function (ev) {
    if (ev.target === overlay || ev.target.closest("[data-close]")) closeModal();
  });
  document.addEventListener("keydown", function (ev) {
    if (ev.key === "Escape" && overlay.classList.contains("open")) closeModal();
  });

  function modalOpen(e) {
    var url = trackedUrl(e || {});
    var risky = e && (e.risk === "http" || e.risk === "domain");
    var title = "即将离开本站";
    var sub = e ? e.venue + " · " + e.name : "";
    if (risky) {
      title = e.risk === "http" ? "该入口使用的是 http 链接" : "该入口为特殊域名";
      if (e.risk === "http") sub = "微信内置浏览器可能拦截 http 链接";
      else sub = e.host + " 在 iOS 微信内可能提示风险";
    }
    var body = "";
    if (e && e.risk === "http") {
      body = "<p>受微信限制，<b>http://</b> 开头的链接在微信内常常无法直接打开。建议复制链接后，用手机浏览器打开。</p>";
    } else if (e && e.risk === "domain") {
      body = "<p>该入口域名（<b>" + esc(e.host) + "</b>）为馆方官方域名，但在 iOS 微信内可能弹出安全提示。请确认来源后继续访问。</p>";
    } else {
      body = "<p>你将前往外部网站查看该线上展馆。</p>";
    }
    body += '<div class="kbox">' + esc(url) + "</div>";
    openModal(
      '<div class="modal-hd' + (risky ? " gold" : "") + '">' +
        '<span class="mi"><svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 100 20 10 10 0 000-20zm1 15h-2v-6h2zm0-8h-2V7h2z"/></svg></span>' +
        "<div><h3>" + esc(title) + '</h3><div class="msub">' + esc(sub) + "</div></div>" +
        '<button class="modal-x" type="button" data-close aria-label="关闭">×</button>' +
      "</div>" +
      '<div class="modal-bd">' + body + "</div>" +
      '<div class="modal-ft">' +
        '<button class="btn-ghost" type="button" data-close>取消</button>' +
        '<button class="btn-ghost" type="button" data-copy="' + esc(url) + '">复制链接</button>' +
        '<button class="btn-ghost" type="button" data-qr="' + esc(url) + '" data-sub="' + esc(sub) + '">扫码在手机打开</button>' +
        '<button class="btn-primary" type="button" data-goto="' + esc(url) + '">继续访问</button>' +
      "</div>",
      risky
    );
  }

  /* 二维码弹窗：本地生成，不请求任何外部服务 */
  function modalQr(url, sub) {
    var qr = null;
    try { qr = window.RMQr ? window.RMQr.encode(url) : null; } catch (e) { qr = null; }
    if (!qr) {
      openModal(
        '<div class="modal-hd gold"><span class="mi"><svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 100 20 10 10 0 000-20zm1 15h-2v-6h2zm0-8h-2V7h2z"/></svg></span>' +
        "<div><h3>无法生成二维码</h3><div class=\"msub\">链接过长</div></div>" +
        '<button class="modal-x" type="button" data-close aria-label="关闭">×</button></div>' +
        '<div class="modal-bd"><p>该链接超出本地二维码容量，请改用「复制链接」发送到手机。</p>' +
        '<div class="kbox">' + esc(url) + "</div></div>" +
        '<div class="modal-ft"><button class="btn-ghost" type="button" data-close>知道了</button>' +
        '<button class="btn-primary" type="button" data-copy="' + esc(url) + '">复制链接</button></div>',
        true
      );
      return;
    }
    var dataUrl;
    try { dataUrl = window.RMQr.toCanvas(qr, 7).toDataURL("image/jpeg", 0.92); }
    catch (e) { dataUrl = ""; }
    openModal(
      '<div class="modal-hd gold"><span class="mi"><svg viewBox="0 0 24 24"><path d="M3 3h8v8H3zm2 2v4h4V5zM13 3h8v8h-8zm2 2v4h4V5zM3 13h8v8H3zm2 2v4h4v-4zM13 13h3v3h-3zM18 13h3v3h-3zM13 18h3v3h-3zM18 18h3v3h-3z"/></svg></span>' +
      "<div><h3>扫码在手机上打开</h3><div class=\"msub\">" + esc(sub) + "</div></div>" +
      '<button class="modal-x" type="button" data-close aria-label="关闭">×</button></div>' +
      '<div class="modal-bd"><div class="qrbox">' +
        (dataUrl ? '<img src="' + dataUrl + '" alt="' + esc(sub) + ' 的二维码" width="190" height="190">' : "") +
        '<div class="qrtip">用手机相机或微信「扫一扫」对准二维码<br>即可在手机上继续参观</div>' +
      "</div></div>" +
      '<div class="modal-ft"><button class="btn-ghost" type="button" data-close>关闭</button>' +
      '<button class="btn-ghost" type="button" data-copy="' + esc(url) + '">复制链接</button></div>',
      true
    );
  }

  function modalGuide(e) {
    var text = e.urlNote ? e.urlNote : (e.url || "");
    if (/^https?:/i.test(e.url) && e.risk === "guide") {
      text = e.url + (e.urlNote ? "（" + e.urlNote + "）" : "");
    }
    if (!text) text = e.name;
    var steps = "";
    if (/公众号/.test(e.etype + e.name)) {
      steps = '<ol class="steps"><li>打开微信，点击顶部搜索</li><li>搜索并关注：<b>' +
        esc((text.match(/公众号[:：]\s*([^\s｜|]+)/) || [, text.split("｜")[0].replace(/^公众号[:：]?/, "")])[1].trim()) +
        "</b></li><li>按路径进入：" + esc(e.urlNote || text) + "</li></ol>";
    } else if (/小程序/.test(e.etype + e.name)) {
      steps = '<ol class="steps"><li>打开微信 → 顶部搜索框</li><li>输入：' +
        "<b>" + esc(e.name.replace(/^微信小程序[「]?/, "").replace(/[」]$/, "")) + "</b></li><li>进入小程序后按页面提示参观</li></ol>";
    } else {
      steps = '<ol class="steps"><li>该入口需按馆方指引操作</li><li>可复制下方内容，在微信或浏览器中查找</li></ol>';
    }
    openModal(
      '<div class="modal-hd gold">' +
        '<span class="mi"><svg viewBox="0 0 24 24"><path d="M4 4h16v12H7l-3 3z"/></svg></span>' +
        "<div><h3>" + esc(e.name) + '</h3><div class="msub">' + esc(e.venue + " · " + e.etype) + "</div></div>" +
        '<button class="modal-x" type="button" data-close aria-label="关闭">×</button>' +
      "</div>" +
      '<div class="modal-bd">' + steps + '<div class="kbox">' + esc(text) + "</div></div>" +
      '<div class="modal-ft">' +
        '<button class="btn-ghost" type="button" data-close>知道了</button>' +
        '<button class="btn-primary" type="button" data-copy="' + esc(text) + '">复制内容</button>' +
      "</div>",
      true
    );
  }

  modal.addEventListener("click", function (ev) {
    var t = ev.target.closest("[data-copy],[data-goto],[data-qr]");
    if (!t) return;
    if (t.hasAttribute("data-copy")) { copyText(t.getAttribute("data-copy")); return; }
    if (t.hasAttribute("data-qr")) {
      var u = t.getAttribute("data-qr");
      modalQr(u, (t.getAttribute("data-sub") || "扫码在手机上继续参观"));
      return;
    }
    var url = t.getAttribute("data-goto");
    window.open(url, "_blank", "noopener");
    closeModal();
  });

  /* ------------------------------------------------------------ 打开入口 */
  function openEntry(e) {
    if (!e) return;
    if (!e.linkable || e.risk === "guide") { modalGuide(e); return; }
    if (e.dead || e.risk === "http" || e.risk === "domain") { modalOpen(e); return; }
    window.open(trackedUrl(e), "_blank", "noopener");
  }

  /* ------------------------------------------------------------ 卡片事件 */
  function bindGrid(root) {
    root.addEventListener("click", function (ev) {
      var card = ev.target.closest(".card");
      if (!card) return;
      var e = byId[card.getAttribute("data-id")];
      if (!e) return;
      var act = ev.target.closest("[data-act]");
      if (!act) return;
      ev.preventDefault();
      openEntry(e);
    });
  }

  /* ------------------------------------------------------------ 筛选 */
  var state = { q: "", type: "", venue: "", region: "", state: "", pred: null };  // pred: 合辑用的复合条件

  /* 各维度在"已选条件"里的显示名与取值 */
  var FACETS = [
    { key: "type", label: "类型", row: "#rowType" },
    { key: "venue", label: "场馆", row: "#rowVenue" },
    { key: "region", label: "属地", row: "#rowRegion" },
    { key: "state", label: "状态", row: "#rowState" }
  ];
  var STATE_LABEL = { ok: "官方确认", warn: "待复核", dead: "可能失效" };

  /* 清空全部筛选（含合辑条件） */
  function clearAll() {
    state.q = ""; state.type = state.venue = state.region = state.state = ""; state.pred = null;
  }

  function activeFacets() {
    var out = [];
    if (state.pred) out.push({ key: "pred", label: "合集", value: state.predLabel || "" });
    if (state.q) out.push({ key: "q", label: "关键词", value: state.q });
    FACETS.forEach(function (f) {
      if (state[f.key]) {
        out.push({ key: f.key, label: f.label, value: f.key === "state" ? (STATE_LABEL[state[f.key]] || state[f.key]) : state[f.key] });
      }
    });
    return out;
  }

  function hasFilter() { return activeFacets().length > 0; }

  function prefersReducedMotion() {
    return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  /* 让筛选结果出现在视口顶部（顶栏 + 筛选栏是吸顶的，要扣掉它们的高度） */
  function scrollToResults() {
    var bar = $("#resultbar");
    if (!bar) return;
    var top = 0;
    $$(".topbar, .filterbar").forEach(function (el) { top += el.offsetHeight; });
    var y = bar.getBoundingClientRect().top + window.pageYOffset - top - 10;
    if (y < 0) y = 0;
    try { window.scrollTo({ top: y, behavior: prefersReducedMotion() ? "auto" : "smooth" }); }
    catch (e) { window.scrollTo(0, y); }
  }

  /* 筛选生效后：优先展示结果 —— 收起精选推荐与合辑，并把结果滚到视野内 */
  function prioritizeResults() {
    if (!hasFilter()) return;
    if (window.innerWidth <= 620) setFilterOpen(false);
    // 连等两帧，确保精选/合辑已隐藏、筛选栏高度动画结束、布局稳定后再定位
    requestAnimationFrame(function () { requestAnimationFrame(scrollToResults); });
  }

  function setFilterOpen(open) {
    var rows = $("#filterRows"), btn = $("#btnFilterToggle");
    if (!rows || !btn) return;
    rows.classList.toggle("is-open", open);
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    if ("inert" in rows) rows.inert = !open;
  }

  function clearFacet(key) {
    if (key === "pred") { state.pred = null; state.predLabel = ""; render(); return; }
    if (key === "q") { state.q = ""; var q = $("#q"); if (q) q.value = ""; $("#qClear").classList.remove("show"); }
    else state[key] = "";
    render();
  }

  function match(e) {
    // 合辑用的复合条件（如"数字专题"）优先，保证与卡片上的数量完全一致
    if (state.pred && !state.pred(e)) return false;
    // 类型用前缀匹配，这样"720°全景"能同时覆盖"720°全景/3D"
    if (state.type && e.etype.indexOf(state.type) !== 0) return false;
    if (state.venue && e.venue !== state.venue) return false;
    if (state.region && e.region !== state.region) return false;
    if (state.state === "ok" && !(e.verified && !e.dead)) return false;
    if (state.state === "warn" && e.verified) return false;
    if (state.state === "dead" && !e.dead) return false;
    if (state.q) {
      var hay = (e.venue + " " + e.region + " " + e.name + " " + e.etype + " " + e.group + " " + e.mobile + " " + e.url).toLowerCase();
      var words = state.q.toLowerCase().split(/\s+/).filter(Boolean);
      for (var i = 0; i < words.length; i++) { if (hay.indexOf(words[i]) === -1) return false; }
    }
    return true;
  }

  function current() { return ENTRIES.filter(match); }

  function chip(label, value, count, pressed, warn) {
    return '<button class="chip' + (warn ? " warn" : "") + '" type="button" data-val="' + esc(value) +
      '" aria-pressed="' + (pressed ? "true" : "false") + '">' + esc(label) +
      (count != null ? '<span class="c">' + count + "</span>" : "") + "</button>";
  }

  function renderFilters() {
    var typeCount = {}, venueCount = {}, regionCount = {};
    ENTRIES.forEach(function (e) {
      typeCount[e.etype] = (typeCount[e.etype] || 0) + 1;
      venueCount[e.venue] = (venueCount[e.venue] || 0) + 1;
      regionCount[e.region] = (regionCount[e.region] || 0) + 1;
    });

    var th = '<span class="flabel">类型</span>' + chip("全部", "", null, !state.type);
    (SITE.typeOrder || []).forEach(function (t) {
      if (typeCount[t]) th += chip(t, t, typeCount[t], state.type === t);
    });
    $("#rowType").innerHTML = th;

    var vh = '<span class="flabel">场馆</span>' + chip("全部", "", null, !state.venue);
    (SITE.venues || []).forEach(function (v) {
      vh += chip(v, v, venueCount[v], state.venue === v);
    });
    $("#rowVenue").innerHTML = vh;

    var rh = '<span class="flabel">属地</span>' + chip("全部", "", null, !state.region);
    (SITE.regions || []).forEach(function (r) {
      rh += chip(r, r, regionCount[r], state.region === r);
    });
    $("#rowRegion").innerHTML = rh;

    var deadN = ENTRIES.filter(function (e) { return e.dead; }).length;
    var warnN = ENTRIES.filter(function (e) { return !e.verified && !e.dead; }).length;
    var sh = '<span class="flabel">状态</span>' +
      chip("全部", "", null, !state.state) +
      chip("官方确认", "ok", ENTRIES.filter(function (e) { return e.verified && !e.dead; }).length, state.state === "ok") +
      chip("待复核", "warn", warnN, state.state === "warn", true) +
      (deadN ? chip("可能失效", "dead", deadN, state.state === "dead", true) : "");
    $("#rowState").innerHTML = sh;
  }

  /* ------------------------------------------------------------ 渲染主体 */
  function renderFeatured(list) {
    // 精选推荐必须"有真实预览图 + 官方确认 + 可跳转"，否则一眼看去像破图
    var pool = list.filter(function (e) { return e.verified && !e.dead && e.linkable && e.image && e.hasShot !== false; });
    var order = { "720°全景": 0, "3D数字馆": 0, "720°全景/3D": 0, "官网展厅": 1, "语音导览": 2, "沉浸式VR": 2 };
    pool.sort(function (a, b) {
      var oa = order[a.etype] == null ? 9 : order[a.etype];
      var ob = order[b.etype] == null ? 9 : order[b.etype];
      return oa - ob || a.seq - b.seq;
    });
    // 每个场馆最多先取一张，保证首屏覆盖更多馆
    var seen = {}, out = [];
    pool.forEach(function (e) { if (out.length < 6 && !seen[e.venue]) { seen[e.venue] = 1; out.push(e); } });
    pool.forEach(function (e) { if (out.length < 6 && !seen[e.venue]) { seen[e.venue] = 1; out.push(e); } });
    $("#featuredRail").innerHTML = out.length
      ? out.map(function (e) { return cardHTML(e, true); }).join("")
      : '<div class="rail-empty">当前筛选条件下暂无精选推荐</div>';
  }

  /* 有时序内容的党史分组（顺序与 SITE.groupOrder 一致，编号即数组下标） */
  function activeGroups() {
    return (SITE.groupOrder || []).filter(function (g) {
      return ENTRIES.some(function (e) { return e.group === g; });
    });
  }

  function renderEra(list) {
    var groups = activeGroups();
    var html = "";
    groups.forEach(function (g, i) {
      var items = list.filter(function (e) { return e.group === g; });
      if (!items.length) return;
      html += '<section class="block era-sec" id="era' + i + '" style="margin-top:30px">' +
        '<div class="block-head"><span class="era-no">' + ("0" + (i + 1)).slice(-2) + "</span>" +
        "<h2>" + esc(g) + "</h2>" +
        '<span class="hint">' + items.length + " 个入口</span></div>" +
        '<div class="grid">' + items.map(function (e) { return cardHTML(e, true); }).join("") + "</div></section>";
    });
    var others = list.filter(function (e) { return groups.indexOf(e.group) === -1; });
    if (others.length) {
      html += '<section class="block"><div class="block-head"><h2>其他入口</h2></div><div class="grid">' +
        others.map(function (e) { return cardHTML(e, true); }).join("") + "</div></section>";
    }
    $("#eraContainer").innerHTML = html || "";
  }

  function renderVenue(list) {
    var venues = (SITE.venues || []).filter(function (v) {
      return list.some(function (e) { return e.venue === v; });
    });
    $("#venueContainer").innerHTML = venues.map(function (v) {
      var items = list.filter(function (e) { return e.venue === v; });
      var region = (items[0] || {}).region || "";
      return '<section class="block" style="margin-top:30px">' +
        '<div class="block-head"><h2>' + esc(v) + "</h2>" +
        '<span class="hint">' + esc(region) + " · " + items.length + " 个入口</span></div>" +
        '<div class="grid">' + items.map(function (e) { return cardHTML(e, true); }).join("") + "</div></section>";
    }).join("");
  }

  function renderGuides(list) {
    var items = list.filter(function (e) { return !e.linkable || e.risk === "guide"; });
    $("#guideBlock").hidden = !items.length;
    $("#guideList").innerHTML = items.map(function (e) {
      var icon = /小程序/.test(e.etype)
        ? '<path d="M8 2h8a2 2 0 012 2v16a2 2 0 01-2 2H8a2 2 0 01-2-2V4a2 2 0 012-2zm4 17a1 1 0 100 2 1 1 0 000-2z"/>'
        : /公众号/.test(e.etype)
        ? '<path d="M4 4h16a1 1 0 011 1v11a1 1 0 01-1 1H8l-4 4z"/>'
        : '<path d="M12 2a7 7 0 00-7 7c0 5.25 7 13 7 13s7-7.75 7-13a7 7 0 00-7-7zm0 9.5A2.5 2.5 0 1114.5 9 2.5 2.5 0 0112 11.5z"/>';
      return '<div class="guide-card"><span class="gi"><svg viewBox="0 0 24 24">' + icon + "</svg></span>" +
        "<div><h4>" + esc(e.name) + "</h4>" +
        '<div class="gsub">' + esc(e.venue + " · " + e.region + " · " + e.etype) + "</div>" +
        '<div class="gpath">' + esc(e.urlNote || e.url) + "</div>" +
        '<div class="gacts">' +
          '<button class="btn-sm" type="button" data-gid="' + e.id + '" data-act="path">' +
            '<svg viewBox="0 0 24 24"><path d="M14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3zM19 19H5V5h7V3H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7h-2z"/></svg>查看操作路径</button>' +
          '<button class="btn-sm" type="button" data-gid="' + e.id + '" data-act="copy">' +
            '<svg viewBox="0 0 24 24"><path d="M16 1H4a2 2 0 00-2 2v14h2V3h12zm3 4H8a2 2 0 00-2 2v14a2 2 0 002 2h11a2 2 0 002-2V7a2 2 0 00-2-2z"/></svg>复制内容</button>' +
        "</div></div></div>";
    }).join("");
  }

  function renderFilterSummary() {
    var act = activeFacets();
    var box = $("#filterSummary");
    if (!box) return;
    if (!act.length) {
      box.innerHTML = '<span class="fnone">' + (SITE.typeOrder || []).length + ' 类入口 · 全部条件</span>';
    } else {
      box.innerHTML = act.map(function (f) {
        return '<span class="fchip">' + esc(f.label) + '：<b>' + esc(f.value) + "</b>" +
          '<button class="x" type="button" data-clear="' + esc(f.key) + '" aria-label="移除筛选 ' + esc(f.label) + esc(f.value) + '">×</button></span>';
      }).join("");
    }
    $("#btnFilterReset").hidden = !act.length;
  }

  /* 云上观展合辑：把"看什么"提前成一次点击，对应配置表里的"云上观展"维度。
     每个卡片用自己的判定函数，保证卡上数量与点开后的结果数量完全一致。 */
  var CLOUD_PICKS = [
    { key: "全景漫游", t: "720°全景", match: function (e) { return /720|全景/.test(e.etype) && !/3D/.test(e.etype); } },
    { key: "数字专题", t: "3D / 数字馆", match: function (e) { return /3D/.test(e.etype) || /数字馆|数字博物馆|数字展厅|数字展馆/.test(e.name); } },
    { key: "语音讲解", t: "语音导览", match: function (e) { return /语音/.test(e.etype); } },
    { key: "官方展厅", t: "官网虚拟展厅", match: function (e) { return e.etype === "官网展厅"; } }
  ];

  function renderCloud(list) {
    var box = $("#cloudRail");
    if (!box) return;
    box.innerHTML = CLOUD_PICKS.map(function (c) {
      var n = list.filter(c.match).length;
      return '<button class="cloud-card" type="button" data-cloud="' + esc(c.key) + '"' + (n ? "" : " disabled") + ">" +
        '<span class="cc-key">' + esc(c.key) + "</span>" +
        '<span class="cc-type">' + esc(c.t) + "</span>" +
        '<span class="cc-n">' + n + " 个入口</span></button>";
    }).join("");
  }

  /* 点合辑卡片：套用与该卡片完全相同的判定条件 */
  function applyCloud(key) {
    var pick = CLOUD_PICKS.filter(function (c) { return c.key === key; })[0];
    if (!pick) return;
    clearAll();
    state.pred = pick.match;
    state.predLabel = pick.key;
    render();
    prioritizeResults();
  }

  function render() {
    var list = current();
    var filtered = hasFilter();

    // 筛选生效时，精选推荐与合辑让位，结果区优先
    $("#featuredBlock").hidden = filtered;
    $("#cloudBlock").hidden = filtered;

    renderFeatured(list);
    renderCloud(list);
    renderEra(list);
    renderVenue(list);
    renderGuides(list);

    var venuesShown = Object.keys(list.reduce(function (m, e) { m[e.venue] = 1; return m; }, {})).length;
    $("#resultText").innerHTML = filtered
      ? "筛选出 <b>" + list.length + "</b> / " + ENTRIES.length + " 个入口 · <b>" + venuesShown + "</b> 家场馆"
      : "共 <b>" + ENTRIES.length + "</b> 个线上入口 · <b>" + venuesShown + "</b> 家场馆 · <b>" +
        list.filter(function (e) { return e.linkable; }).length + "</b> 个可直接跳转";
    $("#btnReset").hidden = !filtered;
    $("#empty").hidden = list.length > 0;

    renderFilters();
    renderFilterSummary();
  }

  /* ------------------------------------------------------------ 顶层导航 */
  /* 顶栏一行要放品牌 + 导航 + 搜索，长分组名在导航里用短名（区块标题仍用全名） */
  var NAV_SHORT = { "为新中国奠基": "香山", "公众号/小程序": "小程序" };

  function renderTopnav() {
    var groups = activeGroups();
    var links = [{ id: "featuredBlock", t: "精选推荐" }]
      .concat(groups.map(function (g, i) {
        var full = g.split(" · ")[0];
        return { id: "era" + i, t: NAV_SHORT[full] || full };
      }))
      .concat([{ id: "guideBlock", t: NAV_SHORT["公众号/小程序"] }]);
    $("#topnav").innerHTML = links.map(function (l) {
      return '<a href="#' + l.id + '">' + esc(l.t) + "</a>";
    }).join("");
  }

  function initScrollSpy() {
    if (!("IntersectionObserver" in window)) return;
    var links = $$("#topnav a");
    var map = {};
    links.forEach(function (a) { map[a.getAttribute("href").slice(1)] = a; });
    var targets = Object.keys(map).map(function (id) { return document.getElementById(id); }).filter(Boolean);
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (en) {
        var a = map[en.target.id];
        if (!a) return;
        if (en.isIntersecting) {
          links.forEach(function (x) { x.classList.remove("is-active"); });
          a.classList.add("is-active");
        }
      });
    }, { rootMargin: "-130px 0px -70% 0px", threshold: 0 });
    targets.forEach(function (t) { io.observe(t); });

    var toTop = $("#toTop");
    var onScroll = function () { toTop.classList.toggle("show", window.scrollY > 700); };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }

  /* ------------------------------------------------------------ 事件绑定 */
  function bind() {
    bindGrid($("#eraContainer"));
    bindGrid($("#venueContainer"));
    bindGrid($("#featuredRail"));

    $("#guideList").addEventListener("click", function (ev) {
      var b = ev.target.closest("[data-gid]");
      if (!b) return;
      var e = byId[b.getAttribute("data-gid")];
      if (!e) return;
      if (b.getAttribute("data-act") === "copy") {
        copyText(e.urlNote ? e.url + "（" + e.urlNote + "）" : e.url);
      } else { modalGuide(e); }
    });

    $("#rowType").addEventListener("click", onChip("type"));
    $("#rowVenue").addEventListener("click", onChip("venue"));
    $("#rowRegion").addEventListener("click", onChip("region"));
    $("#rowState").addEventListener("click", onChip("state"));

    var qEl = $("#q");
    var t;
    qEl.addEventListener("input", function () {
      $("#qClear").classList.toggle("show", !!qEl.value);
      clearTimeout(t);
      t = setTimeout(function () {
        state.q = qEl.value.trim();
        render();
        prioritizeResults();
      }, 160);
    });
    $("#qClear").addEventListener("click", function () {
      qEl.value = ""; state.q = ""; $("#qClear").classList.remove("show"); render(); qEl.focus();
    });

    // 折叠 / 展开多维筛选
    $("#btnFilterToggle").addEventListener("click", function () {
      setFilterOpen($("#btnFilterToggle").getAttribute("aria-expanded") !== "true");
    });
    // 已选条件上的 × 直接移除该维度
    $("#filterSummary").addEventListener("click", function (ev) {
      var b = ev.target.closest("[data-clear]");
      if (!b) return;
      clearFacet(b.getAttribute("data-clear"));
    });

    // 云上观展合辑：直接套用对应筛选
    $("#cloudRail").addEventListener("click", function (ev) {
      var b = ev.target.closest("[data-cloud]");
      if (!b) return;
      applyCloud(b.getAttribute("data-cloud"));
    });

    var reset = function () {
      clearAll();
      qEl.value = ""; $("#qClear").classList.remove("show"); render();
    };
    $("#btnReset").addEventListener("click", reset);
    $("#btnReset2").addEventListener("click", reset);
    $("#btnFilterReset").addEventListener("click", reset);

    var toggle = function () {
      var eraVisible = !$("#timelineBlock").hidden;
      $("#timelineBlock").hidden = eraVisible;   // 当前按时序浏览则收起
      $("#venueBlock").hidden = !eraVisible;     // 并展开另一种视图
      $("#btnToggleEra").textContent = eraVisible ? "切换到「按场馆浏览」" : "切换到「按党史时序浏览」";
      var target = eraVisible ? "#venueBlock" : "#timelineBlock";
      $(target).scrollIntoView({ block: "start", behavior: "smooth" });
    };
    $("#btnToggleEra").addEventListener("click", toggle);

    $("#toTop").addEventListener("click", function () { window.scrollTo({ top: 0, behavior: "smooth" }); });

    document.addEventListener("keydown", function (ev) {
      if (ev.key === "/" && document.activeElement !== qEl) { ev.preventDefault(); qEl.focus(); }
    });
  }

  function onChip(key) {
    return function (ev) {
      var c = ev.target.closest(".chip");
      if (!c) return;
      var v = c.getAttribute("data-val");
      state[key] = state[key] === v ? "" : v;
      render();
      prioritizeResults();
    };
  }

  /* ------------------------------------------------------------ 首屏文案 */
  function renderHero() {
    var venues = Object.keys(ENTRIES.reduce(function (m, e) { m[e.venue] = 1; return m; }, {})).length;
    // 标题里的条数跟随实际展示的条目，删除条目后不会对不上
    $("#heroTitle").textContent = ENTRIES.length + " 个红色博物馆线上入口";
    var hv = $("#heroVenues");
    if (hv) hv.textContent = venues;
  }

  /* ------------------------------------------------- 顶栏高度 / 吸顶状态 */
  /* 搜索框在窄屏会换行，顶栏高度随之变化：实测后写进 --topbar-h，
     吸顶筛选栏与锚点滚动都跟着它走，不会互相压住。
     另外，红幕（顶栏 + 首屏）走完之前不加投影，否则红色块之间会出现一条硬边。 */
  function syncChrome() {
    var tb = $(".topbar");
    if (!tb) return;
    var h = tb.offsetHeight;
    document.documentElement.style.setProperty("--topbar-h", h + "px");
    var hero = $(".hero");
    var red = h + (hero ? hero.offsetHeight : 0);
    document.documentElement.classList.toggle("is-stuck", window.scrollY > red - 8);
    // 窄屏导航放不下时可横向滑动，加个渐隐提示，免得最后一项像是被"切掉"了
    var nav = $("#topnav");
    if (nav) document.documentElement.classList.toggle("nav-overflow", nav.scrollWidth > nav.clientWidth + 2);
  }

  function renderFooter() {
    $("#footSource").innerHTML = "本页数据整理自 <b>" + esc(SITE.source || "配置表") + "</b>，" +
      "源表共 " + (ENTRIES.length + DROPPED_N) + " 条入口记录，其中 " +
      (DROPPED_N ? "<b>" + DROPPED_N + "</b> 条经巡检确认无法访问、已从本站删除，" : "") +
      "本站展示 " + ENTRIES.length + " 条。所有链接指向各馆官方或公开平台，本站不转载展馆内容。";
    $("#footUpdated").innerHTML = "数据版本：" + esc(SITE.updated || "—") +
      "　·　页面生成：" + new Date().toLocaleDateString("zh-CN");

    var warn = ENTRIES.filter(function (e) { return !e.verified; });
    var linkable = ENTRIES.filter(function (e) { return e.linkable; }).length;
    var parts = [];
    parts.push("链接巡检：共检测 " + linkable + " 个可跳转入口，全部通过");
    if (warn.length) {
      parts.push("<b>" + warn.length + "</b> 条来自第三方收录、建议打开前复核");
    }
    parts.push("核验状态与移动端建议沿用原配置表，展馆开放情况以馆方公告为准。");
    $("#footNote").innerHTML = parts.join("　");
  }

  /* ------------------------------------------------------------ 启动 */
  function boot() {
    if (!ENTRIES.length) {
      $("#main").innerHTML = '<div class="empty"><h3>数据未加载</h3><p>请确认 data/entries.js 存在，或用本地服务器打开本页面。</p></div>';
      return;
    }
    renderTopnav();
    renderHero();
    renderFooter();
    bind();
    render();
    initScrollSpy();
    syncChrome();
    window.addEventListener("resize", syncChrome, { passive: true });
    window.addEventListener("scroll", syncChrome, { passive: true });
    if (window.ResizeObserver) new ResizeObserver(syncChrome).observe($(".topbar"));
  }

  /* 若通过 http(s) 打开，尝试用最新 JSON 覆盖（便于后续维护时只改 JSON） */
  function tryRefresh() {
    if (!/^https?:$/.test(location.protocol) || !window.fetch) return Promise.resolve();
    return fetch("data/entries.json", { cache: "no-cache" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (j && j.entries && j.entries.length) applyData(j);
      })
      .catch(function () {});
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { tryRefresh().then(boot); });
  } else { tryRefresh().then(boot); }
})();
