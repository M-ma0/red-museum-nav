# 自己把网站放到 GitHub 托管（不用找我，省 token）

> 适用：本仓库（纯静态站点）。整个流程就一件事——**把文件推到 main 分支，GitHub 自动发布**。
> 仓库：<https://github.com/M-ma0/red-museum-nav>
> 线上：<https://M-ma0.github.io/red-museum-nav/>

---

## 一、日常更新：三选一（30 秒）

改完 `index.html` / `data/` / `images/` 后，任选一种。

### 方式 A：双击 `发布.bat`（推荐）

仓库根目录的 `发布.bat`，双击 → 输入一句说明（可直接回车）→ 等它打印"推送成功"。
约 1 分钟后线上生效。

它做的事就是 `git add -A` + `commit` + `push`，没有任何魔法。两个文件的区别：

| 文件 | 作用 |
|---|---|
| `发布.bat` | 双击用的启动器（纯 ASCII，负责找到 PowerShell 并转交） |
| `publish.ps1` | 真正的发布逻辑，中文提示都在这里 |

其它用法：

```bat
发布.bat -Check                   :: 只看改了什么，不提交不推送（先干这个最安全）
发布.bat -Message "改了标题"       :: 直接指定提交说明，不来回问
```

### 方式 B：命令行三连

```bat
cd /d "E:\工程文件\dsh\小程序\red-museum-nav"
git add -A
git commit -m "改了什么"
git push
```

### 方式 C：不想装 git，网页直接传

1. 打开仓库 → 进到要改的文件夹 → 右上 `Add file` → `Upload files`
2. 拖入文件（同名会覆盖）→ 底部 `Commit changes`
3. 等 Actions 跑完，线上就变了

> 只改一两个文件时 C 最省事；改很多文件用 A。

---

## 二、看部署状态 / 找线上地址

1. 仓库页顶部 **Actions** 标签
2. 最新一条 `Deploy static site to GitHub Pages`：
   - 黄色转圈＝部署中（通常 30–90 秒）
   - ✅ 绿勾＝已上线
   - ❌ 红叉＝点进去看红色步骤的日志
3. 线上地址固定是 **https://M-ma0.github.io/red-museum-nav/**
4. Settings → Pages 页面上也会显示 `Your site is live at ...`

**改了没变化？** 先硬刷新 `Ctrl + F5`；微信/QQ 内置浏览器缓存更顽固，加个 `?v=2` 试。

---

## 三、首次从零做一遍（只做一次，仓库已建好可跳过）

1. **建仓库**：GitHub 右上 `+` → `New repository` → 名字 `red-museum-nav` → 选 **Public** → `Create repository`
   > 私有仓库想用 Pages 要 GitHub Pro，免费号必须 Public。
2. **本地接上并推**：
   ```bat
   cd /d "E:\工程文件\dsh\小程序\red-museum-nav"
   git init
   git add -A
   git commit -m "init"
   git branch -M main
   git remote add origin https://github.com/<你的用户名>/red-museum-nav.git
   git push -u origin main
   ```
   第一次会弹浏览器让你登录 GitHub，授权后 Windows 会记住（Git Credential Manager），以后不再问。
3. **打开 Pages**：仓库 → `Settings` → 左侧 `Pages` → **Source 选 `GitHub Actions`**（不要选 "Deploy from a branch"）
   > 本仓库已带 `.github/workflows/pages.yml`，选完 Actions 会自动跑起来。
4. 等 Actions 绿灯，访问 `https://<你的用户名>.github.io/red-museum-nav/`。

---

## 四、常见坑对照表

| 现象 | 原因 | 处理 |
|---|---|---|
| 推代码被要求输密码，输 GitHub 密码报错 | GitHub 早已禁用密码推送 | 用弹出的浏览器登录授权；或建 Personal Access Token 当密码 |
| 线上 404 | Pages 的 Source 没选 `GitHub Actions` | Settings → Pages 改过来，再手动跑一次 Actions（`Run workflow`） |
| 页面能开但没样式/图片裂 | HTML 里用了 `/assets/x.css` 这种以 `/` 开头的绝对路径 | 改成相对路径 `assets/x.css` |
| Actions 红叉，报 `tar: ... No such file` | 删了 `index.html`、`assets`、`data`、`images` 中的某个 | 补齐目录或改 `pages.yml` 里的打包清单 |
| 单文件 >100 MB 推不上去 | GitHub 硬限制 | 压缩，或改用 Git LFS，或把大视频放对象存储 |
| 仓库改名后旧链接 404 | 项目页地址里带仓库名 | 同步改 README 和公众号里的链接 |
| `git push` 报 `rejected` | 远端有你本地没有的提交（比如网页上改过） | `git pull --rebase` 后再 push |

---

## 五、两个必须知道的限制

1. **github.io 不能用来配公众号菜单的「JS 安全域名」**
   微信要求域名已 ICP 备案，`github.io` 是境外主体、个人无法备案，永远过不了校验。
   要挂到公众号上，按 [`上线手册.md`](上线手册.md) 走（自有域名 + 备案 + 服务器）。
   GitHub Pages 只适合：自己看、发给朋友、做演示。

2. **走 GitHub 的静态托管是公开的**
   仓库 Public ⇒ 源码和所有文件都能被下载。别放密钥、后台密码、未公开素材。

---

## 六、想绑自己的短域名（可选）

1. 买域名 + 备案（国内访问且给公众号用就必须备案）
2. DNS 加一条 `CNAME`：`www` → `<你的用户名>.github.io`
3. 仓库 Settings → Pages → `Custom domain` 填域名 → 勾 `Enforce HTTPS`
4. 等证书签发（几分钟到一小时）

> 没备案的域名解析到 GitHub：自己能打开，但国内访问不稳定，也不能用于公众号。

---

## 七、一句话记住

**改文件 → 双击 `发布.bat` → 等 Actions 绿勾。**
出问题先看 Actions 的日志，红色步骤里第一行报错就是答案。

---

## 八、想再省一步（可选）

给仓库加一条提交后自动跑的命令？没必要。真正省事的是把这三行记住：

```
git add -A
git commit -m "改了什么"
git push
```

`发布.bat` 只是这三行的外壳。哪天真出问题，直接用这三行排错，比任何脚本都清楚。
