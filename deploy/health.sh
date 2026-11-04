#!/usr/bin/env bash
# =============================================================================
# 站点体检：一次看清「活着没、证书还有几天、磁盘够不够、有没有 5xx」
#
# 用法：
#   sudo bash health.sh                 # 自动从 Nginx 配置里读域名
#   sudo bash health.sh 你的域名        # 手动指定
#   sudo bash health.sh 你的域名 -q     # 只输出异常项（适合放进 cron）
# =============================================================================
set -uo pipefail

ROOT="${SITE_ROOT:-/var/www/red-museum-nav}"
BACKUP_DIR="${BACKUP_DIR:-/var/www/.releases}"
QUIET=0
[[ "${2:-}" == "-q" ]] && QUIET=1

red()  { printf '\033[31m%s\033[0m\n' "$*"; }
grn()  { printf '\033[32m%s\033[0m\n' "$*"; }
ylw()  { printf '\033[33m%s\033[0m\n' "$*"; }
hdr()  { [[ $QUIET -eq 1 ]] || printf '\n\033[36m== %s ==\033[0m\n' "$*"; }

# 域名：参数 > Nginx 配置里的第一个 server_name
DOMAIN="${1:-}"
if [[ -z "$DOMAIN" ]]; then
  DOMAIN="$(grep -rhoP '(?<=server_name\s)[^;]+' /etc/nginx/conf.d/ /etc/nginx/sites-enabled/ 2>/dev/null \
            | tr ' ' '\n' | grep -vE '^(_|localhost|www\.$)' | head -1 || true)"
fi

FAILED=0

hdr "站点文件"
if [[ -d "$ROOT" ]]; then
  [[ $QUIET -eq 1 ]] || echo "   目录：$ROOT"
  [[ $QUIET -eq 1 ]] || echo "   大小：$(du -sh "$ROOT" | cut -f1)　文件数：$(find "$ROOT" -type f | wc -l)"
  [[ -f "$ROOT/index.html" ]] || { red "   ✗ 缺 index.html"; FAILED=1; }
else
  red "   ✗ 站点目录不存在：$ROOT"; FAILED=1
fi

hdr "Nginx 服务"
if systemctl is-active --quiet nginx; then
  [[ $QUIET -eq 1 ]] || grn "   ✓ 运行中"
else
  red "   ✗ 未运行（systemctl status nginx）"; FAILED=1
fi
if nginx -t >/tmp/nginx-t.log 2>&1; then
  [[ $QUIET -eq 1 ]] || grn "   ✓ 配置语法正常"
else
  red "   ✗ 配置有误："; cat /tmp/nginx-t.log; FAILED=1
fi

hdr "本地 HTTP"
CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1/ || echo 000)"
if [[ "$CODE" == "200" ]]; then
  [[ $QUIET -eq 1 ]] || grn "   ✓ 首页 200"
else
  red "   ✗ 首页返回 $CODE"; FAILED=1
fi
GCODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1/go.html || echo 000)"
[[ $QUIET -eq 1 ]] || echo "   跳转页 go.html：$GCODE（期望 200）"

hdr "HTTPS 证书"
if [[ -n "$DOMAIN" ]]; then
  END="$(echo | timeout 15 openssl s_client -connect "${DOMAIN}:443" -servername "$DOMAIN" 2>/dev/null \
         | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2 || true)"
  if [[ -n "$END" ]]; then
    EXP="$(date -d "$END" +%s 2>/dev/null || echo 0)"
    DAYS=$(( (EXP - $(date +%s)) / 86400 ))
    if [[ $DAYS -lt 0 ]]; then red "   ✗ 证书已过期（$END）"; FAILED=1
    elif [[ $DAYS -lt 14 ]]; then ylw "   ! 仅剩 $DAYS 天（$END），检查 certbot 续期"; FAILED=1
    else [[ $QUIET -eq 1 ]] || grn "   ✓ 域名 $DOMAIN 剩余 $DAYS 天（$END）"; fi
  else
    ylw "   ! 取不到证书（域名可能还没解析或未配置 HTTPS）"
  fi
else
  ylw "   ! 未识别到域名，跳过（可用 sudo bash health.sh 你的域名）"
fi

hdr "certbot 自动续期"
if systemctl list-timers 2>/dev/null | grep -qi certbot; then
  [[ $QUIET -eq 1 ]] || grn "   ✓ 续期定时器已启用"
else
  ylw "   ! 没看到 certbot 定时器，检查：systemctl list-timers | grep certbot"
fi

hdr "磁盘"
USE="$(df / | awk 'NR==2 {gsub("%","",$5); print $5}')"
AVAIL="$(df -h / | awk 'NR==2 {print $4}')"
if [[ "${USE:-0}" -ge 90 ]]; then red "   ✗ 根分区已用 ${USE}%（剩余 $AVAIL）"; FAILED=1
else [[ $QUIET -eq 1 ]] || grn "   ✓ 根分区已用 ${USE}%（剩余 $AVAIL）"; fi

hdr "最近 5xx"
ERRS="$(awk '$9 ~ /^5/ {print}' /var/log/nginx/access.log 2>/dev/null | tail -5)"
if [[ -n "$ERRS" ]]; then ylw "   发现 5xx："; echo "$ERRS" | sed 's/^/   /'; else
  [[ $QUIET -eq 1 ]] || grn "   ✓ 无 5xx"
fi

hdr "最近 404（Top 5）"
awk '$9 == "404" {print $7}' /var/log/nginx/access.log 2>/dev/null | sort | uniq -c | sort -rn | head -5 | sed 's/^/   /'

hdr "可用备份"
ls -1th "$BACKUP_DIR"/site-*.tar.gz 2>/dev/null | head -5 | sed 's/^/   /' || echo "   （暂无）"

echo
if [[ $FAILED -eq 0 ]]; then grn "体检通过 ✔"; else red "存在问题，见上面的 ✗ / ! 项"; fi
exit $FAILED
