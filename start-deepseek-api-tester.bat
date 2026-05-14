@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo 未检测到 Node.js，请先安装 Node.js 后再运行。
  echo 下载地址：https://nodejs.org/
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "if (Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue) { Start-Process 'http://localhost:3000'; exit 1 }"
if errorlevel 1 (
  echo 服务已经在运行，已为你打开浏览器：http://localhost:3000
  exit /b 0
)

echo 正在启动 DeepSeek API 测试工具...
start "" /min powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Sleep -Seconds 2; Start-Process 'http://localhost:3000'"
node "deepseek-api-tester.js"

echo.
echo 服务已停止。
pause
