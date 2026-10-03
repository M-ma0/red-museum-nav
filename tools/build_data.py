# -*- coding: utf-8 -*-
"""构建红色博物馆导航页数据：读取源表格 -> 规范化 entries.json + manifest.json"""
import io
import json
import os
import re
import sys
import urllib.parse

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

ROOT = r"E:\工程文件\dsh\小程序\red-museum-nav"
SRC = os.path.join(ROOT, "_build", "source.xlsx")

import openpyxl

wb = openpyxl.load_workbook(SRC, data_only=True)
# 按关键字定位工作表，避免表名细微差异（空格/全半角）导致失败
def sheet_by(*keywords, fallback_index=0):
    for name in wb.sheetnames:
        if all(k in name for k in keywords):
            return wb[name]
    return wb[wb.sheetnames[fallback_index]]

# ---------------- 1. 线上入口清单 ----------------
ws = sheet_by("入口", "清单", fallback_index=0)
rows = [r for r in ws.iter_rows(values_only=True)]
header = [str(c).strip() if c else "" for c in rows[0]]

# ---------------- 1a. 已确认无法访问、永久剔除的入口 ----------------
# 这些入口在源表格里存在，但巡检确认打不开（404 / 服务器拒绝 / 网络不可达），
# 已从导航页数据中删除。若某条日后恢复，把对应项从这里移除并重跑本脚本即可。
DROPPED = {
    1:  ("官网在本机网络下连接超时，无法打开", "网络不可达"),
    19: ("返回 403，服务器拒绝访问", "403"),
    30: ("返回 404，页面已不存在", "404"),
    36: ("返回 404，页面已不存在", "404"),
    39: ("域名无法连接，站点已下线或限制访问", "网络不可达"),
    40: ("域名无法连接，站点已下线或限制访问", "网络不可达"),
}

raw = []
dropped = []
for r in rows[1:]:
    if r[0] is None:
        continue
    seq = int(r[0])
    if seq in DROPPED:
        dropped.append({
            "seq": seq,
            "venue": str(r[1]).strip(),
            "name": str(r[3]).strip(),
            "url": (str(r[5]).strip() if r[5] else ""),
            "reason": DROPPED[seq][0],
            "kind": DROPPED[seq][1],
        })
        continue
    raw.append({
        "seq": seq,
        "venue": str(r[1]).strip(),
        "region": str(r[2]).strip(),
        "name": str(r[3]).strip(),
        "etype": str(r[4]).strip(),
        "urlRaw": (str(r[5]).strip() if r[5] else ""),
        "verify": str(r[6]).strip(),
        "mobile": str(r[7]).strip() if r[7] else "",
    })

# ---------------- 2. 聚合页 P1 结构 -> 党史时序分组 ----------------
ws3 = sheet_by("P1", fallback_index=2)
p1 = [r for r in ws3.iter_rows(values_only=True)][1:]
groups = []          # [{title, items:[{venue, name, url}]}]
for r in p1:
    if r[0] is None:
        continue
    gtitle = str(r[1]).strip()
    if not groups or groups[-1]["title"] != gtitle:
        groups.append({"title": gtitle, "seq": int(r[0]), "items": []})
    groups[-1]["items"].append({
        "venue": str(r[2]).strip(),
        "etype": str(r[3]).strip(),
        "url": str(r[4]).strip(),
    })
groups.sort(key=lambda g: g["seq"])
group_order = [g["title"] for g in groups]

# --- 2a. 从表格馆名派生简称，用于在 P1 文本中定位场馆 ---
def core_names(venue):
    """派生可用于匹配的简称，从长到短"""
    cands = []
    v = venue.strip()
    if len(v) >= 4:
        cands.append(v)
    # 去掉通用后缀后取主干：西柏坡纪念馆 -> 西柏坡 / 南昌八一起义纪念馆 -> 南昌八一起义
    stripped = re.sub(r"(纪念馆|博物馆|陈列馆|旧址|革命)", "", v)
    if 3 <= len(stripped) < len(v):
        cands.append(stripped)
    return sorted({c for c in cands if len(c) >= 2}, key=len, reverse=True)

# --- 2b. 每条 P1 记录反向匹配到清单场馆 ---
VENUES = sorted({x["venue"] for x in raw})
p1_rows = []
for g in groups:
    for it in g["items"]:
        matched = None
        for c in sorted(sum([core_names(v) for v in VENUES], []), key=len, reverse=True):
            if c and c in it["venue"]:
                # 该简称唯一归属某馆才采用
                owners = [v for v in VENUES if c in v or c in v.replace("中国人民革命军事博物馆", "军博")]
                if len(owners) == 1:
                    matched = owners[0]
                    break
        p1_rows.append({"group": g["title"], "seq": g["seq"], "venueText": it["venue"], "venue": matched})

# 每条清单条目的 P1 命中：优先用序号区间内、venueText 与本条名称最相似的那条
def best_p1_hit(entry):
    cand = [r for r in p1_rows if r["venue"] == entry["venue"]]
    if not cand:
        return None
    def score(r):
        vt = r["venueText"]
        s = 0
        if entry["name"][:6] and entry["name"][:6] in vt:
            s += 2
        for kw in ("官网", "首页", "VR", "3D", "720", "语音", "小程序", "旧址", "展览", "展馆", "全景"):
            if kw in vt and kw in entry["name"]:
                s += 3
        if r["seq"] >= entry["seq"]:
            s += 1
        return (s, -abs(r["seq"] - entry["seq"]))
    return sorted(cand, key=score, reverse=True)[0]

venue_group = {}
venue_first_seq = {v: min(x["seq"] for x in raw if x["venue"] == v) for v in VENUES}
tail_assigned = []
for e in raw:
    hit = best_p1_hit(e)
    if hit:
        # 场馆主分组 = 该馆命中次数最多的分组
        venue_group.setdefault(e["venue"], []).append(hit["group"])
for v in VENUES:
    if v in venue_group:
        counts = {}
        for g in venue_group[v]:
            counts[g] = counts.get(g, 0) + 1
        venue_group[v] = sorted(counts.items(), key=lambda kv: (-kv[1], group_order.index(kv[0])))[0][0]

# P1 未覆盖的场馆：并入与其序号最接近的 P1 分组（就近落位，避免出现兜底大杂烩）
def nearest_group(seq):
    return sorted(groups, key=lambda g: (min(abs(g["seq"] + i - seq) for i in range(len(g["items"])))))[0]["title"]

for v in VENUES:
    if v not in venue_group:
        venue_group[v] = nearest_group(venue_first_seq[v])
        tail_assigned.append((v, venue_group[v]))


# ---------------- 3. 入口类型归一化 ----------------
def norm_type(t):
    if "720" in t and "3D" in t:
        return "720°全景/3D"
    if "720" in t:
        return "720°全景"
    if "3D" in t:
        return "3D数字馆"
    if "小程序" in t:
        return "微信小程序"
    if "公众号" in t:
        return "公众号引导"
    if "语音" in t:
        return "语音导览"
    if "VR" in t or "LBE" in t:
        return "沉浸式VR"
    if "官网" in t:
        return "官网展厅"
    return t or "其他"

TYPE_ORDER = ["720°全景", "720°全景/3D", "3D数字馆", "官网展厅",
              "语音导览", "沉浸式VR", "微信小程序", "公众号引导", "其他"]

# 入口类型 -> 浏览维度（对应"公众号菜单配置"表的云上观展/学习教育）
TYPE_BUCKET = {
    "720°全景": "云上观展", "720°全景/3D": "云上观展", "3D数字馆": "云上观展",
    "官网展厅": "云上观展", "语音导览": "云上观展", "沉浸式VR": "云上观展",
    "微信小程序": "走进场馆", "公众号引导": "走进场馆", "其他": "学习教育",
}

# ---------------- 4. 链接归一化 ----------------
REAL_URL = re.compile(r"^(https?://|//)", re.I)

def clean_url(u):
    """去掉链接尾部的中文备注，并返回 (url, note)"""
    u = u.strip()
    m = re.match(r"^(https?://\S+?)\s*[（(]([^）)]*)[）)]\s*$", u)
    if m:
        return m.group(1), m.group(2)
    return u, ""

entries = []
for x in raw:
    url, note = clean_url(x["urlRaw"])
    linkable = bool(REAL_URL.match(url))
    host = urllib.parse.urlparse(url).hostname if linkable else ""
    https = url.lower().startswith("https://") if linkable else False
    risky_tld = bool(host) and (host.endswith(".mil.cn") or host.endswith(".gov.cn"))
    # 风险等级：决定点击行为
    if not linkable:
        risk = "guide"          # 引导卡，不跳转
    elif not https:
        risk = "http"           # 微信内会被拦截 -> 二次确认 + 复制
    elif risky_tld:
        risk = "domain"         # 特殊域名 -> 二次确认
    else:
        risk = "ok"
    entries.append({
        "id": "e%02d" % x["seq"],
        "seq": x["seq"],
        "venue": x["venue"],
        "region": x["region"],
        "name": x["name"],
        "etype": norm_type(x["etype"]),
        "bucket": TYPE_BUCKET[norm_type(x["etype"])],
        "url": url,
        "urlNote": note,
        "host": host or "",
        "mobile": x["mobile"],
        "verified": x["verify"] == "官方确认",
        "verify": x["verify"],
        "linkable": linkable,
        "https": https,
        "risk": risk,
        "group": venue_group[x["venue"]],
        "image": "images/thumbs/%s.jpg" % ("e%02d" % x["seq"]),
    })

entries.sort(key=lambda e: e["seq"])

# ---------------- 5. 站点配置 ----------------
site = {
    "title": "红色博物馆 · 云上观展导航",
    "subtitle": "%d 家场馆 · %d 个线上入口 · 一处直达" % (
        len({e["venue"] for e in entries}), len(entries)),
    "source": "《红色博物馆线上入口与公众号菜单配置表》",
    "updated": "2026-09-13",
    "groupOrder": group_order,
    "typeOrder": TYPE_ORDER,
    "buckets": ["云上观展", "走进场馆", "学习教育"],
    "venues": sorted({e["venue"] for e in entries},
                     key=lambda v: min(x["seq"] for x in entries if x["venue"] == v)),
    "regions": sorted({e["region"] for e in entries}),
    "droppedCount": len(dropped),
    "sourceTotal": len(entries) + len(dropped),
}

data = {"site": site, "entries": entries}
with io.open(os.path.join(ROOT, "data", "entries.json"), "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False, indent=1)

# 删除记录（留档，便于日后核对或恢复）
with io.open(os.path.join(ROOT, "data", "dropped.json"), "w", encoding="utf-8") as f:
    json.dump({
        "note": "以下入口因确认无法访问，已从导航页数据中删除；如需恢复，删除 tools/build_data.py 中 DROPPED 的对应项并重跑该脚本。",
        "entries": dropped,
    }, f, ensure_ascii=False, indent=1)

# ---------------- 6. 截图任务清单 ----------------
# 站点级截图目标覆盖：优先抓该站最有视觉冲击力的展馆页
URL_OVERRIDE = {
    "e29": "http://www.txssw.com/",
    "e32": "http://www.gthyjng.cn/gtie/index.html",
    "e33": "http://www.gthyjng.cn/shjy/xxjyhd/",
}
shots = []
for e in entries:
    if not e["linkable"]:
        continue
    shots.append({
        "id": e["id"],
        "url": URL_OVERRIDE.get(e["id"], e["url"]),
        "venue": e["venue"],
        "name": e["name"],
        "image": e["image"],
    })
with io.open(os.path.join(ROOT, "_build", "shots.json"), "w", encoding="utf-8") as f:
    json.dump(shots, f, ensure_ascii=False, indent=1)

# ---------------- 7. 控制台摘要 ----------------
print("条目总数:", len(entries))
print("可跳转:", sum(1 for e in entries if e["linkable"]), " 引导卡:", sum(1 for e in entries if not e["linkable"]))
print("风险分布:", {k: sum(1 for e in entries if e["risk"] == k) for k in ("ok", "http", "domain", "guide")})
print("分组:")
for g in group_order:
    venues = sorted({e["venue"] for e in entries if e["group"] == g},
                    key=lambda v: venue_first_seq[v])
    n = sum(1 for e in entries if e["group"] == g)
    print("   %-22s %2d条  %s" % (g, n, "/".join(venues)))
print("P1未覆盖、就近落位的场馆:", tail_assigned)
print("类型:", {t: sum(1 for e in entries if e["etype"] == t) for t in TYPE_ORDER if any(e["etype"] == t for e in entries)})
print("待截图:", len(shots))
print("已删除的无法访问入口: %d 条" % len(dropped))
for d in dropped:
    print("   - 序号%02d %s %s（%s）" % (d["seq"], d["venue"], d["name"][:26], d["reason"]))
