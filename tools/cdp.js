/* ============================================================
 * WebView CDP 执行器:在 App 内网页里跑一段 JS,把结果打出来
 *
 * 为什么需要:TV 上没有鼠标,靠 `adb input tap x y` 点网页元素经常
 *   ① 坐标要按 2560x1440 换算,截图目测必偏(几十上百像素);
 *   ② 元素在滚动区外时 uiautomator dump 里根本没有节点;
 *   ③ 事件偶发丢失,点了没反应还查不出原因。
 *   直接走 Chrome DevTools Protocol 调 DOM API 最准也最快。
 *
 * 前置(只需一次):
 *   SOCK=$(adb shell cat /proc/net/unix | grep -o 'webview_devtools_remote_[0-9]*' | head -1)
 *   adb forward tcp:9222 localabstract:$SOCK
 *   (App 内已 WebView.setWebContentsDebuggingEnabled(true))
 *
 * 用法:
 *   node tools/cdp.js "<表达式>" [超时ms]
 *   node tools/cdp.js 'document.querySelectorAll(".sec-card").length'
 *   node tools/cdp.js 'document.getElementById("wifi-scan").click(); "clicked"'
 *   node tools/cdp.js 'document.querySelector("#wifi-list").innerText' 8000
 *
 * 说明:表达式支持 await(自动 awaitPromise),返回值按 JSON 打印。
 * ============================================================ */
const http = require('http');

const PORT = process.env.CDP_PORT || 9222;

function getTargets() {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/json', timeout: 5000 }, (r) => {
      let b = '';
      r.setEncoding('utf8');
      r.on('data', (d) => { b += d; });
      r.on('end', () => {
        try { resolve(JSON.parse(b)); } catch (e) { reject(new Error('解析 /json 失败: ' + b.slice(0, 120))); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('连接 CDP 端口超时(是否忘了 adb forward tcp:9222 ?)')); });
    req.on('error', reject);
  });
}

(async () => {
  const expr = process.argv[2];
  if (!expr) {
    console.error('用法: node tools/cdp.js "<js表达式>" [超时ms]');
    process.exit(2);
  }
  const waitMs = Number(process.argv[3] || 20000);

  let targets;
  try {
    targets = await getTargets();
  } catch (e) {
    console.error('[cdp] ' + e.message);
    process.exit(1);
  }
  const page = targets.find((t) => t.type === 'page');
  if (!page) {
    console.error('[cdp] 没有可用的 page 目标(应用是否在前台?)');
    process.exit(1);
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let done = false;
  const finish = (code) => { if (done) return; done = true; try { ws.close(); } catch (e) {} process.exit(code); };

  ws.onopen = () => {
    ws.send(JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: {
        expression: expr,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,      // 关键:让 click() 有"用户手势",绕过部分限制
        allowUnsafeEvalBlockedByCSP: true,
      },
    }));
  };

  ws.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.id !== 1) return;
    const r = m.result || {};
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      console.error('[cdp] JS 异常: ' + (d.text || '') + ' ' + ((d.exception && d.exception.description) || ''));
      return finish(1);
    }
    const v = r.result ? r.result.value : undefined;
    console.log(typeof v === 'string' ? v : JSON.stringify(v));
    finish(0);
  };

  ws.onerror = (e) => { console.error('[cdp] ws 错误: ' + ((e && e.message) || e)); finish(1); };
  setTimeout(() => { console.error('[cdp] 超时 ' + waitMs + 'ms'); finish(2); }, waitMs);
})();
