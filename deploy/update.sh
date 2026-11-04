#!/usr/bin/env bash
# =============================================================================
# 站点更新：备份 -> 校验 -> 同步 -> 重载 -> 清理旧备份
#
# 用法（服务器上，ubuntu 用户 + sudo）：
#   scp deploy/red-museum-nav-site.zip ubuntu@服务器IP:~/     # 本地执行
#   sudo bash /home/ubuntu/update.sh                          # 服务器执行
#   sudo bash /home/ubuntu/update.sh /path/to/other.zip        # 指定别的包
#
# 相比"直接 unzip 覆盖"多做了四件事：
#   1. 更新前整站打包备份到 /var/www/.releases/，出问题可一条命令回滚
#   2. 先解到临时目录并确认有 index.html，包不完整绝不动线上文件
#   3. 用 rsync --delete 同步，删掉的旧图片不会残留在服务器上
#   4. 只保留最近 5 个备份，磁盘不会被撑满
# =============================================================================
set -Eeuo pipefail

ZIP="${1:-/home/ubuntu/red-museum-nav-site.zip}"
ROOT="${SITE_ROOT:-/var/www/red-museum-nav}"
BACKUP_DIR="${BACKUP_DIR:-/var/www/.releases}"
KEEP="${KEEP:-5}"

red()  { printf '\033[31m%s\033[0m\n' "$*"; }
grn()  { printf '\033[32m%s\033[0m\n' "$*"; }
ylw()  { printf '\033[33m%s\033[0m\n' "$*"; }
step() { printf '\n\033[36m==> %s\033[0m\n' "$*"; }

[[ $EUID -eq 0 ]] || { red "请用 sudo 运行：sudo bash $0 [部署包路径]"; exit 1; }
[[ -f "$ZIP" ]]  || { red "找不到部署包：$ZIP"; exit 1; }
[[ -f "$ROOT/index.html" ]] || { red "站点目录异常（缺 index.html）：$ROOT"; exit 1; }

TS="$(date +%Y%m%d-%H%M%S)"
grn "站点目录：$ROOT"
grn "部署包　：$ZIP ($(du -h "$ZIP" | cut -f1))"

# ---------- 1. 备份当前版本 ----------
step "备份当前版本"
mkdir -p "$BACKUP_DIR"
tar -czf "$BACKUP_DIR/site-$TS.tar.gz" -C "$ROOT" .
grn "已备份：$BACKUP_DIR/site-$TS.tar.gz"

# ---------- 2. 解压到临时目录并校验 ----------
step "校验部署包"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
unzip -oq "$ZIP" -d "$TMP"
if [[ ! -f "$TMP/index.html" ]]; then
  red "包内没有 index.html，已中止；线上文件未改动"
  exit 1
fi
grn "包内文件数：$(find "$TMP" -type f | wc -l)"

# ---------- 3. 同步 ----------
step "同步到站点目录"
if ! command -v rsync >/dev/null 2>&1; then
  ylw "未安装 rsync，正在安装…"
  apt-get update -qq && apt-get install -y -qq rsync
fi
rsync -a --delete "$TMP/" "$ROOT/"
chown -R www-data:www-data "$ROOT"
grn "同步完成"

# ---------- 4. 重载并自检 ----------
step "重载 Nginx 并自检"
if ! nginx -t >/tmp/nginx-t.log 2>&1; then
  red "Nginx 配置校验失败，未重载："; cat /tmp/nginx-t.log
  red "如需回滚：sudo bash /home/ubuntu/rollback.sh"
  exit 1
fi
systemctl reload nginx
CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1/ || echo 000)"
echo "   本地首页 HTTP：$CODE（期望 200）"
if [[ "$CODE" == "200" ]]; then grn "✅ 更新完成（$TS）"; else
  ylw "⚠️  本地访问异常，排查：journalctl -u nginx -n 30 --no-pager"
fi

# ---------- 5. 清理旧备份 ----------
step "清理旧备份（保留最近 $KEEP 个）"
if [[ "$(ls -1 "$BACKUP_DIR"/site-*.tar.gz 2>/dev/null | wc -l)" -gt "$KEEP" ]]; then
  ls -1t "$BACKUP_DIR"/site-*.tar.gz | tail -n +$((KEEP + 1)) | xargs -r rm -f
fi
ls -1t "$BACKUP_DIR"/site-*.tar.gz 2>/dev/null | head -n "$KEEP" | sed 's/^/   /'
