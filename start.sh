#!/usr/bin/env bash
# 小熊简历筛选 — 重启并启动 FastAPI（python -m uvicorn）
#
# 用法:
#   ./start.sh                  前台运行（默认端口 8123，带 --reload）
#   ./start.sh -b               后台运行，日志写入 backend/uvicorn.log
#   ./start.sh --background
#   BACKGROUND=1 ./start.sh
#   PORT=9000 ./start.sh -b
# 环境变量: HOST, PORT, BACKGROUND, RELOAD(0/1 关闭/开启热重载，默认 1)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT/backend"

HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-8123}"
BACKGROUND="${BACKGROUND:-0}"
RELOAD="${RELOAD:-1}"

for arg in "$@"; do
  case "$arg" in
    -b | --background | -d)
      BACKGROUND=1
      ;;
    -h | --help)
      cat <<'EOF'
用法:
  ./start.sh                  前台运行（默认端口 8123，python -m uvicorn --reload）
  ./start.sh -b               后台运行，日志 backend/uvicorn.log
  ./start.sh --background
  BACKGROUND=1 ./start.sh
  PORT=9000 ./start.sh -b
环境变量: HOST, PORT, BACKGROUND, RELOAD(0 关闭热重载)
EOF
      exit 0
      ;;
    *)
      echo "未知参数: $arg（支持 -b / --background 后台运行，-h 帮助）" >&2
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
  echo "警告: 未安装 lsof，无法按端口停止旧进程；若启动失败请手动结束占用 ${PORT} 的程序。" >&2
else
  stop_port
fi

if [[ -x .venv/bin/python ]]; then
  PY=".venv/bin/python"
elif command -v python3 >/dev/null 2>&1; then
  PY="python3"
else
  echo "未找到 python3。请先执行: python3 -m venv .venv && .venv/bin/pip install -r requirements.txt" >&2
  exit 1
fi

if ! "$PY" -c "import uvicorn" 2>/dev/null; then
  echo "当前 Python 未安装 uvicorn。请执行: pip install -r requirements.txt" >&2
  exit 1
fi

RELOAD_ARGS=()
if [[ "$RELOAD" == "1" ]]; then
  RELOAD_ARGS=(--reload)
fi

LOG="$ROOT/backend/uvicorn.log"
PIDFILE="$ROOT/backend/.uvicorn.pid"

if [[ "$RELOAD" == "1" ]]; then
  echo "启动: $PY -m uvicorn main:app --host $HOST --port $PORT --reload"
else
  echo "启动: $PY -m uvicorn main:app --host $HOST --port $PORT"
fi

if [[ "$BACKGROUND" == "1" ]]; then
  touch "$LOG"
  nohup "$PY" -m uvicorn main:app --host "$HOST" --port "$PORT" "${RELOAD_ARGS[@]}" >>"$LOG" 2>&1 &
  echo $! >"$PIDFILE"
  echo "已在后台运行 uvicorn，PID $(cat "$PIDFILE")"
  echo "日志: $LOG"
  echo "访问: http://127.0.0.1:${PORT}"
else
  echo "前台运行: http://127.0.0.1:${PORT}"
  exec "$PY" -m uvicorn main:app --host "$HOST" --port "$PORT" "${RELOAD_ARGS[@]}"
fi
