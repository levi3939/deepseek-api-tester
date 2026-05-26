#!/bin/bash

cd "$(dirname "$0")" || exit 1

HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-3000}"
URL="http://${HOST}:${PORT}"
export NO_PROXY="localhost,127.0.0.1,::1,api.deepseek.com,${NO_PROXY}"
export no_proxy="${NO_PROXY}"

pause_before_exit() {
  echo
  read -n 1 -s -r -p "按任意键关闭窗口..."
  echo
}

if ! command -v node >/dev/null 2>&1; then
  echo "未检测到 Node.js，请先安装 Node.js 后再运行。"
  echo "下载地址：https://nodejs.org/"
  pause_before_exit
  exit 1
fi

if lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "服务已经在运行，已为你打开浏览器：${URL}"
  open "${URL}"
  exit 0
fi

echo "正在启动 DeepSeek API 测试工具..."
(sleep 2; open "${URL}") &
node "deepseek-api-tester.js"

echo
echo "服务已停止。"
pause_before_exit
