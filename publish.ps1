param(
    [string]$Message = "",
    [switch]$Check,
    [switch]$Help
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

$SiteUrl = 'https://M-ma0.github.io/red-museum-nav/'
$RepoUrl = 'https://github.com/M-ma0/red-museum-nav'

function Fail($text) {
    Write-Host ""
    Write-Host $text -ForegroundColor Red
    Write-Host ""
    exit 1
}

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "   我的观展笔记 - 一键发布到 GitHub Pages" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""

if ($Help) {
    Write-Host "用法："
    Write-Host "  双击 发布.bat                    正常发布（会问一句提交说明）"
    Write-Host "  发布.bat -Check                  只看改了什么，不提交不推送"
    Write-Host "  发布.bat -Message 改了什么        指定提交说明，不询问"
    Write-Host ""
    Write-Host "仓库：$RepoUrl"
    Write-Host "线上：$SiteUrl"
    exit 0
}

if (-not (Test-Path -LiteralPath '.git')) {
    Fail "  [X] 当前目录不是 git 仓库：$PWD"
}

$branch = (& git rev-parse --abbrev-ref HEAD).Trim()
Write-Host "仓库目录：$PWD"
Write-Host "当前分支：$branch"
Write-Host ""

Write-Host "[1/3] 检查改动 ..." -ForegroundColor Yellow
& git add -A
$status = & git status --short
if ($status) { $status | ForEach-Object { Write-Host "      $_" } }
else { Write-Host "      （工作区干净）" }
Write-Host ""

if ($Check) {
    Write-Host "[仅检查模式] 已暂存改动，但未提交、未推送。" -ForegroundColor Cyan
    exit 0
}

& git diff --cached --quiet
if ($LASTEXITCODE -eq 0) {
    Write-Host "[2/3] 没有新改动，跳过提交。" -ForegroundColor Yellow
} else {
    if (-not $Message) {
        $Message = Read-Host "提交说明（直接回车用默认）"
    }
    if (-not $Message) { $Message = '更新站点' }

    Write-Host "[2/3] 提交：$Message" -ForegroundColor Yellow
    & git commit -m $Message | ForEach-Object { Write-Host "      $_" }
    if ($LASTEXITCODE -ne 0) { Fail "  [X] 提交失败，请把上面的报错贴给我。" }
}

Write-Host ""
Write-Host "[3/3] 推送到 origin $branch ..." -ForegroundColor Yellow
& git push origin $branch 2>&1 | ForEach-Object { Write-Host "      $_" }

if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "  [X] 推送失败。常见原因：" -ForegroundColor Red
    Write-Host "      1) 凭据过期：会弹 GitHub 登录窗口，按提示授权即可" -ForegroundColor Red
    Write-Host "      2) 网络不通：再试一次，或开代理后重试" -ForegroundColor Red
    Write-Host "      3) 远端有新提交：先运行 git pull --rebase 再重跑本脚本" -ForegroundColor Red
    Write-Host ""
    exit 1
}

Write-Host ""
Write-Host "==========================================" -ForegroundColor Green
Write-Host "  OK  推送成功，GitHub 正在自动部署" -ForegroundColor Green
Write-Host "  约 1 分钟后生效：" -ForegroundColor Green
Write-Host "  $SiteUrl" -ForegroundColor Green
Write-Host "  进度看仓库页 Actions 标签，绿灯即上线" -ForegroundColor Green
Write-Host "  看不到变化请按 Ctrl+F5 强制刷新" -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Green
exit 0
