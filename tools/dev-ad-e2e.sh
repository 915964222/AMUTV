#!/bin/bash
# 设备端广告过滤 E2E:播放指定 m3u8 → 收集 toast → 读播放器状态 → 截图
# 沙箱内 adb server / forward / reverse 不跨命令存活,所以整条链路必须一次做完。
# 用法: bash tools/dev-ad-e2e.sh "http://localhost:8080/media/test-file.m3u8" [等待秒数]
ADB=/d/leidian/LDPlayer9/adb.exe
DEV=emulator-5554
URL="$1"
WAIT="${2:-5}"
cd "$(dirname "$0")/.." || exit 1

$ADB connect 127.0.0.1:5555 >/dev/null 2>&1
for i in $(seq 1 20); do
  st=$($ADB -s $DEV get-state 2>/dev/null | tr -d '\r\n')
  [ "$st" = "device" ] && break
  sleep 1
done
if [ "$st" != "device" ]; then echo "DEVICE_OFFLINE state=$st"; exit 2; fi

SOCK=$($ADB -s $DEV shell cat /proc/net/unix 2>/dev/null | grep -o 'webview_devtools_remote_[0-9]*' | head -1 | tr -d '\r\n')
[ -z "$SOCK" ] && { echo "NO_WEBVIEW_SOCKET"; exit 3; }

$ADB -s $DEV forward --remove tcp:19222 >/dev/null 2>&1
$ADB -s $DEV forward tcp:19222 "localabstract:$SOCK" >/dev/null 2>&1
$ADB -s $DEV reverse tcp:8080 tcp:3065 >/dev/null 2>&1
sleep 1

export NO_PROXY=127.0.0.1,localhost
export no_proxy=127.0.0.1,localhost

echo "--- 1. 安装 toast 记录器 ---"
node .tmp/cdp.mjs evalfile .tmp/e2e-hook.js
echo "--- 1.5 退出当前播放(确保干净起播) ---"
node .tmp/cdp.mjs eval "var n=0; for(var i=0;i<3;i++){ try{ if(window.__onBack && window.__onBack()) n++; }catch(e){} } 'back x'+n"
sleep 1
echo "--- 2. 起播 $URL ---"
node .tmp/cdp.mjs eval "window.__toasts=[]; window.__onLocalFile('$URL'), 'called'"
echo "--- 3. 等待 ${WAIT}s ---"
sleep "$WAIT"
echo "--- 4. 读取结果 ---"
node .tmp/cdp.mjs evalfile .tmp/e2e-read.js
echo "--- 5. 截图 ---"
$ADB -s $DEV exec-out screencap -p > .tmp/e2e.png 2>/dev/null
ls -l .tmp/e2e.png | awk '{print "screenshot:", $5, "bytes"}'
