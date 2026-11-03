# 打包站点：把运行时需要的文件打成 zip，用于上传到服务器
# 用法：在项目根目录执行  powershell -ExecutionPolicy Bypass -File deploy\打包.ps1
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot          # 项目根目录
$out  = Join-Path $PSScriptRoot 'red-museum-nav-site.zip'
$stage = Join-Path $env:TEMP ('navstage_' + [guid]::NewGuid().ToString('N'))

Write-Host "项目根目录: $root"
Write-Host "临时目录  : $stage"

New-Item -ItemType Directory -Force -Path $stage | Out-Null

# 只复制运行时需要的文件（不含 tools / node_modules / _build / .git / 部署脚本）
$items = @('index.html', 'go.html', 'assets', 'data', 'images')
foreach ($i in $items) {
    $src = Join-Path $root $i
    if (-not (Test-Path $src)) { throw "缺少必需文件/目录: $i" }
    Copy-Item $src -Destination $stage -Recurse -Force
    Write-Host "  + $i"
}

# 404 页（来自 deploy/site）
$p404 = Join-Path $PSScriptRoot 'site\404.html'
if (Test-Path $p404) {
    Copy-Item $p404 -Destination (Join-Path $stage '404.html') -Force
    Write-Host "  + 404.html"
}

# 打包
if (Test-Path $out) { Remove-Item $out -Force }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $out -CompressionLevel Optimal
Remove-Item $stage -Recurse -Force

$size = (Get-Item $out).Length / 1KB
$count = (Get-ChildItem $out).Count
Write-Host ""
Write-Host ("打包完成: {0}" -f $out)
Write-Host ("体积: {0:N1} KB" -f $size)
Write-Host ""
Write-Host "上传到服务器后，解压到 /var/www/red-museum-nav/ 即可："
Write-Host "  ssh root@<你的服务器IP>"
Write-Host "  mkdir -p /var/www/red-museum-nav"
Write-Host "  cd /var/www/red-museum-nav && unzip -o ~/red-museum-nav-site.zip"
Write-Host "  chown -R www-data:www-data /var/www/red-museum-nav"
