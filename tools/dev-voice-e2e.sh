#!/bin/bash
# 语音链路设备端端到端验证:模块加载 → 面板 → 解析 → 导航/搜索/播放控制
# 用法: bash tools/dev-voice-e2e.sh [测试流地址]
# 说明: 沙箱内 adb 不跨命令存活,每次调用 adb-eval.sh 都会重建 forward。
#
# 读结果时注意:单次 adb-eval.sh 本身要约 3 秒(启 adb server + 建转发 + 连 CDP),
# 所以「快进后 currentTime」会比预期多出 5~10 秒,那是测量开销导致的自然播放,不是跳转偏差。
# 要验证跳转精度,请在同一个 eval 里取「设置前/设置后」两个值(见 docs/voice-control.md 第五节)。
cd "$(dirname "$0")/.." || exit 1
URL="${1:-http://localhost:8080/media/test-ad.m3u8}"
E() { bash tools/adb-eval.sh "$1"; }

echo "=== 1. 模块 / 面板 / 解析 ==="
bash tools/adb-eval.sh --file tools/voice-check.js

echo
echo "=== 2. 导航执行:打开设置 ==="
E "window.Voice.say('打开设置'),'sent'"
sleep 2
E "JSON.stringify({tab:(document.querySelector('.tab.active')||{}).textContent})"

echo
echo "=== 3. 搜索执行:看庆余年 ==="
E "window.Voice.say('看庆余年'),'sent'"
sleep 2.5
E "JSON.stringify({tab:(document.querySelector('.tab.active')||{}).textContent,kw:(document.getElementById('kw')||{}).value,hasResultBox:!!document.getElementById('search-result')})"

echo
echo "=== 4. 起播测试流 ==="
E "window.__onLocalFile('$URL'),'open'"
sleep 7
E "JSON.stringify({playerOpen:Player.isOpen(),state:Player.getState()})"

echo
echo "=== 5. 播放控制 ==="
E "window.Voice.say('静音'),'mute'"
sleep 1.4
E "JSON.stringify({step:'静音',muted:(document.querySelector('#player video')||document.querySelector('video')||{}).muted})"

E "window.Voice.say('1.5倍速'),'rate'"
sleep 1.4
E "JSON.stringify({step:'倍速',rate:(document.querySelector('#player video')||document.querySelector('video')||{}).playbackRate})"

E "window.Voice.say('音量调到百分之三十'),'vol'"
sleep 1.4
E "JSON.stringify({step:'音量',volume:(document.querySelector('#player video')||document.querySelector('video')||{}).volume,muted:(document.querySelector('#player video')||document.querySelector('video')||{}).muted})"

E "window.Voice.say('快进30秒'),'seek'"
sleep 1.4
E "JSON.stringify({step:'快进',t:(document.querySelector('#player video')||document.querySelector('video')||{}).currentTime})"

E "window.Voice.say('暂停'),'pause'"
sleep 1.4
E "JSON.stringify({step:'暂停',paused:(document.querySelector('#player video')||document.querySelector('video')||{}).paused})"

echo
echo "=== 6. 清理 ==="
E "(function(){try{window.Voice.close()}catch(e){};try{Player.close()}catch(e){};return 'closed'})()"
