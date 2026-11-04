#!/usr/bin/env bash
# =============================================================================
# 回滚到上一个（或指定）备份
#
# 用法：
#   sudo bash rollback.sh                    # 回滚到最近一次更新前的版本
#   sudo bash rollback.sh site-20261104-103000.tar.gz   # 指定备份
#   ls /var/www/.releases                    # 看有哪些备份
# =============================================================================
set -Eeuo pipefail

ROOT="${SITE_ROOT:-/var/www/red-museum-nav}"
BACKUP_DIR="${BACKUP_DIR:-/var/www/.releases}"

red()  { printf '\033[31m%s\033[0m\n' "$*"; }
grn()  { printf '\033[32m%s\033[0m\n' "$*"; }
ylw()  { printf '\033[33m%s\033[0m\n' "$*"; }

[[ $EUID -eq 0 ]] || { red "请用 sudo 运行：sudo bash $0 [备份文件名]"; exit 1; }
[[ -d "$BACKUP_DIR" ]] || { red "没有备份目录：$BACKUP_DIR"; exit 1; }

if [[ -n "${1:-}" ]]; then
  TARGET="$BACKUP_DIR/$1"
else
  TARGET="$(ls -1t "$BACKUP_DIR"/site-*.tar.gz 2>/dev/null | head -1 || true)"
fi

[[ -n "${TARGET:-}" && -f "$TARGET" ]] || { red "找不到备份文件。可用备份："; ls -1t "$BACKUP_DIR"/site-*.tar.gz 2>/dev/null | sed 's/^/  /'; exit 1; }

ylw "即将用此备份覆盖当前站点："
echo "   $TARGET  ($(du -h "$TARGET" | cut -f1))"
echo "   站点目录：$ROOT"
read -r -p "确认回滚？输入 yes 继续：" ans
[[ "$ans" == "yes" ]] || { echo "已取消"; exit 0; }

tar -xzf "$TARGET" -C "$ROOT"
chown -R www-data:www-data "$ROOT"
nginx -t >/dev/null && systemctl reload nginx
grn "已回滚：$(basename "$TARGET")"
echo -n "本地首页 HTTP："
curl -s -o /dev/null -w '%{http_code}\n' --max-time 10 http://127.0.0.1/
