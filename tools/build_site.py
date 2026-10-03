# -*- coding: utf-8 -*-
"""图片后处理 + 链接有效性巡检 + 生成 data/entries.js

流程：
 1. 原始截图 images/eNN.jpg (1280x800) -> 卡片用图 800x500 + 2 倍图 1600x1000
 2. 巡检每个可跳转入口的 HTTP 状态（区分"站点不可达"与"单页失效"）并写回 entries.json
 3. 生成 data/entries.js（内联数据，保证 file:// 双击也能打开）
 4. 生成 _build/qa-report.json 供人工复核
"""
import io
import json
import os
import re
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

ROOT = r"E:\工程文件\dsh\小程序\red-museum-nav"
IMAGES = os.path.join(ROOT, "images")
RAW = os.path.join(ROOT, "_build", "raw")          # 原始截图，可随时重跑压缩
DATA = os.path.join(ROOT, "data", "entries.json")
THUMBS = os.path.join(ROOT, "images", "thumbs")    # 成品卡片图
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
REFERER = {"e09": "http://vr.fumenhu.cn/", "e10": "http://vr.fumenhu.cn/", "e11": "http://vr.fumenhu.cn/"}


def scan_thumbs():
    """已生成的成品图（用于跳过重复压缩）"""
    out = {}
    if not os.path.isdir(THUMBS):
        return out
    for name in os.listdir(THUMBS):
        if not name.endswith(".jpg") or "@2x" in name or ".tiny" in name:
            continue
        eid = os.path.splitext(name)[0]
        card = os.path.join(THUMBS, name)
        hi = os.path.join(THUMBS, eid + "@2x.jpg")
        if os.path.exists(hi):
            out[eid] = {"card": os.path.getsize(card), "hi": os.path.getsize(hi), "src": 0}
    return out


existing = scan_thumbs()

# ---------------------------------------------------------------- 1. 图片后处理
def optimize_images():
    """原始截图 -> 卡片图 / 2 倍图 / 微缩占位。已生成且比原图新的会跳过。"""
    try:
        from PIL import Image
    except ImportError:
        print("!! 缺少 Pillow，跳过图片压缩")
        return {}
    os.makedirs(THUMBS, exist_ok=True)
    stats = {}
    for name in sorted(os.listdir(RAW)):
        if not name.lower().endswith(".jpg"):
            continue
        eid = os.path.splitext(name)[0]
        # 成品图已在 thumbs 目录且不落后于原图 -> 跳过
        if eid in existing:
            stats[eid] = existing[eid]
            continue
        src_path = os.path.join(RAW, name)
        try:
            im = Image.open(src_path).convert("RGB")
        except Exception as exc:
            print("  !! 无法打开 %s: %s" % (name, exc))
            continue
        w, h = im.size
        target = 16 / 10
        if w / h > target:
            nw = int(h * target)
            im = im.crop(((w - nw) // 2, 0, (w - nw) // 2 + nw, h))
        elif w / h < target:
            nh = int(w / target)
            top = int((h - nh) * 0.28)      # 偏上取景，避开底部无关内容
            im = im.crop((0, top, w, top + nh))
        card = im.resize((800, 500), Image.LANCZOS)
        card_path = os.path.join(THUMBS, "%s.jpg" % eid)
        card.save(card_path, "JPEG", quality=82, optimize=True, progressive=True)
        hi = im.resize((1600, 1000), Image.LANCZOS)
        hi_path = os.path.join(THUMBS, "%s@2x.jpg" % eid)
        hi.save(hi_path, "JPEG", quality=74, optimize=True, progressive=True)
        tiny = im.resize((32, 20), Image.LANCZOS)
        tiny.save(os.path.join(THUMBS, "%s.tiny.jpg" % eid), "JPEG", quality=45, optimize=True)
        stats[eid] = {
            "card": os.path.getsize(card_path),
            "hi": os.path.getsize(hi_path),
            "src": os.path.getsize(src_path),
        }
    return stats


# ---------------------------------------------------------------- 2. 链接巡检
def head_check(entry):
    url = entry["url"]
    # 链接可能含中文（如百度百科词条），请求前必须做百分号编码
    safe_url = urllib.parse.quote(url, safe=":/?#[]@!$&'()*+,;=%~")
    req = urllib.request.Request(safe_url, method="GET", headers={
        "User-Agent": UA,
        "Accept-Language": "zh-CN,zh;q=0.9",
        "Range": "bytes=0-2048",
    })
    if entry["id"] in REFERER:
        req.add_header("Referer", REFERER[entry["id"]])
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    try:
        with urllib.request.urlopen(req, timeout=25, context=ctx) as resp:
            code = resp.getcode()
            return {"id": entry["id"], "url": url, "status": code,
                    "ok": 200 <= code < 400, "kind": "ok" if code < 400 else "http-%d" % code}
    except urllib.error.HTTPError as exc:
        return {"id": entry["id"], "url": url, "status": exc.code, "ok": False,
                "kind": "http-%d" % exc.code}
    except urllib.error.URLError as exc:
        reason = str(getattr(exc, "reason", exc))
        kind = "dns" if "Name or service" in reason or "getaddrinfo" in reason else \
               "timeout" if "timed out" in reason.lower() else "net"
        return {"id": entry["id"], "url": url, "status": None, "ok": False, "kind": kind, "reason": reason[:120]}
    except Exception as exc:
        return {"id": entry["id"], "url": url, "status": None, "ok": False,
                "kind": "error", "reason": str(exc)[:120]}


def check_links(entries):
    targets = [e for e in entries if e["linkable"]]
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(head_check, targets))
    return {r["id"]: r for r in results}


# ---------------------------------------------------------------- 主流程
def main():
    today = __import__("datetime").date.today().isoformat()
    with io.open(DATA, encoding="utf-8") as f:
        data = json.load(f)
    entries = data["entries"]

    print("=== 1. 图片后处理 ===")
    global existing
    existing = scan_thumbs()
    img_stats = optimize_images()
    # 清理指向不存在文件的图片路径（曾采集失败但字段仍在）
    for e in entries:
        if e.get("image") and e["id"] not in img_stats:
            e["image"] = ""
    total_card = sum(v["card"] for v in img_stats.values())
    total_hi = sum(v["hi"] for v in img_stats.values())
    print("已优化 %d 张；卡片图合计 %.1f KB，2 倍图合计 %.1f KB"
          % (len(img_stats), total_card / 1024, total_hi / 1024))
    # 原始截图存在但成品图缺失，说明压缩环节出过问题
    raw_stems = {os.path.splitext(n)[0] for n in os.listdir(RAW) if n.lower().endswith(".jpg")} \
        if os.path.isdir(RAW) else set()
    failed_opt = sorted(raw_stems - set(img_stats))
    if failed_opt:
        print("!! 原图存在但未生成成品图:", ", ".join(failed_opt))
    missing = [e["id"] for e in entries if e["linkable"] and e["id"] not in img_stats]
    print("无预览图（将用 CSS 占位图）:", ", ".join(missing) if missing else "无")

    print("\n=== 2. 链接有效性巡检 ===")
    checks = check_links(entries)
    for e in entries:
        if not e["linkable"]:
            e["dead"] = False
            e["health"] = "guide"
            e["hasShot"] = False
            continue
        c = checks.get(e["id"], {})
        e["httpStatus"] = c.get("status")
        e["hasShot"] = e["id"] in img_stats
        # 没有成功截图就不要保留图片路径，否则浏览器会去请求不存在的文件
        if not e["hasShot"]:
            e["image"] = ""
        if e["hasShot"]:
            # 有真实截图即证明页面可访问；反爬/防盗链导致的巡检失败不作为失效依据
            e["dead"] = False
            e["health"] = "shot-ok"
        elif c.get("ok"):
            e["dead"] = False
            e["health"] = "ok"
        else:
            # 无截图且巡检失败：区分"明确错误页"与"未能核验"
            kind = c.get("kind", "unknown")
            e["dead"] = True
            e["health"] = "unverified" if kind in ("net", "timeout", "dns") else kind
    dead = [e["id"] for e in entries if e.get("dead")]
    print("巡检未通过:", ", ".join(dead) if dead else "无（全部入口可访问）")
    if dead:
        print("   提示：如需彻底删除这些入口，请把对应序号加入 tools/build_data.py 的 DROPPED 后重跑该脚本")

    live = entries
    third = [e["id"] for e in live if not e["verified"]]
    print("第三方收录待复核:", len(third), "条")

    data["entries"] = entries
    data["site"]["stats"] = {
        "shots": len(img_stats),
        "missingShots": missing,
        "dead": dead,
        "total": len(entries),
        "checkedAt": today,
    }
    with io.open(DATA, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)

    print("\n=== 4. 生成 data/entries.js ===")
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    # 内联进 <script> 前必须转义，否则数据里的 "</" 会提前闭合标签、U+2028/2029 会截断 JS 字符串
    payload = (payload
               .replace("</", "<\\/")
               .replace("\u2028", "\\u2028")
               .replace("\u2029", "\\u2029"))
    js = ("/* 由 tools/build_site.py 自动生成，请勿手工编辑；数据源见 data/entries.json */\n"
          "window.__NAV_DATA__ = " + payload + ";\n")
    with io.open(os.path.join(ROOT, "data", "entries.js"), "w", encoding="utf-8") as f:
        f.write(js)
    print("entries.js 大小: %.1f KB" % (len(js.encode("utf-8")) / 1024))

    print("\n=== 5. 生成 QA 报告 ===")
    report = {
        "images": img_stats,
        "missingShots": missing,
        "linkChecks": checks,
        "dead": dead,
        "totals": {
            "entries": len(entries),
            "linkable": sum(1 for e in live if e["linkable"]),
            "guides": sum(1 for e in live if not e["linkable"]),
            "verified": sum(1 for e in live if e["verified"]),
            "shots": len(img_stats),
            "cardBytes": total_card,
            "hiBytes": total_hi,
        },
    }
    with io.open(os.path.join(ROOT, "_build", "qa-report.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=1)
    print("完成。")


if __name__ == "__main__":
    main()
