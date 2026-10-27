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
          '<div class="vc-help" id="vc-help" style="display:none"></div>' +
          '<div class="vc-tip" id="vc-tip">说「看庆余年」「下一集」「声音大一点」</div>' +
          '<div class="vc-actions">' +
            '<button class="vc-b" data-act="retry" data-f tabindex="-1">重新说</button>' +
            '<button class="vc-b" data-act="manual" data-f tabindex="-1">键盘输入</button>' +
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
      drow('识别服务', d.hasRec ? '有' : '没有') +
      drow('服务包名', svc) +
      drow('语音App', d.hasExtApp ? '有' : '没有') +
      drow('麦克风', d.hasMic ? '有' : '没有') +
      drow('权限', d.perm ? '已授权' : '未授权') +
      drow('系统', 'Android ' + d.api + ' · ' + (d.model || ''));
    setPhase(d.hasRec ? 'thinking' : 'error',
      d.hasRec ? '语音服务正常' : '这台设备没有识别服务',
      d.hasRec ? (d.perm ? '' : '但录音权限未授权') : '只能用键盘输入');
    if (ui.tip) ui.tip.textContent = d.hasRec
      ? '能识别却没出字,多半是麦克风没声音或服务连不上'
      : '装一个带语音识别的应用(如讯飞语记),再回来点「重新说」';
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
    try { if (window.YSTV && window.YSTV.stopVoice) window.YSTV.stopVoice(); } catch (e) {}
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
    setPhase('manual', msg || '键盘输入指令', '');
    if (ui.tip) ui.tip.textContent = '回车执行;Esc 关闭';
    setTimeout(function () { try { ui.input.focus(); } catch (e) {} }, 30);
  }

  /* ================= 入口 ================= */
  function start() {
    open();
    listen();
  }

  function listen() {
    open();
    if (ui.help) ui.help.style.display = 'none';
    if (ui.manual) ui.manual.style.display = 'none';
    if (!nativeOk()) {
      showManual('这台设备没有可用的语音识别,用键盘说吧');
      return;
    }
    setPhase('listening', '正在聆听…', '');
    try { window.YSTV.startVoice(); } catch (e) { showManual('语音启动失败:' + e); return; }
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () {
      if (phase !== 'listening') return;
      try { if (window.YSTV.stopVoice) window.YSTV.stopVoice(); } catch (e) {}
      setPhase('error', '没有听到声音', '再试一次,或用键盘输入');
    }, 12000);
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
    /* 直接执行一句话(不经过麦克风):供调试与自动化测试 */
    say: function (text) { handleText(text); return true; },
    /* 仅解析不执行,方便排查理解偏差 */
    parse: function (text) {
      return window.VoiceNLU.parse(text, { player: !!(PL() && PL().isOpen()) });
    }
  };
})();
