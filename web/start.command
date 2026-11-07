#!/bin/bash
# Neon Skyway launcher: serve this folder locally, then open the game.
set -e
cd "$(dirname "$0")"

PORT=8123
URL="http://127.0.0.1:${PORT}/"

if ! command -v python3 >/dev/null 2>&1; then
  echo "找不到 python3。请直接双击 index.html，或在终端里用任意静态服务器打开本目录。"
  read -r -p "按回车退出…"
  exit 1
fi

if curl -s --max-time 0.5 -o /dev/null "$URL"; then
  open "$URL"
  exit 0
fi

nohup python3 -m http.server "$PORT" --bind 127.0.0.1 >/tmp/neon-skyway-server.log 2>&1 &
SERVER_PID=$!

for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -s --max-time 0.5 -o /dev/null "$URL"; then
    break
  fi
  sleep 0.2
done

if ! curl -s --max-time 1 -o /dev/null "$URL"; then
  echo "本地服务启动失败，请查看 /tmp/neon-skyway-server.log。"
  kill "$SERVER_PID" 2>/dev/null || true
  read -r -p "按回车退出…"
  exit 1
fi

open "$URL"
echo "霓虹轨道已启动：$URL"
echo "关闭本地服务可运行：kill $SERVER_PID"
