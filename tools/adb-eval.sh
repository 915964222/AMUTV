#!/bin/bash
# 单条命令内完成:adb server 启动 → 等设备 → 取 WebView socket → forward → 通过 CDP 执行 JS
# 背景:沙箱内每条命令是独立环境,adb server/forward 不跨命令存活,所以必须一次做完。
# 用法:bash tools/adb-eval.sh '<js 表达式>'
ADB=/d/leidian/LDPlayer9/adb.exe
DEV=emulator-5554
cd "$(dirname "$0")/.." || exit 1

if [ "$1" = "--file" ]; then CDP_CMD=evalfile; CDP_ARG="$2"; else CDP_CMD=eval; CDP_ARG="$1"; fi

$ADB connect 127.0.0.1:5555 >/dev/null 2>&1
for i in $(seq 1 20); do
  st=$($ADB -s $DEV get-state 2>/dev/null | tr -d '\r\n')
  [ "$st" = "device" ] && break
  sleep 1
done
if [ "$st" != "device" ]; then echo "DEVICE_OFFLINE state=$st"; exit 2; fi

SOCK=$($ADB -s $DEV shell cat /proc/net/unix 2>/dev/null | grep -o 'webview_devtools_remote_[0-9]*' | head -1 | tr -d '\r\n')
if [ -z "$SOCK" ]; then echo "NO_WEBVIEW_SOCKET"; exit 3; fi

$ADB -s $DEV forward --remove tcp:19222 >/dev/null 2>&1
$ADB -s $DEV forward tcp:19222 "localabstract:$SOCK" >/dev/null 2>&1
$ADB -s $DEV reverse tcp:8080 tcp:3065 >/dev/null 2>&1
sleep 1

NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost node .tmp/cdp.mjs "${CDP_CMD:-eval}" "${CDP_ARG:-$1}"
