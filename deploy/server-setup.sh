#!/usr/bin/env bash
# =============================================================================
# 红色博物馆云上观展导航 —— 服务器一键部署
#
# 用法：
#   1) 本地把两个文件传到服务器（腾讯云 Ubuntu 镜像默认用户是 ubuntu，root 不是登录用户）：
#        scp deploy/red-museum-nav-site.zip ubuntu@服务器IP:~/
#        scp deploy/server-setup.sh          ubuntu@服务器IP:~/
#   2) 登录服务器，修掉可能存在的 Windows 换行，然后用 sudo 执行：
#        ssh ubuntu@服务器IP
#        sed -i 's/\r$//' ~/server-setup.sh
#        sudo bash ~/server-setup.sh 你的域名 你的邮箱
#
# 示例：
#   sudo bash ~/server-setup.sh guanzhanji.cn admin@example.com
#
# 脚本会依次完成：
#   安装 Nginx → 解压站点 → 写配置 → 启动 → 本地自检 → 申请免费 HTTPS 证书
# 可在备案未通过时先跑（HTTPS 会失败，属正常，备案通过后重跑即可）
# =============================================================================
set -Eeuo pipefail

DOMAIN="${1:-}"
EMAIL="${2:-}"
# 部署包默认取「脚本所在目录」（scp 到 ~/ 后脚本与 zip 同目录），其次用户主目录；
# 也可用第 3 个参数显式指定。这样无论用 root 还是 ubuntu 用户都能直接跑。
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
if [[ -n "${3:-}" ]]; then
  ZIP="$3"
elif [[ -f "$SCRIPT_DIR/red-museum-nav-site.zip" ]]; then
  ZIP="$SCRIPT_DIR/red-museum-nav-site.zip"
elif [[ -f "${HOME:-/root}/red-museum-nav-site.zip" ]]; then
  ZIP="${HOME:-/root}/red-museum-nav-site.zip"
else
  ZIP="$SCRIPT_DIR/red-museum-nav-site.zip"
fi
SITE_ROOT="/var/www/red-museum-nav"
CONF="/etc/nginx/conf.d/red-museum-nav.conf"

red()  { printf '\033[31m%s\033[0m\n' "$*"; }
grn()  { printf '\033[32m%s\033[0m\n' "$*"; }
ylw()  { printf '\033[33m%s\033[0m\n' "$*"; }
step() { printf '\n\033[36m==> %s\033[0m\n' "$*"; }

on_error() {
  red "❌ 执行失败（第 $LINENO 行）：$BASH_COMMAND"
  red "   请把上面这段报错发我，或参考 deploy/上线手册.md 的排障章节"
}
trap on_error ERR

# ---------------- 前置检查 ----------------
step "检查运行环境"
[[ $EUID -eq 0 ]] || { red "请用 root 运行。腾讯云 Ubuntu 镜像请这样执行：sudo bash $0 你的域名 你的邮箱"; exit 1; }
[[ -n "$DOMAIN" ]] || { red "缺少域名参数。用法：bash $0 你的域名 你的邮箱"; exit 1; }
[[ -n "$EMAIL"  ]] || { red "缺少邮箱参数。用法：bash $0 你的域名 你的邮箱"; exit 1; }
[[ -f "$ZIP"    ]] || { red "找不到部署包：$ZIP（请先 scp 上传）"; exit 1; }

# 简单校验域名格式
[[ "$DOMAIN" =~ ^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$ ]] \
  || { red "域名格式看起来不对：$DOMAIN（不要带 https:// 或 /）"; exit 1; }

. /etc/os-release
grn "系统：$PRETTY_NAME"
grn "域名：$DOMAIN   邮箱：$EMAIL"
grn "部署包：$ZIP"

# ---------------- 安装依赖 ----------------
step "安装 Nginx / unzip / certbot"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq nginx unzip curl ca-certificates certbot python3-certbot-nginx >/dev/null
grn "依赖安装完成"
nginx -v 2>&1 | sed 's/^/   /'

# ---------------- 解压站点 ----------------
step "解压站点到 $SITE_ROOT"
mkdir -p "$SITE_ROOT"
unzip -oq "$ZIP" -d "$SITE_ROOT"
chown -R www-data:www-data "$SITE_ROOT"
[[ -f "$SITE_ROOT/index.html" ]] || { red "解压后没有 index.html，部署包可能不对"; exit 1; }
grn "站点文件数：$(find "$SITE_ROOT" -type f | wc -l)"

# ---------------- 写 Nginx 配置（先只开 HTTP）----------------
step "写入 Nginx 配置（HTTP 阶段）"
# 移除发行版自带默认站点，避免抢占 80 端口
rm -f /etc/nginx/sites-enabled/default

cat > "$CONF" <<NGINX
# 由 server-setup.sh 生成；HTTPS 段由 certbot 自动补写
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};

    root  ${SITE_ROOT};
    index index.html;
    charset utf-8;

    # 微信域名归属校验文件（MP_verify_xxxx.txt）原样返回
    location ~ "^/[A-Za-z0-9_\-]+\.txt\$" {
        try_files \$uri =404;
        default_type "text/plain; charset=utf-8";
        add_header Cache-Control "no-cache, no-store, must-revalidate";
    }

    # 预览图长缓存
    location /images/ {
        expires 30d;
        add_header Cache-Control "public, max-age=2592000, immutable";
        access_log off;
    }

    # 样式与脚本中缓存
    location ~* \.(css|js)\$ {
        expires 7d;
        add_header Cache-Control "public, max-age=604800";
        access_log off;
    }

    # HTML 不缓存，方便更新即时生效
    location ~* \.html\$ {
        add_header Cache-Control "no-cache, must-revalidate";
    }

    # 纯静态站无前端路由：找不到就真 404，才会命中自定义 404.html
    location / {
        try_files \$uri \$uri/ =404;
    }

    error_page 404 /404.html;
    location = /404.html { internal; }

    gzip on;
    gzip_vary on;
    gzip_comp_level 6;
    gzip_min_length 1024;
    gzip_types
        text/plain
        text/css
        text/xml
        application/javascript
        application/json
        application/xml
        image/svg+xml;

    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
}
NGINX

nginx -t
systemctl enable nginx >/dev/null 2>&1 || true
systemctl reload nginx
grn "Nginx 已启动"

# ---------------- 本地自检 ----------------
step "本地自检"
CODE=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/)
echo "   首页 HTTP 状态：$CODE（期望 200）"
curl -s http://127.0.0.1/ | grep -q "我的观展笔记" && grn "   首页内容正确" || ylw "   未在首页找到预期标题，请检查部署包"
GCODE=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/go.html)
echo "   跳转页 go.html：$GCODE"

# ---------------- 申请 HTTPS 证书 ----------------
step "申请免费 HTTPS 证书（Let's Encrypt）"
if certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect; then
  grn "✅ HTTPS 证书已就绪"
  curl -s -o /dev/null -w "   HTTPS 状态：%{http_code}\n" "https://${DOMAIN}/" || true
else
  ylw "⚠️  证书申请失败。常见原因："
  ylw "   1. 域名还没解析到本机（去域名控制台加 A 记录）"
  ylw "   2. ICP 备案还没通过（内地服务器会阻断 80/443 验证）"
  ylw "   3. 安全组/防火墙没放行 80、443"
  ylw "   修好之后重跑这一条即可："
  ylw "   certbot --nginx -d ${DOMAIN} --redirect"
fi

# ---------------- 结束 ----------------
cat <<SUMMARY

============================================================
 部署完成
============================================================
 站点目录：${SITE_ROOT}
 Nginx 配置：${CONF}
 访问地址：https://${DOMAIN}/

 接下来：
 1) 域名解析：@ 和 www 各加一条 A 记录指向本机公网 IP
 2) 备案通过后，重新执行一次证书申请（如果上面失败了）：
      certbot --nginx -d ${DOMAIN} --redirect
 3) 公众号后台 → 功能设置 → 业务域名 → 填 ${DOMAIN}
    把 MP_verify_xxxx.txt 放到 ${SITE_ROOT}/ 根目录后自测：
      cd ${SITE_ROOT}
      printf '%s' '校验码' > MP_verify_xxxx.txt
      curl https://${DOMAIN}/MP_verify_xxxx.txt
 4) 公众号菜单 → 跳转网页 → https://${DOMAIN}/

 更新站点：重新上传 zip 后执行
      cd ${SITE_ROOT} && unzip -o ${ZIP} && chown -R www-data:www-data ${SITE_ROOT}
============================================================
SUMMARY
