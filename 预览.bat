@echo off
chcp 65001 > nul
setlocal
cd /d "%~dp0"

echo ============================================================
echo   红色博物馆 . 云上观展导航   本地预览
echo ============================================================
echo.
echo   直接双击 index.html 也能打开（数据已内联，无需服务器）。
echo   本地起服务的好处：会读取 data/entries.json 的最新内容，
echo   表现与部署到公众号后完全一致。
echo.

set PORT=8765
set NODE=

rem 1) 项目自带的 node（随截图工具一起提供）
if exist "node_modules\.bin\node.exe" set NODE=node_modules\.bin\node.exe
if not defined NODE if exist "..\..\..\DeepseekHarness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe" set NODE=..\..\..\DeepseekHarness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe
rem 2) 系统 PATH 里的 node
if not defined NODE ( where node >nul 2>nul && set NODE=node )

if not defined NODE (
  echo   [!] 未找到 Node.js，改用 Python 启动...
  set PY=
  where python >nul 2>nul && set PY=python
  if not defined PY ( where py >nul 2>nul && set PY=py )
  if defined PY (
    echo   服务地址: http://127.0.0.1:%PORT%/index.html
    start "" "http://127.0.0.1:%PORT%/index.html"
    %PY% -m http.server %PORT% --bind 127.0.0.1
    goto :eof
  )
  echo   [!] 也没有找到 Python，请直接双击 index.html 预览。
  echo.
  pause
  exit /b 1
)

echo   服务地址: http://127.0.0.1:%PORT%/index.html
echo   按 Ctrl+C 结束服务。
echo.
start "" "http://127.0.0.1:%PORT%/index.html"
"%NODE%" "tools\serve.mjs" %PORT%
