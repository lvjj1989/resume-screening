#!/usr/bin/env bash
# 小熊简历筛选 — 默认后台: nohup uvicorn main:app --host 0.0.0.0 --port 8123 &
#
# 用法:
#   ./start.sh              默认后台（先释放端口再 nohup uvicorn，日志 backend/uvicorn.log）
#   ./start.sh -f           前台运行，带 --reload（开发）
#   ./start.sh --foreground
#   PORT=9000 ./start.sh
# 环境变量: HOST（默认 0.0.0.0）, PORT（默认 8123）, RELOAD 仅前台有效（0/1，默认 1）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT/backend"

HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-8123}"
RELOAD="${RELOAD:-1}"
FOREGROUND=0

for arg in "$@"; do
  case "$arg" in
    -f | --foreground)
      FOREGROUND=1
      ;;
    -b | --background | -d)
      ;; # 默认已是后台，可省略
    -h | --help)
      cat <<'EOF'
用法:
  ./start.sh              后台: nohup uvicorn main:app --host 0.0.0.0 --port 8123 &
  ./start.sh -f           前台 + --reload（开发）
  PORT=9000 ./start.sh    指定端口
环境变量: HOST, PORT；前台时可 RELOAD=0 关闭热重载
EOF
      exit 0
      ;;
    *)
      echo "未知参数: $arg（-f 前台，-h 帮助）" >&2
      exit 1
      ;;
  esac
done

pids_on_port() {
  lsof -t -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null \
    || lsof -ti:"$PORT" 2>/dev/null \
    || true
}

stop_port() {
  local pids
  pids="$(pids_on_port | sort -u)"
  if [[ -z "${pids//[$'\n\r\t ']/}" ]]; then
    echo "端口 ${PORT} 无监听进程，直接启动。"
    return 0
  fi
  echo "停止占用端口 ${PORT} 的进程…"
  while read -r pid; do
    [[ -n "${pid// }" ]] || continue
    kill "$pid" 2>/dev/null || true
  done <<< "$pids"
  sleep 0.5
  pids="$(pids_on_port | sort -u)"
  if [[ -n "${pids//[$'\n\r\t ']/}" ]]; then
    echo "仍占用端口，执行 kill -9…"
    while read -r pid; do
      [[ -n "${pid// }" ]] || continue
      kill -9 "$pid" 2>/dev/null || true
    done <<< "$pids"
    sleep 0.2
  fi
}

if ! command -v lsof >/dev/null 2>&1; then
  echo "警告: 未安装 lsof，无法按端口停止旧进程。" >&2
else
  stop_port
fi

if [[ -x .venv/bin/uvicorn ]]; then
  UVICORN=".venv/bin/uvicorn"
elif command -v uvicorn >/dev/null 2>&1; then
  UVICORN="uvicorn"
else
  echo "未找到 uvicorn。请执行: cd backend && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt" >&2
  exit 1
fi

LOG="$ROOT/backend/uvicorn.log"
PIDFILE="$ROOT/backend/.uvicorn.pid"

if [[ "$FOREGROUND" == "1" ]]; then
  echo "前台: $UVICORN main:app --host $HOST --port $PORT $([[ "$RELOAD" == "1" ]] && echo --reload)"
  echo "访问: http://127.0.0.1:${PORT}/jianli/"
  if [[ "$RELOAD" == "1" ]]; then
    exec "$UVICORN" main:app --host "$HOST" --port "$PORT" --reload
  else
    exec "$UVICORN" main:app --host "$HOST" --port "$PORT"
  fi
fi

echo "启动: nohup $UVICORN main:app --host $HOST --port $PORT &"
touch "$LOG"
nohup "$UVICORN" main:app --host "$HOST" --port "$PORT" >>"$LOG" 2>&1 &
echo $! >"$PIDFILE"
echo "已在后台运行，PID $(cat "$PIDFILE")"
echo "日志: $LOG"
echo "访问: http://127.0.0.1:${PORT}/jianli/"
