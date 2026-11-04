# 打包站点：生成符合 ZIP 规范（正斜杠路径）的部署包
# 用法：powershell -ExecutionPolicy Bypass -File deploy\打包.ps1
#
# 注意：不能用 Compress-Archive —— 它写入的条目路径是反斜杠，
# Linux 的 unzip 会把它当文件名的一部分，解压后目录层级错乱。
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$root  = Split-Path -Parent $PSScriptRoot
$out   = Join-Path $PSScriptRoot 'red-museum-nav-site.zip'
$stage = Join-Path $env:TEMP ('navstage_' + [guid]::NewGuid().ToString('N'))

Write-Host "项目根目录: $root"
Write-Host "临时目录  : $stage"

New-Item -ItemType Directory -Force -Path $stage | Out-Null

# 只复制运行时需要的文件（不含 tools / node_modules / _build / .git）
$items = @('index.html', 'go.html', 'assets', 'data', 'images')
foreach ($i in $items) {
    $src = Join-Path $root $i
    if (-not (Test-Path $src)) { throw "缺少必需文件/目录: $i" }
    Copy-Item $src -Destination $stage -Recurse -Force
    Write-Host "  + $i"
}

$p404 = Join-Path $PSScriptRoot 'site\404.html'
if (Test-Path $p404) {
    Copy-Item $p404 -Destination (Join-Path $stage '404.html') -Force
    Write-Host "  + 404.html"
}

if (Test-Path $out) { Remove-Item $out -Force }

$zip = [System.IO.Compression.ZipFile]::Open($out, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    # 用规范化后的绝对路径做前缀，避免短路径(GUAI_L~1)与长路径长度不一致导致条目带前导 /
    $stageFull = [System.IO.Path]::GetFullPath($stage)
    $files = Get-ChildItem $stage -Recurse -File
    foreach ($f in $files) {
        $rel = $f.FullName.Substring($stageFull.Length).TrimStart('\', '/').Replace('\', '/')
        $entry = $zip.CreateEntry($rel, [System.IO.Compression.CompressionLevel]::Optimal)
        $es = $entry.Open()
        $fs = [System.IO.File]::OpenRead($f.FullName)
        try { $fs.CopyTo($es) } finally { $fs.Dispose(); $es.Dispose() }
    }
} finally {
    $zip.Dispose()
}

Remove-Item $stage -Recurse -Force

$sizeKB = (Get-Item $out).Length / 1KB
Write-Host ""
Write-Host ("打包完成: {0}" -f $out)
Write-Host ("体积: {0:N1} KB" -f $sizeKB)
Write-Host ""
Write-Host "上传到服务器："
Write-Host "  pscp -pw <密码> deploy\red-museum-nav-site.zip ubuntu@<服务器IP>:/home/ubuntu/"
Write-Host "然后执行："
Write-Host "  sudo bash /home/ubuntu/server-setup.sh <域名或IP> <邮箱> /home/ubuntu/red-museum-nav-site.zip"
