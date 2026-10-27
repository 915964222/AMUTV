#!/usr/bin/env bash
# ============================================================
# 电视端 adb 稳定封装(Windows / Git Bash)
#
# 背景:本项目在沙盒里跑,每条 bash 命令结束后 adb server 进程会被回收,
#       下一条命令 `adb devices` 必然 "daemon not running; starting now",
#       此时设备状态是 offline,此时 input/tap 事件会被静默丢弃
#       (表现为"点了没反应",极易误判成 UI bug)。
#
# 用法: tools/tv.sh <命令> [参数...]
#   ready                     等待设备就绪(自动起 server / reconnect)
#   status                    打印 server 与设备状态
#   dev                       打印当前设备序列号
#   shot <name>               截图并拉取到 build/<name>.png
#   find <text|#resource-id>  在 UI 树里找元素,输出中心坐标(不点)
#   tapfind <text|#id>        找到元素并点它的中心(最可靠,不用猜坐标)
#   tap <x> <y>               点击(设备真实坐标, 2560x1440)
#   key <KEYCODE> [次数]      按键(如 KEYCODE_DPAD_DOWN 3)
#   swipe <x1> <y1> <x2> <y2> [ms]
#   start                     拉起应用
#   restart                   force-stop 后重新拉起
#   install <apk>             覆盖安装(默认 amutv.apk)
#   sh  <shell 命令...>       在设备上执行 shell
#   raw <adb 参数...>         直通 adb(自动补 -s DEV)
#
# 环境变量:
#   TV_DEV   指定设备(默认 emulator-5554, 不可用时回落到第一个 device)
#   TV_ADB   指定 adb 路径(默认自动探测雷电 / platform-tools / PATH)
#   TV_WAIT  等待设备就绪的超时秒数(默认 30)
# ============================================================
set -u
# Git Bash 会把 /sdcard/xxx 这类设备路径错误转换成 C:/Program Files/Git/sdcard/xxx,
# 导致 screencap/pull 静默失败 —— 这里统一关掉路径转换
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD="$ROOT/build"
# adb.exe 是原生 Windows 程序,不认 /c/... 形式的 MSYS 路径,传参前必须转成 C:\...
winpath() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else echo "$1"; fi; }
PKG="tv.yingshi.app"
ACTIVITY="$PKG/.MainActivity"
WAIT="${TV_WAIT:-30}"

# ---------- 定位 adb ----------
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
  echo "adb" # 最后兜底,报错更直白
}
ADB="$(pick_adb)"

# ---------- 设备探测 ----------
list_devs() { "$ADB" devices 2>/dev/null | awk 'NR>1 && NF>=2 {print $1"\t"$2}'; }

pick_dev() {
  if [ -n "${TV_DEV:-}" ]; then echo "$TV_DEV"; return; fi
  local d
  # 优先 emulator-5554(雷电默认),其次任意 device 态
  d="$(list_devs | awk -F'\t' '$1=="emulator-5554"{print $1}')"
  [ -n "$d" ] && { echo "$d"; return; }
  d="$(list_devs | awk -F'\t' '$2=="device"{print $1; exit}')"
  [ -n "$d" ] && { echo "$d"; return; }
  d="$(list_devs | awk -F'\t' 'NR==1{print $1}')"
  echo "${d:-emulator-5554}"
}
DEV="$(pick_dev)"

# 确保 server 在跑 + 唤醒离线设备(冷启动 server 时设备常见 offline)
ensure_ready() {
  "$ADB" start-server >/dev/null 2>&1
  local i=0 st
  while [ "$i" -lt "$WAIT" ]; do
    st="$("$ADB" -s "$DEV" get-state 2>/dev/null | tr -d '\r')"
    if [ "$st" = "device" ]; then return 0; fi
    if [ "$st" = "offline" ] || [ -z "$st" ]; then
      # 冷 server 刚起来时设备还在握手:reconnect 能把 offline 拉回 device
      "$ADB" reconnect offline >/dev/null 2>&1
      # 雷电除了 emulator-5554 还监听 127.0.0.1:5555,补一次连接
      case "$DEV" in
        emulator-*) "$ADB" connect 127.0.0.1:5555 >/dev/null 2>&1 ;;
      esac
    fi
    sleep 1; i=$((i + 1))
  done
  echo "[tv] 设备 $DEV 在 ${WAIT}s 内未就绪(当前: ${st:-无})" >&2
  echo "[tv] 提示: 模拟器没开就跑 /d/leidian/LDPlayer9/dnplayer.exe index=0" >&2
  return 1
}

a() { "$ADB" -s "$DEV" "$@"; }

# ---------- 子命令 ----------
cmd="${1:-ready}"; shift 2>/dev/null || true

case "$cmd" in
  ready)
    ensure_ready || exit 1
    echo "[tv] ready: $DEV ($("$ADB" -s "$DEV" shell getprop ro.build.version.release 2>/dev/null | tr -d '\r'))"
    ;;

  status)
    echo "adb    : $ADB"
    echo "device : $DEV"
    "$ADB" devices
    ;;

  dev) echo "$DEV" ;;

  shot)
    name="${1:-shot}"
    ensure_ready || exit 1
    mkdir -p "$BUILD"
    local_out="$(winpath "$BUILD/$name.png")"
    a shell screencap -p "/sdcard/$name.png"
    a pull "/sdcard/$name.png" "$local_out" >/dev/null || {
      echo "[tv] 截图失败: $local_out" >&2; exit 1; }
    echo "$BUILD/$name.png"
    ;;

  find)
    # 在 UI 树里定位元素,输出: <cx> <cy> <bounds> <text> | <resource-id>
    # 用途:截图里目测坐标经常差几十上百像素(缩略图缩放),猜坐标会点空/点到隔壁按钮。
    ensure_ready || exit 1
    mkdir -p "$BUILD"
    a shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1
    a pull /sdcard/ui.xml "$(winpath "$BUILD/ui.xml")" >/dev/null 2>&1 || {
      echo "[tv] dump 失败" >&2; exit 1; }
    "${TV_PY:-python}" - "$(winpath "$BUILD/ui.xml")" "${1:-}" <<'PY'
import re, sys
xml = open(sys.argv[1], encoding='utf-8', errors='replace').read()
key = sys.argv[2]
found = 0
for m in re.finditer(r'<node\b[^>]*>', xml):
    seg = m.group(0)
    rid = re.search(r'resource-id="([^"]*)"', seg)
    txt = re.search(r'text="([^"]*)"', seg)
    bd = re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', seg)
    if not bd:
        continue
    t = txt.group(1) if txt else ''
    r = rid.group(1) if rid else ''
    hit = (r == key[1:]) if key.startswith('#') else (key and key in t)
    if not hit:
        continue
    x1, y1, x2, y2 = map(int, bd.groups())
    print(f"{(x1 + x2) // 2} {(y1 + y2) // 2} [{x1},{y1}][{x2},{y2}] {t} | {r}")
    found += 1
    if found >= 8:
        break
if not found:
    sys.exit(3)
PY
    ;;

  tapfind)
    ensure_ready || exit 1
    mkdir -p "$BUILD"
    a shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1
    a pull /sdcard/ui.xml "$(winpath "$BUILD/ui.xml")" >/dev/null 2>&1 || {
      echo "[tv] dump 失败" >&2; exit 1; }
    pos="$("${TV_PY:-python}" - "$(winpath "$BUILD/ui.xml")" "${1:-}" <<'PY'
import re, sys
xml = open(sys.argv[1], encoding='utf-8', errors='replace').read()
key = sys.argv[2]
for m in re.finditer(r'<node\b[^>]*>', xml):
    seg = m.group(0)
    rid = re.search(r'resource-id="([^"]*)"', seg)
    txt = re.search(r'text="([^"]*)"', seg)
    bd = re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', seg)
    if not bd:
        continue
    t = txt.group(1) if txt else ''
    r = rid.group(1) if rid else ''
    hit = (r == key[1:]) if key.startswith('#') else (key and key in t)
    if hit:
        x1, y1, x2, y2 = map(int, bd.groups())
        print(f"{(x1 + x2) // 2} {(y1 + y2) // 2}")
        break
PY
)"
    if [ -z "$pos" ]; then echo "[tv] 没找到元素: $1" >&2; exit 3; fi
    echo "[tv] tapfind '$1' → $pos"
    a shell input tap $pos
    ;;

  tap)
    ensure_ready || exit 1
    a shell input tap "$1" "$2"
    ;;

  key)
    ensure_ready || exit 1
    n="${2:-1}"
    for _ in $(seq 1 "$n"); do a shell input keyevent "$1"; sleep 0.3; done
    ;;

  swipe)
    ensure_ready || exit 1
    a shell input swipe "$1" "$2" "$3" "$4" "${5:-400}"
    ;;

  start)
    ensure_ready || exit 1
    a shell am start -n "$ACTIVITY" >/dev/null 2>&1
    ;;

  restart)
    ensure_ready || exit 1
    a shell am force-stop "$PKG"
    sleep 1.5
    a shell am start -W -n "$ACTIVITY" 2>&1 | grep -E "TotalTime|Error" || true
    ;;

  install)
    apk="${1:-$ROOT/amutv.apk}"
    ensure_ready || exit 1
    "$ADB" -s "$DEV" install -r "$(winpath "$apk")"
    ;;

  sh)
    ensure_ready || exit 1
    a shell "$@"
    ;;

  raw)
    ensure_ready || exit 1
    a "$@"
    ;;

  *)
    echo "未知命令: $cmd" >&2
    sed -n '2,30p' "${BASH_SOURCE[0]}" >&2
    exit 2
    ;;
esac
