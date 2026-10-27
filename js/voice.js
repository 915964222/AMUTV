/* 影视TV · 语音助手(前端)
 *
 * 分工:
 *   识别  Android 原生 SpeechRecognizer → window.__onVoice 回传(WebView 无 Speech API,只能走原生)
 *   理解  js/voice-nlu.js(纯函数,可用 tools/voice-nlu-test.js 单测)
 *   执行  播放控制走 Player.ctrl(复用遥控协议 rcExec),搜索/导航走 AppCtl
 *
 * 没有麦克风的环境(浏览器、模拟器)自动降级到键盘输入,走同一套解析,便于验证与调试。
 */
(function () {
  'use strict';
  if (window.Voice) return;

  var mask = null;       // 面板根
  var ui = {};           // 常用节点
  var phase = 'idle';    // idle | listening | thinking | manual | error
  var timer = null;      // 监听超时
  var lastText = '';
  var recTimer = null;   // 录音硬上限(原生 VAD 正常会先收尾)
  var webRec = null;     // 浏览器 MediaRecorder 通路

  /* ================= 云端识别(ASR) =================
   * 为什么需要:android.speech.SpeechRecognizer 要求设备装了 RecognitionService。
   * 实测一台典型盒子/模拟器:hasMic=true、perm=true,但 hasRec=false、services=[] ——
   * 麦克风是好的,缺的是「把声音变成文字」的那个服务。国产电视盒子(无 GMS)基本都是这样。
   * 所以这里补一条不依赖系统的路:自己录 16k/16bit 单声道 WAV → 直接 POST 给用户自己的 ASR。
   * 这样只要有麦克风就能用,设备有没有语音服务都无所谓。
   */
  var ASR_KEY = 'vc_asr';
  var asr = loadAsr();

  function loadAsr() {
    try {
      var o = JSON.parse(localStorage.getItem(ASR_KEY) || '{}') || {};
      return {
        url: o.url || '',
        key: o.key || '',
        model: o.model || 'whisper-1',
        lang: o.lang || 'zh'
      };
    } catch (e) {
      return { url: '', key: '', model: 'whisper-1', lang: 'zh' };
    }
  }

  function saveAsr(o) {
    asr = o;
    try { localStorage.setItem(ASR_KEY, JSON.stringify(o)); } catch (e) {}
  }

  function asrReady() { return !!(asr && /^https?:\/\//i.test(asr.url)); }

  /* 录音通路:App 内用原生 AudioRecord,浏览器用 MediaRecorder */
  function recOk() { return !!(window.YSTV && typeof window.YSTV.recStart === 'function'); }
  function webRecOk() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia &&
      typeof MediaRecorder !== 'undefined' && typeof FormData !== 'undefined');
  }
  function canRec() { return recOk() || webRecOk(); }

  var PAGES = { home: '首页', set: '设置', live: '直播', fav: '收藏', hist: '历史', drive: '网盘', search: '搜索' };

  var HELP = [
    ['搜片', '看庆余年 / 我想看繁花 / 帮我搜一下狂飙'],
    ['控制', '暂停 / 继续 / 下一集 / 跳到第 5 集'],
    ['进度', '快进 30 秒 / 后退十秒 / 从头播放'],
    ['音量', '声音大一点 / 音量调到 50 / 静音'],
    ['倍速', '1.5 倍速 / 正常速度'],
    ['其它', '全屏 / 退出播放 / 首页 / 设置 / 返回']
  ];

  function nativeOk() {
    return !!(window.YSTV && typeof window.YSTV.startVoice === 'function');
  }

  /* player.js 用 const 声明 Player(全局词法作用域),不挂在 window 上,
     直接读 window.Player 拿到的是 undefined —— 必须走 typeof 判断 */
  function PL() {
    return (typeof Player !== 'undefined' && Player) ? Player : null;
  }

  /* ================= 面板 ================= */
  function build() {
    if (mask) return mask;
    mask = document.createElement('div');
    mask.className = 'modal-mask vc-mask';
    mask.innerHTML =
      '<div class="modal vc-modal">' +
        '<div class="modal-head">语音助手 <button class="x" data-f tabindex="-1">✕</button></div>' +
        '<div class="modal-body vc-body">' +
          '<div class="vc-stage">' +
            '<div class="vc-wave" id="vc-wave"><i></i><i></i><i></i><i></i><i></i></div>' +
            '<div class="vc-heard" id="vc-heard">正在聆听…</div>' +
            '<div class="vc-intent" id="vc-intent"></div>' +
          '</div>' +
          '<div class="vc-manual" id="vc-manual" style="display:none">' +
            '<input class="vc-input" id="vc-input" placeholder="输入指令后回车,例如:看庆余年 / 下一集" autocomplete="off">' +
          '</div>' +
          '<div class="vc-asr" id="vc-asr" style="display:none">' +
            '<input class="vc-input" id="vc-asr-url" placeholder="识别接口地址:https://.../v1/audio/transcriptions" autocomplete="off">' +
            '<input class="vc-input" id="vc-asr-key" placeholder="API Key(服务端不需要就留空)" autocomplete="off">' +
            '<input class="vc-input" id="vc-asr-model" placeholder="模型,默认 whisper-1" autocomplete="off">' +
            '<button class="vc-b" data-act="asr-save" data-f tabindex="-1">保存并试用</button>' +
          '</div>' +
          '<div class="vc-help" id="vc-help" style="display:none"></div>' +
          '<div class="vc-tip" id="vc-tip">说「看庆余年」「下一集」「声音大一点」</div>' +
          '<div class="vc-actions">' +
            '<button class="vc-b" data-act="retry" data-f tabindex="-1">重新说</button>' +
            '<button class="vc-b" data-act="manual" data-f tabindex="-1">键盘输入</button>' +
            '<button class="vc-b" data-act="asr" data-f tabindex="-1">识别服务</button>' +
            '<button class="vc-b" data-act="help" data-f tabindex="-1">能做什么</button>' +
            '<button class="vc-b" data-act="diag" data-f tabindex="-1">诊断</button>' +
          '</div>' +
        '</div>' +
      '</div>';

    ui.heard = mask.querySelector('#vc-heard');
    ui.intent = mask.querySelector('#vc-intent');
    ui.tip = mask.querySelector('#vc-tip');
    ui.manual = mask.querySelector('#vc-manual');
    ui.input = mask.querySelector('#vc-input');
    ui.asr = mask.querySelector('#vc-asr');
    ui.asrUrl = mask.querySelector('#vc-asr-url');
    ui.asrKey = mask.querySelector('#vc-asr-key');
    ui.asrModel = mask.querySelector('#vc-asr-model');
    ui.help = mask.querySelector('#vc-help');
    ui.wave = mask.querySelector('#vc-wave');

    ui.help.innerHTML = helpHTML();

    mask.querySelector('.x').onclick = function () { close(); };
    mask.addEventListener('click', function (e) { if (e.target === mask) close(); });

    mask.querySelector('.vc-actions').addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]');
      if (!b) return;
      var act = b.dataset.act;
      if (act === 'retry') listen();
      else if (act === 'manual') showManual();
      else if (act === 'diag') showDiag();
      else if (act === 'asr') showAsr();
      else if (act === 'asr-save') saveAsrFromUi();
      else if (act === 'help') {
        var on = ui.help.style.display === 'none';
        ui.help.style.display = on ? 'block' : 'none';
        if (on) { ui.help.className = 'vc-help'; ui.help.innerHTML = helpHTML(); }   /* 诊断可能改写过这里,恢复指令表 */
        ui.tip.textContent = on ? '说法不必逐字一致,大意对就行' : '说「看庆余年」「下一集」「声音大一点」';
      }
    });

    ui.input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        var t = ui.input.value.trim();
        if (t) { ui.input.value = ''; handleText(t); }
      }
    });

    return mask;
  }

  function helpHTML() {
    return HELP.map(function (r) {
      return '<div class="vc-hrow"><b>' + r[0] + '</b><span>' + r[1] + '</span></div>';
    }).join('');
  }

  function drow(k, v) {
    return '<div class="vc-hrow"><b>' + k + '</b><span>' + (v == null || v === '' ? '-' : v) + '</span></div>';
  }

  /* 语音体检:真机「说了没字」时先看这里,能直接区分
     没识别服务 / 没麦克风 / 没权限 / 厂商语音 App 在不在 */
  function showDiag() {
    var d = null;
    try { d = (window.YSTV && YSTV.voiceInfo) ? JSON.parse(YSTV.voiceInfo()) : null; } catch (e) { d = null; }
    if (!d) {
      setPhase('error', '读不到诊断信息', '当前不在 App 内打开(浏览器里没有原生能力)');
      return;
    }
    var svc = (d.services && d.services.length) ? d.services.join(' / ') : '无';
    ui.help.style.display = 'block';
    /* 诊断行标签比指令表长(服务包名/语音App),单独放宽标签列,否则会折行 */
    ui.help.className = 'vc-help vc-diag';
    ui.help.innerHTML =
      drow('系统识别', d.hasRec ? '有' : '没有') +
      drow('服务包名', svc) +
      drow('语音App', d.hasExtApp ? '有' : '没有') +
      drow('麦克风', d.hasMic ? '有' : '没有') +
      drow('录音权限', d.perm ? '已授权' : '未授权') +
      drow('云端识别', asrReady() ? '已配置' : '未配置') +
      drow('系统', 'Android ' + d.api + ' · ' + (d.model || ''));

    /* 三档结论:系统能识别 / 靠自录音+云端识别 / 两条都没有 */
    if (d.hasRec || d.hasExtApp) {
      setPhase('thinking', '语音服务正常', d.perm ? '' : '但录音权限未授权');
      if (ui.tip) ui.tip.textContent = '能识别却没出字,多半是麦克风没声音或服务连不上';
    } else if (asrReady()) {
      setPhase('thinking', '走云端识别', '没有系统识别服务,但录好的音频会发给你配的接口');
      if (ui.tip) ui.tip.textContent = '麦克风 + 云端识别 = 这台设备可用';
    } else if (d.hasMic && canRec()) {
      setPhase('error', '这台设备没有识别服务', '麦克风是好的,配一个云端识别就能用');
      if (ui.tip) ui.tip.textContent = '点「识别服务」填一个 ASR 接口地址即可';
    } else {
      setPhase('error', '这台设备不能语音', d.hasMic ? '没有可用的录音通道' : '没有麦克风硬件');
      if (ui.tip) ui.tip.textContent = '用「键盘输入」或手机遥控页推送搜索';
    }
  }

  /* 失败原因分档给建议,别一律「检查麦克风权限」 */
  function errTip(msg) {
    var s = msg || '';
    if (/没有语音识别服务|不支持中文|语言包/.test(s)) return '设备缺少可用的识别服务,建议用键盘输入';
    if (/权限/.test(s)) return '到「系统设置→应用→AMUTV→权限」里打开麦克风';
    if (/联网|连不上|网络|断开/.test(s)) return '识别服务需要联网,检查网络后再试';
    if (/麦克风|录音/.test(s)) return '麦克风不可用,看看是否接了外接麦或被子系统占用';
    if (/频繁/.test(s)) return '等一下再试';
    return '也可以直接输入指令,回车执行';
  }

  function setPhase(p, text, sub) {
    phase = p;
    if (!ui.heard) return;
    ui.heard.className = 'vc-heard ' + p;
    if (text !== undefined) ui.heard.textContent = text;
    if (sub !== undefined) ui.intent.textContent = sub;
    if (ui.wave) ui.wave.style.opacity = (p === 'listening') ? '1' : '.25';
  }

  function open() {
    build();
    if (!mask.parentNode) {
      document.getElementById('overlay-root').appendChild(mask);
      if (window.KeyNav) { KeyNav.setModal(true); KeyNav.focusFirst(mask); }
    }
    mask.style.display = 'flex';
  }

  function close() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (recTimer) { clearTimeout(recTimer); recTimer = null; }
    try { if (window.YSTV && window.YSTV.stopVoice) window.YSTV.stopVoice(); } catch (e) {}
    try { if (window.YSTV && window.YSTV.recStop) window.YSTV.recStop(); } catch (e) {}
    try { if (webRec && webRec.state === 'recording') webRec.stop(); } catch (e) {}
    webRec = null;
    if (mask && mask.parentNode) {
      mask.remove();
      if (window.KeyNav) KeyNav.setModal(false);
    }
    setPhaseIdle();
  }

  function setPhaseIdle() {
    phase = 'idle';
    if (ui.help) ui.help.style.display = 'none';
    if (ui.manual) ui.manual.style.display = 'none';
    if (ui.heard) { ui.heard.textContent = '正在聆听…'; ui.heard.className = 'vc-heard'; }
    if (ui.intent) ui.intent.textContent = '';
    if (ui.tip) ui.tip.textContent = '说「看庆余年」「下一集」「声音大一点」';
  }

  function showManual(msg) {
    open();
    ui.manual.style.display = 'flex';
    if (ui.asr) ui.asr.style.display = 'none';
    setPhase('manual', msg || '键盘输入指令', '');
    if (ui.tip) ui.tip.textContent = '回车执行;Esc 关闭';
    setTimeout(function () { try { ui.input.focus(); } catch (e) {} }, 30);
  }

  /* ================= 入口 ================= */
  function start() {
    open();
    listen();
  }

  /* 设备上到底有没有「系统级识别」:装了 GMS 或厂商语音服务的盒子有,国产盒子多数没有 */
  function canNativeSpeech() {
    if (!nativeOk()) return false;
    try {
      var d = JSON.parse(window.YSTV.voiceInfo());
      return !!(d && (d.hasRec || d.hasExtApp));
    } catch (e) { return true; }   // 读不到诊断就按老路径试,失败会自己报错
  }

  function listen() {
    open();
    if (ui.help) ui.help.style.display = 'none';
    if (ui.manual) ui.manual.style.display = 'none';
    if (ui.asr) ui.asr.style.display = 'none';

    /* 1) 配了云端识别 → 自己录音。设备有没有语音服务都无所谓,这是通用路径 */
    if (asrReady() && canRec()) { listenByRec(); return; }

    /* 2) 没配 → 系统识别(有 GMS/厂商语音服务的设备够用) */
    if (canNativeSpeech()) {
      if (timer) clearTimeout(timer);
      setPhase('listening', '正在聆听…', '');
      try { window.YSTV.startVoice(); } catch (e) { showManual('语音启动失败:' + e); return; }
      timer = setTimeout(function () {
        if (phase !== 'listening') return;
        try { if (window.YSTV.stopVoice) window.YSTV.stopVoice(); } catch (e) {}
        setPhase('error', '没有听到声音', '再试一次,或用键盘输入');
      }, 12000);
      return;
    }

    /* 3) 没有系统识别,但有麦克风 → 引导配云端识别,别再把用户一脚踢回键盘 */
    if (canRec()) {
      setPhase('error', '这台设备没有语音识别服务', '麦克风是好的,配一个云端识别就能用');
      if (ui.tip) ui.tip.textContent = '点「识别服务」填接口地址,或先用键盘输入';
      showAsr();
      return;
    }

    showManual('这台设备没有可用的语音识别,用键盘说吧');
  }

  /* 录音通路:原生优先(App 内),浏览器次之 */
  function listenByRec() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (recTimer) { clearTimeout(recTimer); recTimer = null; }
    if (ui.help) ui.help.style.display = 'none';

    if (!recOk()) { webListen(); return; }

    setPhase('listening', '正在聆听…', '说完会自动结束');
    var r = null;
    try { r = JSON.parse(window.YSTV.recStart()); } catch (e) { r = { ok: false, msg: String(e) }; }
    if (!r || !r.ok) {
      /* 权限弹窗刚弹出:授予后原生会自动开录,走 __onRecPerm 接着来 */
      if (r && r.asking) { setPhase('listening', '正在申请麦克风权限…', '允许后自动开始'); return; }
      setPhase('error', '录音启动失败', (r && r.msg) || '检查麦克风');
      if (ui.tip) ui.tip.textContent = errTip((r && r.msg) || '');
      return;
    }
    recTimer = setTimeout(function () {
      if (phase !== 'listening') return;
      try { if (window.YSTV.recStop) window.YSTV.recStop(); } catch (e) {}
    }, 13000);
  }

  /* 浏览器通路:桌面/手机 Chrome 里也能验证同一套云端识别 */
  function webListen() {
    if (!webRecOk()) { showManual('这台设备没有可用的语音识别,用键盘说吧'); return; }
    setPhase('listening', '正在聆听…', '录 6 秒后自动识别');
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (st) {
      var chunks = [];
      var mr = new MediaRecorder(st);
      webRec = mr;
      mr.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
      mr.onstop = function () {
        try { st.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
        if (recTimer) { clearTimeout(recTimer); recTimer = null; }
        var blob = new Blob(chunks, { type: mr.mimeType || 'audio/webm' });
        if (!blob.size) { setPhase('error', '没录到声音', '检查系统麦克风输入'); return; }
        setPhase('thinking', '识别中…', '正在转文字');
        sendAsr(blob, 'voice.webm');
      };
      mr.start();
      recTimer = setTimeout(function () {
        try { if (webRec && webRec.state === 'recording') webRec.stop(); } catch (e) {}
      }, 6000);
    }).catch(function () {
      setPhase('error', '麦克风打不开', '浏览器要麦克风权限,且页面需 https 或 localhost');
      if (ui.tip) ui.tip.textContent = '也可以用「键盘输入」';
    });
  }

  /* 原生录音结束回调 */
  window.__onRec = function (msg) {
    try { if (typeof msg === 'string') msg = JSON.parse(msg); } catch (e) { return; }
    if (!msg) return;
    if (recTimer) { clearTimeout(recTimer); recTimer = null; }
    /* silent = 麦克风一点信号都没有,和「没识别服务」是两回事,分开报 */
    if (msg.silent) {
      setPhase('error', '没听到声音', '麦克风没有信号:确认设备有麦、没被静音');
      if (ui.tip) ui.tip.textContent = '外接麦/蓝牙麦要在系统里设为默认输入';
      return;
    }
    if (!msg.ok) { setPhase('error', '录音失败', msg.msg || msg.err || ''); return; }
    var sec = Math.round((msg.ms || 0) / 100) / 10;
    setPhase('thinking', '识别中…', '已录 ' + sec + ' 秒,正在转文字');
    /* App 内音频就在设备上,原生直接读文件上传,不用先取回网页 */
    if (window.YSTV && typeof window.YSTV.asrUpload === 'function') sendAsr(null, '');
    else fetchAudioThenAsr();
  };

  /* 录音权限授予后原生已经开录 */
  window.__onRecPerm = function (msg) {
    try { if (typeof msg === 'string') msg = JSON.parse(msg); } catch (e) { return; }
    if (phase !== 'listening') return;
    if (!msg || !msg.ok) {
      setPhase('error', '录音权限被拒绝', '到「系统设置→应用→AMUTV→权限」打开麦克风');
      return;
    }
    setPhase('listening', '正在聆听…', '说完会自动结束');
    if (recTimer) clearTimeout(recTimer);
    recTimer = setTimeout(function () {
      if (phase !== 'listening') return;
      try { if (window.YSTV.recStop) window.YSTV.recStop(); } catch (e) {}
    }, 13000);
  };

  /* 原生录音落在设备 cache,经本机 MiniServer 取回(仅 loopback,音频不出局域网) */
  function fetchAudioThenAsr() {
    fetch('http://127.0.0.1:9978/voice/wav?t=' + Date.now())
      .then(function (res) {
        if (!res.ok) throw new Error('取音频失败 HTTP ' + res.status);
        return res.blob();
      })
      .then(function (b) { return sendAsr(b, 'voice.wav'); })
      .catch(function (e) { asrFail(e); });
  }

  function asrFail(e) {
    var m = String((e && e.message) || e || '');
    setPhase('error', '识别服务出错', m.slice(0, 64));
    if (ui.tip) ui.tip.textContent = '点「识别服务」核对地址/Key;' + errTip(m);
  }

  function sendAsr(blob, name) {
    /* App 内必须走原生上传:页面是 file://,往外部域名 POST 会被 WebView 的 CORS 拦掉,
       而官方 ASR(OpenAI / 讯飞 / 阿里)都不返回 CORS 头,网页 fetch 一定失败。 */
    if (window.YSTV && typeof window.YSTV.asrUpload === 'function') {
      var r = null;
      try {
        r = JSON.parse(window.YSTV.asrUpload(asr.url, asr.key || '', asr.model || '', asr.lang || ''));
      } catch (e) {
        r = { ok: false, err: String(e) };
      }
      if (!r || !r.ok) { asrFail(new Error((r && r.err) || '上传失败')); return; }
      setPhase('thinking', '识别中…', '正在上传识别');
      return;   /* 结果从 __onAsr 回来 */
    }

    /* 浏览器通路:同源或对方带 CORS 头时可用 */
    var fd = new FormData();
    fd.append('file', blob, name);
    if (asr.model) fd.append('model', asr.model);
    if (asr.lang) { fd.append('language', asr.lang); fd.append('lang', asr.lang); }
    var h = {};
    if (asr.key) h['Authorization'] = 'Bearer ' + asr.key;
    return fetch(asr.url, { method: 'POST', headers: h, body: fd })
      .then(function (r2) {
        return r2.text().then(function (t) {
          if (!r2.ok) throw new Error('HTTP ' + r2.status + ' ' + String(t || '').slice(0, 100));
          return pickText(t);
        });
      })
      .then(function (text) {
        text = (text || '').trim();
        if (!text) { setPhase('error', '没听清', '再说一次,或换个识别接口'); return; }
        handleText(text);
      })
      .catch(function (e) { asrFail(e); });
  }

  /* 原生上传结果(text 是接口原始响应体,各种结构在这里归一) */
  window.__onAsr = function (msg) {
    try { if (typeof msg === 'string') msg = JSON.parse(msg); } catch (e) { return; }
    if (!msg) return;
    if (!msg.ok) {
      asrFail(new Error((msg.err || '上传失败') + (msg.code ? ' (HTTP ' + msg.code + ')' : '')));
      return;
    }
    var text = (pickText(msg.text || '') || '').trim();
    if (!text) { setPhase('error', '没听清', '再说一次,或换个识别接口'); return; }
    handleText(text);
  };

  /* 各家返回结构不统一:Whisper 是 {text},国内多是 {result}/{data.text},
     还有 {Result:{Text}}/{output.text}。先按语义键(大小写不敏感)找,
     找不到再退回任意字符串字段,但跳过 code/msg/status 这类噪声字段。 */
  var TEXT_KEYS = ['text', 'result', 'transcript', 'sentence', 'content'];
  var SKIP_KEYS = ['code', 'msg', 'message', 'status', 'error', 'err', 'id',
    'requestid', 'request_id', 'task', 'task_id', 'success', 'ok',
    'duration', 'time', 'sid', 'sessionid'];

  function pickText(raw) {
    var t = String(raw || '').trim();
    if (!t) return '';
    if (t.charAt(0) !== '{' && t.charAt(0) !== '[') return t;   // 直接返回纯文本的接口
    var j;
    try { j = JSON.parse(t); } catch (e) { return t; }
    return findText(j, 0);
  }

  function findText(o, d) {
    if (o == null || d > 6) return '';
    if (typeof o === 'string') return (o.length > 0 && o.length < 200) ? o : '';
    if (Object.prototype.toString.call(o) === '[object Array]') {
      for (var i = 0; i < o.length; i++) {
        var s = findText(o[i], d + 1);
        if (s) return s;
      }
      return '';
    }
    if (typeof o === 'object') {
      var keys = [], k;
      for (k in o) if (Object.prototype.hasOwnProperty.call(o, k)) keys.push(k);
      /* 1) 语义键优先,忽略大小写(Result / Text 这种也认) */
      for (var a = 0; a < TEXT_KEYS.length; a++) {
        for (var i2 = 0; i2 < keys.length; i2++) {
          if (String(keys[i2]).toLowerCase() === TEXT_KEYS[a]) {
            var v = findText(o[keys[i2]], d + 1);
            if (v) return v;
          }
        }
      }
      /* 2) 兜底:任意字段,但跳过明显不是正文的键 */
      for (var j2 = 0; j2 < keys.length; j2++) {
        if (SKIP_KEYS.indexOf(String(keys[j2]).toLowerCase()) >= 0) continue;
        var v2 = findText(o[keys[j2]], d + 1);
        if (v2) return v2;
      }
    }
    return '';
  }

  function showAsr() {
    open();
    if (ui.manual) ui.manual.style.display = 'none';
    if (ui.help) ui.help.style.display = 'none';
    if (ui.asr) {
      ui.asr.style.display = 'flex';
      if (ui.asrUrl) ui.asrUrl.value = asr.url || '';
      if (ui.asrKey) ui.asrKey.value = asr.key || '';
      if (ui.asrModel) ui.asrModel.value = asr.model || '';
    }
    setPhase('manual', '云端识别服务', '填好接口地址,这台设备的麦克风就能用');
    if (ui.tip) ui.tip.textContent = '兼容 OpenAI Whisper 的 /v1/audio/transcriptions;留空地址=清空配置';
    setTimeout(function () { try { if (ui.asrUrl) ui.asrUrl.focus(); } catch (e) {} }, 30);
  }

  function saveAsrFromUi() {
    var url = ((ui.asrUrl && ui.asrUrl.value) || '').trim();
    if (url && !/^https?:\/\//i.test(url)) {
      if (window.toastErr) toastErr('接口地址要以 http(s):// 开头');
      return;
    }
    saveAsr({
      url: url,
      key: ((ui.asrKey && ui.asrKey.value) || '').trim(),
      model: ((ui.asrModel && ui.asrModel.value) || '').trim() || 'whisper-1',
      lang: 'zh'
    });
    if (ui.asr) ui.asr.style.display = 'none';
    if (!url) {
      setPhase('error', '已清空识别服务', '现在只用设备自带的语音识别');
      return;
    }
    if (window.toast) toast('已保存,现在说一句试试');
    listen();
  }

  /* 原生回调:type = ready | partial | result | error */
  window.__onVoice = function (msg) {
    try {
      if (typeof msg === 'string') msg = JSON.parse(msg);
    } catch (e) { return; }
    if (!msg || !msg.type) return;

    if (msg.type === 'ready') {
      if (phase === 'listening') setPhase('listening', '正在聆听…', '说完会自动识别');
      return;
    }
    if (msg.type === 'partial') {
      if (msg.text) setPhase('listening', msg.text, '');
      return;
    }
    if (msg.type === 'result') {
      if (timer) { clearTimeout(timer); timer = null; }
      var t = (msg.text || '').trim();
      if (!t) { setPhase('error', '没听清', '再说一次'); return; }
      handleText(t);
      return;
    }
    if (msg.type === 'error') {
      if (timer) { clearTimeout(timer); timer = null; }
      setPhase('error', '识别失败', msg.msg || '检查麦克风权限');
      /* 识别已经用不了,直接把输入框亮出来,省掉用户再点一次「键盘输入」 */
      if (ui.manual) ui.manual.style.display = 'flex';
      if (ui.tip) ui.tip.textContent = errTip(msg.msg);
      setTimeout(function () { try { ui.input.focus(); } catch (e) {} }, 30);
    }
  };

  /* ================= 解析 + 执行 ================= */
  function handleText(text) {
    lastText = text;
    open();
    setPhase('thinking', text, '');
    var r = window.VoiceNLU.parse(text, { player: !!(PL() && PL().isOpen()) });
    var desc = window.VoiceNLU.describe(r);

    if (r.intent === 'help') {
      ui.help.style.display = 'block';
      setPhase('thinking', text, '这些说法都可以试');
      return;
    }
    if (r.intent === 'unknown') {
      var why = r.arg && r.arg.reason;
      if (why === 'no_player_action') { setPhase('error', text, '当前没有在播放,换个说法试试'); return; }
      if (why === 'volume_ambiguous') { setPhase('error', text, '要调大还是调小?'); return; }
      setPhase('error', text, '没听懂,试试「看庆余年」或「下一集」');
      return;
    }

    setPhase('thinking', text, '→ ' + desc);
    setTimeout(function () { run(r); }, 420);
  }

  function run(r) {
    var res = exec(r);
    if (res && res.err) {
      setPhase('error', lastText, res.err);
      return;
    }
    if (window.toast && res && res.msg) toast(res.msg);
    close();
    return res;
  }

  function exec(r) {
    var P = PL();
    var openP = !!(P && P.isOpen());
    var st = openP && P.getState ? P.getState() : null;

    /* —— 不需要播放器 —— */
    switch (r.intent) {
      case 'search':
        if (window.AppCtl) AppCtl.search(r.arg.wd);
        return { msg: '搜索「' + r.arg.wd + '」' };
      case 'nav':
        if (window.AppCtl) AppCtl.go(r.arg.page);
        return { msg: '打开' + (PAGES[r.arg.page] || r.arg.page) };
      case 'back':
        if (window.__onBack) window.__onBack();
        return { msg: '已返回' };
    }

    /* —— 以下都需要播放器 —— */
    if (!openP || !st) return { err: '当前没有在播放,先选一部片' };

    switch (r.intent) {
      case 'play': P.ctrl({ type: 'play' }); return { msg: '继续播放' };
      case 'pause': P.ctrl({ type: 'pause' }); return { msg: '已暂停' };
      case 'next': P.ctrl({ type: 'next' }); return { msg: '下一集' };
      case 'prev': P.ctrl({ type: 'prev' }); return { msg: '上一集' };
      case 'ep': {
        if (st.epCount && r.arg.n > st.epCount) return { err: '这一线路只有 ' + st.epCount + ' 集' };
        P.ctrl({ type: 'ep', arg: { g: st.groupIndex, e: r.arg.n - 1 } });
        return { msg: '第 ' + r.arg.n + ' 集' };
      }
      case 'seek':
        P.ctrl({ type: 'seek', arg: r.arg.sec });
        return { msg: (r.arg.sec > 0 ? '快进 ' : '后退 ') + Math.abs(r.arg.sec) + ' 秒' };
      case 'restart':
        P.ctrl({ type: 'settime', arg: 0 });
        return { msg: '从头播放' };
      case 'volume': {
        var m = r.arg.mode;
        if (m === 'mute') { P.ctrl({ type: 'mute', arg: true }); return { msg: '已静音' }; }
        if (m === 'unmute') { P.ctrl({ type: 'mute', arg: false }); return { msg: '已取消静音' }; }
        var v = m === 'set' ? r.arg.value
          : (m === 'up' ? Math.min(1, st.volume + 0.1) : Math.max(0, st.volume - 0.1));
        /* 静音状态下调音量,先解除静音,否则用户听不到变化 */
        P.ctrl({ type: 'mute', arg: false });
        P.ctrl({ type: 'vol', arg: v });
        return { msg: '音量 ' + Math.round(v * 100) + '%' };
      }
      case 'rate': {
        var rt = r.arg.value ? r.arg.value
          : (r.arg.mode === 'faster' ? st.rate + 0.25 : Math.max(0.25, st.rate - 0.25));
        rt = Math.max(0.25, Math.min(4, Math.round(rt * 100) / 100));
        P.ctrl({ type: 'rate', arg: rt });
        return { msg: '倍速 ' + rt + 'x' };
      }
      case 'fs': P.ctrl({ type: 'fs' }); return { msg: '全屏切换' };
      case 'exit': P.ctrl({ type: 'exit' }); return { msg: '已退出播放' };
    }
    return { err: '这个操作还不支持' };
  }

  /* 面板打开时吞掉返回键:避免同时触发播放器退出或页面后退。
     capture + stopImmediatePropagation 保证比 playerKeys / app.js 的路由先执行 */
  document.addEventListener('keydown', function (e) {
    if (!mask || !mask.parentNode) return;
    if (e.key === 'Escape' || e.key === 'Backspace') {
      e.preventDefault();
      e.stopImmediatePropagation();
      close();
    }
  }, true);

  /* 播放器按键处理会同时响应方向键/空格,面板开着时让它让位 */
  var prevOnBack = window.__onBack;
  window.__onBack = function () {
    if (mask && mask.parentNode) { close(); return 1; }
    return prevOnBack ? prevOnBack() : 0;
  };

  window.Voice = {
    start: start,
    /* 遥控器语音键在面板已打开时再按一次 = 重新说 */
    retry: listen,
    close: close,
    isOpen: function () { return !!(mask && mask.parentNode); },
    /* 语音能力体检(原生 bridge 有才有内容) */
    diag: function () { open(); showDiag(); return true; },
    /* 云端识别配置:没有系统识别服务的设备靠它把麦克风用起来 */
    asr: function () { showAsr(); return true; },
    /* 解析接口返回体:接口通了但「没字」时,贴一段原始响应就能看出问题 */
    asrText: function (raw) { return pickText(raw); },
    /* 当前识别通路的判定结果,便于自动化测试与排障 */
    route: function () {
      if (asrReady() && canRec()) return 'cloud';
      if (canNativeSpeech()) return 'native';
      if (canRec()) return 'need-asr';
      return 'none';
    },
    /* 直接执行一句话(不经过麦克风):供调试与自动化测试 */
    say: function (text) { handleText(text); return true; },
    /* 仅解析不执行,方便排查理解偏差 */
    parse: function (text) {
      return window.VoiceNLU.parse(text, { player: !!(PL() && PL().isOpen()) });
    }
  };
})();
