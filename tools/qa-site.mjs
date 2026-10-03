/**
 * 站点自检：校验资源完整性、数据一致性、渲染结果
 * 用法: node tools/qa-site.mjs
 * 输出: _build/qa-site.json 与控制台摘要
 */
import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";

const ROOT = "E:\\工程文件\\dsh\\小程序\\red-museum-nav";
const OUT = path.join(ROOT, "_build");
const CHROME = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].find((p) => fs.existsSync(p));

const problems = [];
const notes = [];
const check = (cond, msg) => { if (!cond) problems.push(msg); else notes.push("OK  " + msg); };

/* ---------- 1. 静态资源完整性 ---------- */
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const refs = [...html.matchAll(/(?:src|href)="([^"#][^"]*)"/g)].map((m) => m[1])
  .filter((u) => !/^(https?:|data:|mailto:)/.test(u));
for (const r of refs) {
  check(fs.existsSync(path.join(ROOT, r)), `index.html 引用的资源存在：${r}`);
}
for (const r of ["assets/styles.css", "assets/app.js", "assets/qr.js", "data/entries.js", "data/entries.json"]) {
  check(fs.existsSync(path.join(ROOT, r)), `关键文件存在：${r}`);
}

/* ---------- 2. 数据完整性 ---------- */
const data = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "entries.json"), "utf8"));
const allEntries = data.entries;
const entries = allEntries;
check(entries.length === 40, `展示 40 条（源表 46 条 − 已删除 6 条，实际 ${entries.length}）`);
check((data.site.droppedCount || 0) === 6, `site.droppedCount = 6（实际 ${data.site.droppedCount}）`);
check(data.site.sourceTotal === 46, `site.sourceTotal = 46（实际 ${data.site.sourceTotal}）`);
check(entries.every((e) => !e.dead), "全部展示条目均通过链接巡检（无失效项）");
check(entries.every((e) => e.excluded === undefined),
  "条目中不再残留 excluded 字段（已改为直接删除）");

// 被删除的入口不得再出现在任何数据里
const dropped = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "dropped.json"), "utf8")).entries;
check(dropped.length === 6, `dropped.json 记录了 6 条删除项（实际 ${dropped.length}）`);
const droppedSeqs = dropped.map((d) => d.seq);
const leakedSeq = allEntries.map((e) => e.seq).filter((s) => droppedSeqs.includes(s));
check(leakedSeq.length === 0, `被删除的序号未出现在数据中（泄漏 ${leakedSeq.join(",") || "无"}）`);

const ids = new Set(allEntries.map((e) => e.id));
check(ids.size === allEntries.length, "入口 id 无重复");
check(entries.filter((e) => e.linkable).length + entries.filter((e) => !e.linkable).length === entries.length, "可跳转/引导卡分类完整");

// 每条 linkable 的入口都应有可解析的链接
for (const e of entries) {
  if (e.linkable) {
    check(/^https?:\/\//i.test(e.url), `${e.id} 链接可解析：${e.url.slice(0, 50)}`);
  } else {
    check(!/^https?:\/\//i.test(e.url), `${e.id} 引导卡未误判为链接`);
  }
}
// 被删除的入口所在场馆，若还有其他入口则应继续留在筛选选项中；否则不应出现
for (const d of dropped) {
  const stillHas = entries.some((x) => x.venue === d.venue);
  check(!data.site.venues.includes(d.venue) || stillHas,
    `已删除入口 ${d.seq} 的场馆（${d.venue}）在筛选选项中状态正确`);
}

// 分组、类型、属地都必须落在站点枚举里
for (const e of entries) {
  check(data.site.groupOrder.includes(e.group), `${e.id} 分组合法：${e.group}`);
  check(data.site.typeOrder.includes(e.etype), `${e.id} 类型合法：${e.etype}`);
  check(data.site.venues.includes(e.venue), `${e.id} 场馆合法：${e.venue}`);
}

// 图片文件是否齐备（凡是有 image 字段的都必须有文件，否则页面会破图）
let imgOk = 0, imgMissing = [], noShot = 0;
for (const e of entries) {
  if (!e.image) { noShot++; continue; }
  if (fs.existsSync(path.join(ROOT, e.image))) imgOk++;
  else imgMissing.push(e.id);
}
check(imgMissing.length === 0, `有预览图字段的卡片图片齐备（${imgOk} 张，缺失 ${imgMissing.length}${imgMissing.length ? "：" + imgMissing.join(",") : ""}）`);
check(imgOk + noShot === entries.length, `预览图 + 占位卡 = 全部条目（${imgOk} + ${noShot} = ${entries.length}）`);
// 截图未采集到的条目（含引导卡）应与 hasShot=false 完全对应
check(entries.filter((e) => e.hasShot === false).length === noShot,
  `未采到截图的条目均已标记 hasShot=false（${noShot} 条）`);

// 弱网优化产物：1x 560×350 / 2x 840×525 / 微缩 20×12，且必须有内联占位
let img2xCount = 0, tinyCount = 0, badSize = [];
const placeholdersSrc = fs.readFileSync(path.join(ROOT, "data", "placeholders.js"), "utf8");
for (const e of entries) {
  if (!e.image) continue;
  const hi = path.join(ROOT, e.image.replace(/\.jpg$/, "@2x.jpg"));
  const tiny = path.join(ROOT, e.image.replace(/\.jpg$/, ".tiny.jpg"));
  if (fs.existsSync(hi)) img2xCount++;
  if (fs.existsSync(tiny)) tinyCount++;
  // 校验 1x 图片实际像素尺寸
  try {
    const buf = fs.readFileSync(path.join(ROOT, e.image));
    let i = 2, dim = null;
    while (i < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const m = buf[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        dim = { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
        break;
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
    if (!dim || dim.w !== 560 || dim.h !== 350) badSize.push(`${e.id}:${dim ? dim.w + "x" + dim.h : "?"}`);
  } catch { badSize.push(`${e.id}:读取失败`); }
}
check(badSize.length === 0, `1x 卡片图尺寸统一为 560×350（异常 ${badSize.length}${badSize.length ? "：" + badSize.join(",") : ""}）`);
check(img2xCount === imgOk, `2 倍图齐备（${img2xCount}/${imgOk}）`);
check(tinyCount === imgOk, `微缩占位图齐备（${tinyCount}/${imgOk}）`);
check((placeholdersSrc.match(/data:image\/jpeg;base64,/g) || []).length === imgOk,
  `占位图内联进 placeholders.js（${imgOk} 张）`);

/* ---------- 3. 内联数据与 JSON 一致 ---------- */
const jsSrc = fs.readFileSync(path.join(ROOT, "data", "entries.js"), "utf8");
const inline = JSON.parse(jsSrc.replace(/^[\s\S]*?window\.__NAV_DATA__\s*=\s*/, "").replace(/;\s*$/, ""));
check(inline.entries.length === allEntries.length, `entries.js 含全部 ${allEntries.length} 条（实际 ${inline.entries.length}）`);
check(inline.entries.map((e) => e.id).join(",") === allEntries.map((e) => e.id).join(","), "entries.js 与 entries.json 顺序一致");
check(inline.site.droppedCount === 6, `内联数据保留了删除数量说明（droppedCount=${inline.site.droppedCount}）`);

/* ---------- 4. 浏览器渲染检查 ---------- */
let render = {};
if (CHROME) {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "shell",
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--hide-scrollbars", "--allow-file-access-from-files"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000 });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text().slice(0, 160)); });
  const failedReq = [];
  page.on("requestfailed", (r) => failedReq.push(r.url().split("/").pop() + " " + (r.failure()?.errorText || "")));

  await page.goto("file:///" + path.join(ROOT, "index.html").replace(/\\/g, "/"), { waitUntil: "load", timeout: 60000 });
  await new Promise((r) => setTimeout(r, 2500));

  render = await page.evaluate(() => {
    const cards = document.querySelectorAll(".card");
    const imgs = Array.from(document.images);
    const broken = imgs.filter((i) => i.complete && i.naturalWidth === 0).map((i) => i.getAttribute("src"));
    const ids = new Set();
    document.querySelectorAll("#eraContainer .card").forEach((c) => ids.add(c.dataset.id));
    // 按场馆视图（默认隐藏）也渲染一份，用于校验
    const venueIds = new Set();
    document.querySelectorAll("#venueContainer .card").forEach((c) => venueIds.add(c.dataset.id));
    // 页面上出现过的全部条目 id（含精选与两个视图）
    const renderedIds = [];
    document.querySelectorAll(".card").forEach((c) => renderedIds.push(c.dataset.id));
    return {
      cards: cards.length,
      renderedIds: renderedIds,
      deadBadges: document.querySelectorAll(".bdg-dead").length,
      resultText: (document.querySelector("#resultText")?.innerText || "").replace(/\s+/g, " "),
      heroTitle: (document.querySelector("#heroTitle")?.textContent || ""),
      heroVenues: (document.querySelector("#heroVenues")?.textContent || ""),
      heroLead: (document.querySelector(".hero .lead")?.innerText || "").replace(/\s+/g, " "),
      thumbs: document.querySelectorAll(".thumb img").length,
      placeholders: document.querySelectorAll(".thumb.ph").length,
      guides: document.querySelectorAll(".guide-card").length,
      featuredCards: document.querySelectorAll("#featuredRail .card").length,
      // 最近浏览功能已移除，这些元素不应再存在
      hasRecentBlock: !!document.querySelector("#recentBlock"),
      hasRecentRail: !!document.querySelector("#recentRail"),
      hasClearRecent: !!document.querySelector("#btnClearRecent"),
      chips: document.querySelectorAll(".chip").length,
      navLinks: document.querySelectorAll("#topnav a").length,
      timelineCards: ids.size,
      venueCards: venueIds.size,
      brokenImages: broken,
      searchVisible: !!document.querySelector("#q"),
      statsText: (document.querySelector("#stats")?.innerText || "").replace(/\s+/g, " "),
      statCount: document.querySelectorAll("#stats .stat").length,
      footSource: (document.querySelector("#footSource")?.innerText || "").replace(/\s+/g, " "),
      // 弱网优化：模糊占位是否内联生效
      inlinePlaceholders: Array.from(document.querySelectorAll(".thumb"))
        .filter((t) => (t.style.backgroundImage || "").includes("data:image")).length,
      srcsetCount: document.querySelectorAll('.thumb img[srcset*="840w"]').length,
      // 收藏功能应已完全移除
      favLeftovers: document.querySelectorAll("#favBtn, #favBlock, #favGrid, .btn-fav").length,
      footNote: (document.querySelector("#footNote")?.innerText || "").slice(0, 120),
      totalImgs: imgs.length,
    };
  });

  // 搜索 / 筛选 / 弹窗 交互
  const interaction = await page.evaluate(async () => {
    const out = {};
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // 每次 render() 都会重建筛选按钮，所以要用"当前 DOM 里"的元素，不能缓存旧引用
    const findChip = () => Array.from(document.querySelectorAll("#rowType .chip"))
      .find((c) => c.textContent.trim().startsWith("720°全景") && !c.textContent.includes("/3D"));

    const q = document.querySelector("#q");
    q.value = "遵义";
    q.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(400);
    out.searchCards = document.querySelectorAll("#eraContainer .card").length;
    out.searchText = document.querySelector("#resultText").innerText.replace(/\s+/g, " ");

    q.value = "";
    q.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(400);
    out.allCards = document.querySelectorAll("#eraContainer .card").length;

    // 类型筛选
    const chip = findChip();
    out.chipFound = !!chip;
    if (chip) {
      const before = out.allCards;
      chip.click();
      await sleep(350);
      out.typeFilterText = document.querySelector("#resultText").innerText.replace(/\s+/g, " ");
      out.typeFilterPressed = findChip()?.getAttribute("aria-pressed");
      out.typeFilterCards = document.querySelectorAll("#eraContainer .card").length;
      out.typeFilterNarrowed = out.typeFilterCards > 0 && out.typeFilterCards < before;
      findChip()?.click();
      await sleep(350);
    }

    // 二维码弹窗（挑一个 http 链接卡片）
    const httpCard = Array.from(document.querySelectorAll(".card")).find((c) => c.querySelector(".bdg-http"));
    out.hasHttpCard = !!httpCard;
    if (httpCard) {
      httpCard.querySelector(".btn-go").click();
      await sleep(300);
      out.modalOpen = document.querySelector("#overlay").classList.contains("open");
      out.modalTitle = (document.querySelector("#modal h3")?.textContent || "");
      const qrBtn = document.querySelector("#modal [data-qr]");
      out.hasQrBtn = !!qrBtn;
      if (qrBtn) {
        qrBtn.click();
        await sleep(700);
        const im = document.querySelector(".qrbox img");
        out.qrRendered = !!im && im.src.startsWith("data:image/") && im.src.length > 2000;
        out.qrTitle = (document.querySelector("#modal h3")?.textContent || "");
      }
      document.querySelector("#modal [data-close]")?.click();
      await sleep(200);
    }

    // 引导卡弹窗（所有其他弹窗必须先关闭，避免叠加干扰）
    document.querySelector("#modal [data-close]")?.click();
    await sleep(250);
    const g = document.querySelector(".guide-card [data-act='path']");
    out.hasGuide = !!g;
    if (g) {
      const gid = g.getAttribute("data-gid");
      const expected = window.__NAV_DATA__.entries.find((e) => e.id === gid)?.name || "";
      g.click();
      await sleep(400);
      out.guideModalTitle = (document.querySelector("#modal h3")?.textContent || "");
      out.guideExpected = expected;
      out.guideModalOpen = document.querySelector("#overlay").classList.contains("open");
      out.guideTitleMatches = !!expected && out.guideModalTitle === expected;
      out.guideHasSteps = !!document.querySelector("#modal .steps");
      document.querySelector("#modal [data-close]")?.click();
      await sleep(250);
    }

    // 视图切换
    const toggle = document.querySelector("#btnToggleEra");
    out.hasToggle = !!toggle;
    if (toggle) {
      toggle.click();
      await sleep(500);
      out.venueVisible = !document.querySelector("#venueBlock").hidden;
      out.timelineHidden = document.querySelector("#timelineBlock").hidden;
      out.venueCards = document.querySelectorAll("#venueContainer .card").length;
      toggle.click();
      await sleep(500);
      out.timelineBack = !document.querySelector("#timelineBlock").hidden;
    }

    /* ---- 折叠筛选 + 筛选后结果优先 ---- */
    const frows = document.querySelector("#filterRows");
    const ftoggle = document.querySelector("#btnFilterToggle");
    out.filterCollapsedByDefault = !frows.classList.contains("is-open") &&
      ftoggle.getAttribute("aria-expanded") === "false" &&
      Math.round(frows.getBoundingClientRect().height) === 0;
    ftoggle.click();
    await sleep(420);
    out.filterExpands = frows.classList.contains("is-open") &&
      frows.getBoundingClientRect().height > 60;

    // 选一个类型筛选项，检验"结果优先"
    const tchip = Array.from(document.querySelectorAll("#rowType .chip"))
      .find((c) => c.textContent.trim().startsWith("720°全景"));
    tchip.click();
    await sleep(700);
    out.afterFilter = {
      featuredHidden: document.querySelector("#featuredBlock").hidden,
      cloudHidden: document.querySelector("#cloudBlock").hidden,
      summaryChips: document.querySelectorAll("#filterSummary .fchip").length,
      summaryText: document.querySelector("#filterSummary").innerText.replace(/\s+/g, " "),
      resetVisible: !document.querySelector("#btnFilterReset").hidden,
      cards: document.querySelectorAll("#eraContainer .card").length,
      scrolled: window.scrollY > 100,
    };
    // 从摘要移除该条件 -> 精选回归
    document.querySelector("#filterSummary .fchip .x")?.click();
    await sleep(500);
    out.afterClear = {
      featuredBack: !document.querySelector("#featuredBlock").hidden,
      cloudBack: !document.querySelector("#cloudBlock").hidden,
      summaryChips: document.querySelectorAll("#filterSummary .fchip").length,
      cards: document.querySelectorAll("#eraContainer .card").length,
    };

    /* ---- 云上观展合辑：卡片数量必须与点开后的结果一致 ---- */
    const cloudKeys = Array.from(document.querySelectorAll(".cloud-card")).map((c) => c.getAttribute("data-cloud"));
    out.cloud = [];
    for (const key of cloudKeys) {
      // 每次重新查询，renderCloud 会重建卡片
      const card = document.querySelector(`.cloud-card[data-cloud="${key}"]`);
      const claimed = Number((card.querySelector(".cc-n").textContent.match(/(\d+)/) || [])[1]);
      card.click();
      await sleep(600);
      const actual = document.querySelectorAll("#eraContainer .card").length;
      out.cloud.push({ key, claimed, actual, ok: claimed === actual });
      document.querySelector("#filterSummary .fchip .x")?.click();
      await sleep(450);
    }
    out.cloudRestored = {
      featured: !document.querySelector("#featuredBlock").hidden,
      cloud: !document.querySelector("#cloudBlock").hidden,
      cards: document.querySelectorAll("#eraContainer .card").length,
    };
    return out;
  });

  /* 移动端：应用筛选后筛选栏应自动收起，腾出屏幕给结果 */
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await new Promise((r) => setTimeout(r, 500));
  const mobileFilter = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const rows = document.querySelector("#filterRows");
    const toggle = document.querySelector("#btnFilterToggle");
    toggle.click();
    await sleep(420);
    const opened = rows.classList.contains("is-open");
    const chip = Array.from(document.querySelectorAll("#rowType .chip"))
      .find((c) => c.textContent.trim().startsWith("720°全景"));
    chip.click();
    await sleep(700);
    const collapsed = !rows.classList.contains("is-open");
    const featuredHiddenWhileFiltered = document.querySelector("#featuredBlock").hidden;
    document.querySelector("#filterSummary .fchip .x")?.click();
    await sleep(400);
    return { opened, autoCollapsed: collapsed, featuredHiddenWhileFiltered };
  });
  check(mobileFilter.opened, "移动端筛选可展开");
  check(mobileFilter.autoCollapsed, "移动端应用筛选后自动收起筛选栏");
  check(mobileFilter.featuredHiddenWhileFiltered, "移动端筛选时精选推荐已让位");
  await page.setViewport({ width: 1440, height: 1000 });
  await new Promise((r) => setTimeout(r, 400));

  // 移动端视口复查
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await new Promise((r) => setTimeout(r, 700));
  const mobile = await page.evaluate(() => {
    const de = document.documentElement;
    const card = document.querySelector(".card");
    const r = card ? card.getBoundingClientRect() : null;
    return {
      hScroll: de.scrollWidth - de.clientWidth,
      cardWidth: r ? Math.round(r.width) : 0,
      gridCols: getComputedStyle(document.querySelector(".grid")).gridTemplateColumns.split(" ").length,
      topbarSticky: getComputedStyle(document.querySelector(".topbar")).position,
    };
  });

  await page.screenshot({ path: path.join(OUT, "qa-desktop.png"), fullPage: false });

  /* ---------- 4b. http(s) 打开时走 fetch(entries.json) 的覆盖分支 ---------- */
  const { spawn } = await import("node:child_process");
  const srv = spawn(process.execPath, [path.join(ROOT, "tools", "serve.mjs"), "8791"], {
    cwd: ROOT, stdio: "ignore",
  });
  await new Promise((r) => setTimeout(r, 1500));
  try {
    const page2 = await browser.newPage();
    const errs2 = [];
    page2.on("pageerror", (e) => errs2.push(e.message));
    await page2.goto("http://127.0.0.1:8791/index.html", { waitUntil: "load", timeout: 30000 });
    await new Promise((r) => setTimeout(r, 2500));
    const viaHttp = await page2.evaluate(() => ({
      cards: document.querySelectorAll("#eraContainer .card").length,
      entries: window.__NAV_DATA__?.entries?.length || 0,
      broken: Array.from(document.images).filter((i) => i.complete && i.naturalWidth === 0).length,
    }));
    check(errs2.length === 0, `http:// 打开无 JS 报错（${errs2.length ? errs2[0] : "0"}）`);
    check(viaHttp.entries === entries.length, `http:// 下 entries.json 覆盖成功（${viaHttp.entries} 条）`);
    check(viaHttp.cards === entries.length, `http:// 下渲染全部卡片（${viaHttp.cards}）`);
    check(viaHttp.broken === 0, `http:// 下无破图（${viaHttp.broken}）`);
    await page2.close();
  } finally {
    srv.kill();
    await new Promise((r) => setTimeout(r, 400));
  }

  await page.setViewport({ width: 1440, height: 1000 });
  await new Promise((r) => setTimeout(r, 400));
  await page.screenshot({ path: path.join(OUT, "qa-full.png"), fullPage: true });
  await browser.close();

  check(errors.length === 0, `浏览器无 JS 报错（${errors.length ? errors.slice(0, 3).join(" | ") : "0"}）`);
  check(failedReq.length === 0, `无资源加载失败（${failedReq.length ? failedReq.slice(0, 3).join(" | ") : "0"}）`);
  check(render.brokenImages.length === 0, `无破图（${render.brokenImages.length}）`);
  check(render.timelineCards === entries.length, `时序视图渲染出全部 ${entries.length} 张卡片（实际 ${render.timelineCards}）`);
  check(render.venueCards === entries.length, `场馆视图渲染出全部卡片（${render.venueCards}）`);
  // 两个视图各渲染一份：有图卡片与占位卡都应各出现两次
  check(render.placeholders === noShot * 2, `占位图数量正确（${render.placeholders} = ${noShot} 条无图 × 2 视图）`);
  // 两个视图各渲染一份；精选推荐区还会额外渲染若干张（也是首次渲染后加载的）
  check(render.thumbs === imgOk * 2 + render.featuredCards,
    `有预览图的卡片渲染数量正确（${render.thumbs} = ${imgOk} × 2 视图 + ${render.featuredCards} 精选）`);
  check(render.guides === entries.filter((e) => !e.linkable).length, `引导卡 ${render.guides} 张 = 不可外链条目数 ${entries.filter((e) => !e.linkable).length}`);
  check(render.navLinks > 0 && render.searchVisible, "顶栏导航与搜索框均渲染");
  check(!render.hasRecentBlock && !render.hasRecentRail && !render.hasClearRecent,
    "最近浏览功能与相关元素已完全移除");
  check(render.favLeftovers === 0, `收藏功能与相关元素已完全移除（残留 ${render.favLeftovers}）`);
  /* 弱网优化 */
  check(render.inlinePlaceholders === imgOk * 2 + render.featuredCards,
    `每张有图卡片都带内联模糊占位（${render.inlinePlaceholders}）`);
  check(render.srcsetCount === imgOk * 2 + render.featuredCards,
    `每张有图卡片都提供 560w/840w 双档 srcset（${render.srcsetCount}）`);
  // 已删除的入口绝不允许出现在页面上
  const leaked = dropped.map((d) => "e" + String(d.seq).padStart(2, "0"))
    .filter((id) => render.renderedIds.includes(id));
  check(leaked.length === 0, `已删除的入口未出现在页面（泄漏 ${leaked.length} 个${leaked.length ? "：" + leaked.join(",") : ""}）`);
  check(render.deadBadges === 0, `页面不再出现"失效"角标（${render.deadBadges} 个）`);
  check(render.heroTitle === `${entries.length} 个红色博物馆线上入口`,
    `首屏标题与展示条数一致（「${render.heroTitle}」）`);
  check(render.statCount === 3 && !/官方确认|可直接跳转/.test(render.statsText),
    `首屏统计为 3 张卡（${render.statsText}）`);
  // 首屏文案里的场馆数必须与统计一致，避免出现"14 家"这类过期文案
  const venueCount = String(Object.keys(entries.reduce((m, e) => (m[e.venue] = 1, m), {})).length);
  check(render.heroVenues === venueCount && render.heroLead.includes(`汇集全国 ${venueCount} 家`),
    `首屏描述中的场馆数为 ${venueCount}（实际「${render.heroVenues}」）`);
  check(!/已隐藏|未能自动核验|可能已失效/.test(render.resultText + render.footNote),
    `结果栏与页脚不再出现"隐藏/失效"字样（${render.resultText.slice(0, 50)}）`);
  check(render.footSource.includes(`源表共 ${entries.length + 6} 条`) && render.footSource.includes("已从本站删除"),
    `页脚如实说明源表 46 条中有 6 条已删除（${render.footSource.slice(0, 60)}）`);
  check(interaction.searchCards > 0 && interaction.searchCards < render.timelineCards, `搜索「遵义」生效（${interaction.searchCards} 张）`);
  check(interaction.allCards === entries.length, "清空搜索后恢复全部卡片");
  check(interaction.chipFound && interaction.typeFilterPressed === "true" && interaction.typeFilterNarrowed,
    `类型筛选生效（${interaction.typeFilterCards} 张，选中态 ${interaction.typeFilterPressed}）`);
  check(interaction.modalOpen && interaction.hasQrBtn, "http 链接弹出二次确认浮层并提供扫码入口");
  check(interaction.qrRendered, "二维码在本地点阵渲染成功");
  check(interaction.guideModalOpen && interaction.guideTitleMatches && interaction.guideHasSteps,
    `引导卡弹窗标题与内容正确（「${interaction.guideModalTitle}」，步骤 ${interaction.guideHasSteps}）`);
  check(interaction.venueVisible === true && interaction.timelineBack === true, "可在时序 / 场馆视图之间来回切换");
  /* 折叠筛选 + 筛选后结果优先 */
  check(interaction.filterCollapsedByDefault, "筛选选项默认折叠（高度为 0）");
  check(interaction.filterExpands, "点击「筛选」可展开全部维度");
  check(interaction.afterFilter.featuredHidden, "筛选后精选推荐已隐藏，结果优先");
  check(interaction.afterFilter.cloudHidden, "筛选后云上观展合辑已隐藏");
  check(interaction.afterFilter.summaryChips === 1 && interaction.afterFilter.resetVisible,
    `已选条件显示在折叠栏上（${interaction.afterFilter.summaryText}）`);
  check(interaction.afterFilter.cards > 0 && interaction.afterFilter.cards < 40,
    `筛选结果数量正确（${interaction.afterFilter.cards} 条）`);
  check(interaction.afterFilter.scrolled, "筛选后视图自动滚动到结果区");
  check(interaction.afterClear.featuredBack && interaction.afterClear.cloudBack && interaction.afterClear.summaryChips === 0,
    "移除条件后精选推荐与合辑自动恢复");
  /* 云上观展合辑：数量与结果一致 */
  const cloudBad = (interaction.cloud || []).filter((c) => !c.ok);
  check((interaction.cloud || []).length >= 3, `云上观展合辑渲染出 ${(interaction.cloud || []).length} 张卡`);
  check(cloudBad.length === 0,
    `合辑卡片数量与实际结果一致（${(interaction.cloud || []).map((c) => c.key + ":" + c.claimed + "/" + c.actual).join(" ")}）`);
  check(interaction.cloudRestored.featured && interaction.cloudRestored.cloud &&
        interaction.cloudRestored.cards === entries.length,
    "撤销合辑筛选后恢复全部内容");
  check(mobile.hScroll === 0, `移动端无横向滚动（溢出 ${mobile.hScroll}px）`);
  check(mobile.gridCols >= 1 && mobile.cardWidth >= 140, `移动端卡片宽度合理（${mobile.cardWidth}px，${mobile.gridCols} 列）`);
  check(mobile.topbarSticky === "sticky", "移动端顶栏保持吸顶");
}

const report = { problems, notes, render, dataSummary: {
  entries: entries.length,
  linkable: entries.filter((e) => e.linkable).length,
  guides: entries.filter((e) => !e.linkable).length,
  dead: entries.filter((e) => e.dead).length,
  thirdParty: entries.filter((e) => !e.verified).length,
  images: imgOk,
  missingImages: imgMissing,
} };
fs.writeFileSync(path.join(OUT, "qa-site.json"), JSON.stringify(report, null, 1), "utf8");

console.log("=== 站点自检 ===");
console.log(`数据：${report.dataSummary.entries} 条（可跳转 ${report.dataSummary.linkable}，引导 ${report.dataSummary.guides}，失效 ${report.dataSummary.dead}，第三方收录 ${report.dataSummary.thirdParty}）`);
console.log(`图片：${imgOk} 张 1x 卡片图（560×350），${img2xCount} 张 2x，${tinyCount} 张内联占位`);
if (Object.keys(render).length) console.log("渲染：", JSON.stringify(render));
console.log(`\n通过 ${notes.length} 项，问题 ${problems.length} 项`);
if (problems.length) console.log("\n问题清单:\n - " + problems.join("\n - "));
