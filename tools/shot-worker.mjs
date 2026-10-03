/**
 * 预览图采集器：用本机 Chrome 逐条真实截图
 * 用法: node shot-worker.mjs <shots.json> <输出目录1[,目录2...]> <分片序号> <分片总数>
 *       已存在于任一输出目录的截图会被跳过，便于断点续采。
 */
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import path from "node:path";

const [, , SHOTS_PATH, OUT_DIRS_STR, SHARD_STR = "0", SHARD_TOTAL_STR = "1"] = process.argv;
const SHARD = Number(SHARD_STR);
const SHARD_TOTAL = Number(SHARD_TOTAL_STR);
const OUT_DIRS = String(OUT_DIRS_STR).split(",").map((s) => s.trim()).filter(Boolean);
const OUT_DIR = OUT_DIRS[0];
const REPORT_DIR = path.join(OUT_DIR, "..", "..", "_build");
fs.mkdirSync(OUT_DIR, { recursive: true });
for (const d of OUT_DIRS) fs.mkdirSync(d, { recursive: true });

/** 该条目是否已经采过（任一目录命中即算） */
function alreadyCaptured(shot) {
  const base = path.basename(shot.image);
  return OUT_DIRS.some((d) => fs.existsSync(path.join(d, base)));
}

const CHROME_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];
const CHROME = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
if (!CHROME) {
  fs.writeFileSync(path.join(REPORT_DIR, `shots-report-${SHARD}.json`), JSON.stringify({ fatal: "no browser found" }));
  process.exit(1);
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/* 部分站点做了防盗链，必须带 Referer 才返回 200（已实测：vr.fumenhu.cn） */
const REFERER = {
  "e09": "http://vr.fumenhu.cn/",
  "e10": "http://vr.fumenhu.cn/",
  "e11": "http://vr.fumenhu.cn/",
};
/* 需要更长时间等待的服务（.mil.cn 系列加载很慢） */
const SLOW = { "e38": 2, "e41": 2, "e01": 2, "e39": 2, "e40": 2 };
/* 检测到这些文案直接判为错误页，不写入图片（页面可能是"友好的"定制错误页） */
const ERROR_TEXT = [
  /403\s*Forbidden/i, /404\s*Not\s*Found/i, /502\s*Bad\s*Gateway/i, /503\s*Service/i,
  /Access\s*Denied/i, /页面不存在/, /页面未找到/, /您访问的页面/, /找不到页面/,
  /该页面无法访问/, /网站维护中/, /域名.*未绑定/, /Error\s*404/i,
];
const MIN_BYTES = 20000;
/* 页面文字里出现"404 / Error"同时命中这些词，也判为错误页（标题里同样检查） */
const ERR_HINT = /(404|error|错误|不存在|找不到)/i;

/** 读取 JSON，容忍 Windows 工具写入的 UTF-8 BOM */
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

const shots = readJson(SHOTS_PATH).filter((_, i) => i % SHARD_TOTAL === SHARD);
const report = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 关掉"进入网站"这类引导浮层、cookie 弹窗 */
async function dismissInterstitials(page) {
  const PATTERNS = [
    "^进入网站$", "^进入官网$", "^进入$", "^点击进入", "^开始参观$", "^立即进入",
    "^同意$", "^我同意$", "^接受$", "^知道了$", "^继续访问$", "^跳过$",
  ];
  try {
    return await page.evaluate((src) => {
      const res = [];
      const els = Array.from(document.querySelectorAll("a,button,div,span,input[type=button],input[type=submit]"));
      for (const el of els) {
        const t = (el.textContent || el.value || "").replace(/\s+/g, "").trim();
        if (!t || t.length > 14) continue;
        if (!src.some((p) => new RegExp(p).test(t))) continue;
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        if (r.width < 24 || r.height < 16 || st.display === "none" || st.visibility === "hidden") continue;
        if (r.top > window.innerHeight * 0.85) continue; // 页脚链接通常不是入口
        try {
          el.click();
          res.push(t);
        } catch {}
        break;
      }
      return res;
    }, PATTERNS);
  } catch {
    return [];
  }
}

/** 让页面滚动一下，触发懒加载的图片 */
async function nudgeScroll(page) {
  try {
    await page.evaluate(async () => {
      const step = window.innerHeight * 0.8;
      for (let y = 0; y < Math.min(document.body.scrollHeight, 2400); y += step) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 220));
      }
      window.scrollTo(0, 0);
      await new Promise((r) => setTimeout(r, 400));
    });
  } catch {}
}

async function newPage(browser, shot) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  await page.setUserAgent(UA);
  const headers = {
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  };
  if (shot && REFERER[shot.id]) headers.Referer = REFERER[shot.id];
  await page.setExtraHTTPHeaders(headers);
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const t = req.resourceType();
    if (t === "media" || t === "font") return req.abort().catch(() => {});
    req.continue().catch(() => {});
  });
  page.on("dialog", (d) => d.dismiss().catch(() => {}));
  return page;
}

async function capture(browser, shot, attempt) {
  const slow = SLOW[shot.id] || attempt > 0;
  const verySlow = SLOW[shot.id] === 2;
  const page = await newPage(browser, shot);
  let note = "";
  const say = (s) => {
    note = note ? note + ";" + s : s;
  };
  try {
    await page.goto(shot.url, { waitUntil: "domcontentloaded", timeout: slow ? 75000 : 45000 });
    try {
      await page.waitForNetworkIdle({ idleTime: 1500, timeout: verySlow ? 45000 : slow ? 25000 : 12000 });
    } catch {
      say("network-idle-timeout");
    }
    await sleep(verySlow ? 25000 : slow ? 12000 : attempt === 0 ? 3500 : 6500);
    const hits = await dismissInterstitials(page);
    if (hits.length) {
      say("dismissed:" + hits.join(","));
      await sleep(5000);
    }
    // 全景/3D 站点：等 canvas 出现并给渲染留时间
    const hasCanvas = await page.evaluate(() => !!document.querySelector("canvas")).catch(() => false);
    if (hasCanvas) {
      await sleep(4500);
      say("canvas");
    }
    // 再清一次浮层（有些弹窗延迟出现），并点掉页面空白处收起重叠层
    const hits2 = await dismissInterstitials(page);
    if (hits2.length) {
      say("dismissed2:" + hits2.join(","));
      await sleep(3500);
    }
    await page.mouse.click(640, 400).catch(() => {});
    await sleep(1200);
    // 关掉盖住画面的介绍性遮罩（点右上角/关闭按钮）
    const closed = await page
      .evaluate(() => {
        let n = 0;
        for (const sel of ['[class*="close"]', '[class*="Close"]', '[aria-label*="关闭"]', '[title="关闭"]']) {
          for (const el of Array.from(document.querySelectorAll(sel))) {
            const r = el.getBoundingClientRect();
            const st = getComputedStyle(el);
            if (r.width < 8 || r.height < 8 || r.top > window.innerHeight * 0.8) continue;
            if (st.display === "none" || st.visibility === "hidden" || st.opacity === "0") continue;
            try {
              el.click();
              n++;
            } catch {}
            if (n >= 2) return n;
          }
        }
        return n;
      })
      .catch(() => 0);
    if (closed) say("closed:" + closed);
    await sleep(700);
    await nudgeScroll(page);
    await sleep(900);

    const metrics = await page.evaluate(() => {
      const imgs = Array.from(document.images || []);
      const loaded = imgs.filter((i) => i.complete && i.naturalWidth > 60).length;
      const big = imgs.filter(
        (i) => i.naturalWidth >= 380 && i.naturalHeight >= 240 && i.complete && i.naturalWidth > 0
      ).length;
      const text = (document.body?.innerText || "").replace(/\s+/g, "");
      return {
        imgTotal: imgs.length,
        imgLoaded: loaded,
        imgBig: big,
        textLen: text.length,
        textHead: text.slice(0, 200),
        textAll: text.slice(0, 500),
        canvas: !!document.querySelector("canvas"),
        title: document.title || "",
        scrollH: document.body ? document.body.scrollHeight : 0,
      };
    });

    const buf = await page.screenshot({ type: "jpeg", quality: 84, clip: { x: 0, y: 0, width: 1280, height: 800 } });
    // 错误页 / 空白页判定
    if (buf.length < MIN_BYTES) throw new Error(`tiny image (${buf.length}B) — 疑似错误页或空页`);
    const hay = metrics.textHead + " " + metrics.textAll + " " + metrics.title;
    if (ERROR_TEXT.some((re) => re.test(hay)) ||
        (ERR_HINT.test(metrics.title) && /404|not\s*found|不存在/i.test(hay))) {
      throw new Error(`error page: ${(metrics.title || metrics.textHead).slice(0, 40)}`);
    }
    if (metrics.imgBig === 0 && !metrics.canvas && metrics.textLen < 40) {
      throw new Error(`blank-ish page (img=${metrics.imgBig} text=${metrics.textLen})`);
    }

    const dest = path.join(OUT_DIR, path.basename(shot.image));
    fs.writeFileSync(dest, buf);
    report.push({ id: shot.id, ok: true, bytes: buf.length, note, ...metrics });
    return true;
  } catch (e) {
    report.push({ id: shot.id, ok: false, error: String(e.message || e).slice(0, 200), note, attempt });
    return false;
  } finally {
    await page.close().catch(() => {});
  }
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "shell",
  protocolTimeout: 120000,
  args: [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--hide-scrollbars",
    "--mute-audio",
    "--ignore-certificate-errors",
    "--disable-blink-features=AutomationControlled",
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--window-size=1280,800",
    `--user-data-dir=${path.join(REPORT_DIR, "chrome-profile-" + SHARD)}`,
  ],
});

for (const shot of shots) {
  if (alreadyCaptured(shot)) {
    report.push({ id: shot.id, ok: true, skipped: "exists" });
    continue;
  }
  let done = false;
  for (let attempt = 0; attempt < 2 && !done; attempt++) {
    // 单个条目设置硬性上限，避免个别站点把整条流水线拖死
    let timer;
    const deadline = new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error("hard-deadline 150s exceeded")), 150000);
    });
    try {
      done = await Promise.race([capture(browser, shot, attempt), deadline]);
    } catch (e) {
      report.push({ id: shot.id, ok: false, error: String(e.message || e).slice(0, 160), attempt, deadline: true });
      done = false;
    } finally {
      clearTimeout(timer);
    }
  }
}

await browser.close().catch(() => {});
fs.writeFileSync(
  path.join(REPORT_DIR, `shots-report-${SHARD}.json`),
  JSON.stringify({ shard: SHARD, total: SHARD_TOTAL, results: report }, null, 1),
  "utf8"
);
console.log(`shard ${SHARD}: ${report.filter((r) => r.ok && !r.skipped).length}/${shots.length} captured`);
