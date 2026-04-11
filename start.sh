#!/usr/bin/env bash
# 小熊简历筛选 — 重启 FastAPI（先释放端口再启动，API + 静态页面一体）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT/backend"

HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-8123}"

pids_on_port() {
  # macOS / 多数 Linux：仅 LISTEN 进程
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

if [[ -x .venv/bin/uvicorn ]]; then
  UVICORN=".venv/bin/uvicorn"
elif command -v uvicorn >/dev/null 2>&1; then
  UVICORN="uvicorn"
else
  echo "未找到 uvicorn。请先执行: cd backend && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt" >&2
  exit 1
fi

echo "启动服务: http://127.0.0.1:${PORT}"
exec "$UVICORN" main:app --host "$HOST" --port "$PORT" --reload
