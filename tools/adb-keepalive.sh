#!/usr/bin/env bash
# ============================================================
# adb server 保活(后台常驻任务)
#
# 为什么需要:沙盒每条 bash 命令结束后会回收该命令派生的进程,
#   adb server 随之被杀 → 下一条命令 `adb devices` 冷启动、
#   设备瞬时 offline、input 事件被丢弃("点了没反应")。
#   本脚本作为后台任务长期运行,持续把 server 拉起并把 offline 设备拉回,
#   使前台命令拿到的是**热的** server。
#
# 启动: 用后台任务方式运行
#   bash tools/adb-keepalive.sh            # 前台调试用(会一直循环)
#   实际使用由 tools/tv.sh 或会话里的后台任务托管
#
# 日志:  build/adb-keepalive.log
# ============================================================
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="$ROOT/build/adb-keepalive.log"
mkdir -p "$ROOT/build"

pick_adb() {
  if [ -n "${TV_ADB:-}" ] && [ -x "$TV_ADB" ]; then echo "$TV_ADB"; return; fi
  local c
  for c in \
    "/d/leidian/LDPlayer9/adb.exe" \
    "$HOME/AppData/Local/android-sdk-tmp/platform-tools/adb.exe" \
    "$LOCALAPPDATA/Android/Sdk/platform-tools/adb.exe"
  do
    [ -x "$c" ] && { echo "$c"; return; }
  done
  command -v adb 2>/dev/null && return
  echo "adb"
}
ADB="$(pick_adb)"
DEV="${TV_DEV:-emulator-5554}"
INTERVAL="${TV_KEEPALIVE_INTERVAL:-3}"

log() { echo "[$(date '+%H:%M:%S')] $*" >>"$LOG"; }

log "keepalive start: adb=$ADB dev=$DEV interval=${INTERVAL}s"

# 首次把 server 拉起来(冷启动时设备常为 offline,给 reconnect 一点时间)
"$ADB" start-server >/dev/null 2>&1
"$ADB" connect 127.0.0.1:5555 >/dev/null 2>&1

last_state=""
while true; do
  # server 不在了就立刻拉起(正常情况下这一步是秒返回的 no-op)
  if ! "$ADB" start-server >/dev/null 2>&1; then
    log "start-server 失败,5s 后重试"
    sleep 5
    continue
  fi

  st="$("$ADB" -s "$DEV" get-state 2>/dev/null | tr -d '\r')"
  if [ "$st" != "device" ]; then
    "$ADB" reconnect offline >/dev/null 2>&1
    "$ADB" connect 127.0.0.1:5555 >/dev/null 2>&1
  fi

  if [ "$st" != "$last_state" ]; then
    log "device=$DEV state=${st:-none}"
    last_state="$st"
  fi

  sleep "$INTERVAL"
done
