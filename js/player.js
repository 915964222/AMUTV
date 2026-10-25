/* ================= 播放器组件 =================
 * Player.open({ title, groups, groupIndex, epIndex, key, onClose })
 *  - groups: API.parsePlay 的结果 [{name, eps:[{name,url}]}]
 *  - key: 历史/续播键 (sourceId|vodId)
 * 支持: HLS(m3u8, hls.js)/MP4/iframe 兜底、断点续播、选集、倍速、快捷键
 * ================================================= */
const Player = (() => {
  let root = null, video = null, hls = null, iframe = null;
  let state = null; // 当前播放状态
  let saveTimer = null, hideTimer = null;
  let lastPos = 0, lastDur = 0;

  const SEEK = 10;

  function el(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; }

  /* SVG 矢量图标(跨平台一致) */
  const I = {"back": "<svg viewBox=\"0 0 24 24\" width=\"22\" height=\"22\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M19 12H5\"/><path d=\"M12 19l-7-7 7-7\"/></svg>", "fav": "<svg viewBox=\"0 0 24 24\" width=\"20\" height=\"20\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"><path d=\"M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z\"/></svg>", "favOn": "<svg viewBox=\"0 0 24 24\" width=\"20\" height=\"20\" fill=\"currentColor\" stroke=\"currentColor\" stroke-width=\"2\"><path d=\"M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z\"/></svg>", "rew": "<svg viewBox=\"0 0 24 24\" width=\"22\" height=\"22\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M11 17l-5-5 5-5\"/><path d=\"M18 17l-5-5 5-5\"/></svg>", "play": "<svg viewBox=\"0 0 24 24\" width=\"24\" height=\"24\" fill=\"currentColor\"><path d=\"M6 4l14 8-14 8z\"/></svg>", "pause": "<svg viewBox=\"0 0 24 24\" width=\"24\" height=\"24\" fill=\"currentColor\"><rect x=\"5\" y=\"4\" width=\"5\" height=\"16\" rx=\"1\"/><rect x=\"14\" y=\"4\" width=\"5\" height=\"16\" rx=\"1\"/></svg>", "ff": "<svg viewBox=\"0 0 24 24\" width=\"22\" height=\"22\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M13 17l5-5-5-5\"/><path d=\"M6 17l5-5-5-5\"/></svg>", "next": "<svg viewBox=\"0 0 24 24\" width=\"22\" height=\"22\" fill=\"currentColor\"><path d=\"M5 5l9 7-9 7z\"/><rect x=\"16\" y=\"5\" width=\"3\" height=\"14\" rx=\"1\"/></svg>", "eps": "<svg viewBox=\"0 0 24 24\" width=\"20\" height=\"20\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\"><path d=\"M8 6h13M8 12h13M8 18h13\"/><circle cx=\"4\" cy=\"6\" r=\"1.2\" fill=\"currentColor\" stroke=\"none\"/><circle cx=\"4\" cy=\"12\" r=\"1.2\" fill=\"currentColor\" stroke=\"none\"/><circle cx=\"4\" cy=\"18\" r=\"1.2\" fill=\"currentColor\" stroke=\"none\"/></svg>", "more": "<svg viewBox=\"0 0 24 24\" width=\"20\" height=\"20\" fill=\"currentColor\"><circle cx=\"5\" cy=\"12\" r=\"2\"/><circle cx=\"12\" cy=\"12\" r=\"2\"/><circle cx=\"19\" cy=\"12\" r=\"2\"/></svg>", "fs": "<svg viewBox=\"0 0 24 24\" width=\"20\" height=\"20\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M8 3H5a2 2 0 0 0-2 2v3\"/><path d=\"M16 3h3a2 2 0 0 1 2 2v3\"/><path d=\"M8 21H5a2 2 0 0 1-2-2v-3\"/><path d=\"M16 21h3a2 2 0 0 0 2-2v-3\"/></svg>"};
  const fmt = s => {
    s = Math.max(0, Math.floor(s || 0));
    const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), ss = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(ss).padStart(2, '0');
  };

  function open(opts) {
    close(true);
    state = { ...opts };
    build();
    loadEpisode(opts.groupIndex || 0, opts.epIndex || 0, { resume: true });
    KeyNav.setPlayer(true);
  }

  /* ---------- 外挂字幕:抓取文本 → addTextTrack(模块层) ---------- */
  let subsLoading = false;
  let dm = null; // 弹幕渲染器(设置抽屉创建,exit 统一销毁)

  /* ---------- 字幕样式(自定义渲染 overlay):字号/描边/背景不透明度 ---------- */
  function subStyle() {
    const c = DB.getConfig().subStyle || {};
    return { scale: c.scale || 1, stroke: (c.stroke !== undefined ? c.stroke : 2), bg: (c.bg !== undefined ? c.bg : 0.35) };
  }
  function applySubStyle() {
    const st = subStyle();
    const ov = root && root.querySelector('.pl-sub-ov');
    if (!ov) return;
    ov.style.fontSize = 'calc(26px * ' + st.scale + ')';
    ov.style.textShadow = [0, 45, 90, 135, 180, 225, 270, 315].map(function (a) {
      const r = a * Math.PI / 180;
      return Math.round(Math.sin(r) * st.stroke) + 'px ' + Math.round(Math.cos(r) * st.stroke) + 'px 2px #000';
    }).join(',');
    ov.style.background = st.bg > 0.02 ? 'rgba(0,0,0,' + st.bg + ')' : 'transparent';
  }
  /* 启用自定义渲染:隐藏原生字幕轨道,监听 cuechange 在 overlay 显示 */
  function enableSubOverlay() {
    if (!root || !video || root.querySelector('.pl-sub-ov')) return;
    const ov = el('<div class="pl-sub-ov" style="position:absolute;left:50%;bottom:11%;transform:translateX(-50%);max-width:86%;padding:6px 16px;border-radius:8px;color:#fff;font-weight:600;text-align:center;white-space:pre-wrap;line-height:1.5;pointer-events:none;z-index:6"></div>');
    root.appendChild(ov);
    applySubStyle();
    const show = function () {
      let txt = '';
      for (let i = 0; i < video.textTracks.length; i++) {
        const t = video.textTracks[i];
        if (t.mode !== 'showing' && t.mode !== 'hidden') continue;
        if (t.activeCues && t.activeCues.length) {
          for (let j = 0; j < t.activeCues.length; j++) txt += (txt ? '\n' : '') + (t.activeCues[j].text || '');
        }
      }
      ov.textContent = txt;
    };
    video.textTracks.addEventListener && video.textTracks.addEventListener('addtrack', function () { hookTracks(); });
    function hookTracks() {
      for (let i = 0; i < video.textTracks.length; i++) {
        const t = video.textTracks[i];
        if (t.kind !== 'subtitles') continue;
        if (t.__ov) continue;
        t.__ov = 1;
        t.mode = 'hidden';
        t.addEventListener('cuechange', show);
      }
    }
    hookTracks();
    video.addEventListener('timeupdate', show);
  }

  /* ---------- 字幕时间轴 Offset:cues 整体平移 ---------- */
  function shiftSubOffset(delta) {
    if (!video) return;
    if (delta === 'reset') {
      if (window.toast) toast('重新加载本集,字幕时间轴已归零');
      loadEpisode(state.groupIndex, state.epIndex);
      return 0;
    }
    let n = 0;
    for (let i = 0; i < video.textTracks.length; i++) {
      const t = video.textTracks[i];
      if (t.kind !== 'subtitles') continue;
      const cues = t.cues;
      if (!cues) continue;
      for (let j = 0; j < cues.length; j++) {
        try {
          cues[j].startTime = Math.max(0, cues[j].startTime + delta);
          cues[j].endTime = Math.max(0.1, cues[j].endTime + delta);
          n++;
        } catch (e) {}
      }
    }
    state.subOffset = Math.round(((state.subOffset || 0) + delta) * 10) / 10;
    if (window.toast) toast('字幕' + (state.subOffset >= 0 ? '延迟 +' : '提前 ') + Math.abs(state.subOffset) + 's' + (n ? '' : '(无字幕轨)'));
    return state.subOffset;
  }

  function attachSub(name, cues) {
    if (!cues.length) return;
    let track = null;
    for (let i = 0; i < video.textTracks.length; i++) {
      if (video.textTracks[i].label === name) { track = video.textTracks[i]; break; }
    }
    if (!track) {
      track = video.addTextTrack('subtitles', name, 'zh');
      cues.forEach(function (c) {
        try { track.addCue(new VTTCue(c.start, c.end, c.text)); } catch (e) {}
      });
    }
    track.mode = 'showing';
    enableSubOverlay();
    if (window.toast) toast('外挂字幕已加载:' + name);
  }
  function setupSubtitles() {
    if (subsLoading) return;
    subsLoading = true;
    /* 同名 .srt/.vtt 自动探测(本站相对路径的视频) */
    const epUrl = state.groups[state.groupIndex].eps[state.epIndex].url;
    if (/^\//.test(epUrl) && !/\.(m3u8|ts|m2ts)$/i.test(epUrl)) {
      const srtUrl = epUrl.replace(/\.[a-z0-9]+$/i, '.srt');
      fetch(srtUrl).then(function (r) {
        if (!r.ok) throw 0;
        return r.arrayBuffer();
      }).then(function (buf) {
        const cues = window.Subtitles.parse(window.Subtitles.decodeSmart(buf), srtUrl);
        attachSub('同名字幕', cues);
      }).catch(function () {});
    }
    /* 显式传入的外挂字幕(网盘/SMB 同名) */
    (state.subs || []).forEach(function (s) {
      fetch(s.url).then(function (r) { return r.arrayBuffer(); })
        .then(function (buf) {
          const text = window.Subtitles.decodeSmart(buf);
          const cues = window.Subtitles.parse(text, s.name);
          if (!cues.length) return;
          attachSub(s.name, cues);
        })
        .catch(function () {});
    });
    setTimeout(function () { subsLoading = false; }, 500);
  }
  function subTrackList() {
    const list = [];
    try {
      for (let i = 0; i < video.textTracks.length; i++) {
        const t = video.textTracks[i];
        if (t.kind === 'subtitles') list.push({ track: t, name: t.label || ('字幕' + (i + 1)), showing: t.mode === 'showing' });
      }
    } catch (e) {}
    return list;
  }

  function build() {
    root = el(`<div id="player">
      <video playsinline></video>
      <div class="pl-top">
        <button class="pc-btn" data-act="back" title="返回"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/></svg></button>
        <div class="pl-title"><span class="t-name"></span><span class="t-ep"></span></div>
        <button class="pc-btn" data-act="favors" title="收藏"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg></button>
      </div>
      <div class="pl-center"></div>
      <div class="pl-bottom">
        <div class="pl-time-row">
          <span class="pl-time" id="pl-cur">00:00</span>
          <div class="pl-track" data-act="track" tabindex="-1" data-f><div class="rail"><div class="fill" style="width:0%"></div></div></div>
          <span class="pl-time" id="pl-dur">00:00</span>
        </div>
        <button class="pbtn skip-intro" data-act="skipintro" style="display:none">跳过片头 ⏭</button>
        <div class="pl-ctrls">
          <div class="pc-left">
            <button class="pc-btn" data-act="rew" title="快退10秒"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 17l-5-5 5-5"/><path d="M18 17l-5-5 5-5"/></svg></button>
            <button class="pc-btn pc-play" data-act="play" title="暂停/播放"><svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M6 4l14 8-14 8z"/></svg></button>
            <button class="pc-btn" data-act="ff" title="快进10秒"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 17l5-5-5-5"/><path d="M6 17l5-5-5-5"/></svg></button>
            <button class="pc-btn" data-act="next" title="下一集"><svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M5 5l9 7-9 7z"/><rect x="16" y="5" width="3" height="14" rx="1"/></svg></button>
          </div>
          <div class="pc-right">
            <button class="pc-btn pc-wide" data-act="eps" title="选集"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 6h13M8 12h13M8 18h13"/><circle cx="4" cy="6" r="1.2" fill="currentColor" stroke="none"/><circle cx="4" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="4" cy="18" r="1.2" fill="currentColor" stroke="none"/></svg><span>选集</span></button>
            <button class="pc-btn" data-act="pset" title="画质/音轨/倍速/换源/嗅探"><svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg></button>
            <button class="pc-btn" data-act="fs" title="全屏"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M8 21H5a2 2 0 0 1-2-2v-3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg></button>
          </div>
        </div>
      </div>
    </div>`);
    document.body.appendChild(root);
    video = root.querySelector('video');
    iframe = null;

    root.querySelector('.t-name').textContent = state.title || '';

    root.addEventListener('click', e => {
      const btn = e.target.closest('[data-act]');
      if (btn) {
        const act = btn.dataset.act;
        if (act === 'back') exit();
        else if (act === 'play') togglePlay();
        else if (act === 'rew') seekBy(-SEEK);
        else if (act === 'ff') seekBy(SEEK);
        else if (act === 'prev') switchEp(-1);
        else if (act === 'next') switchEp(1);
        else if (act === 'eps') toggleDrawer();
        else if (act === 'src') toggleSourcePanel();
        else if (act === 'sniff') toggleSniff();
        else if (act === 'fs') toggleFs();
        else if (act === 'speed') cycleSpeed(btn);
        else if (act === 'ratio') cycleRatio();
        else if (act === 'pset') togglePset();
        else if (act === 'skipintro') skipIntroNow();
        else if (act === 'favors') toggleFavBtn(btn);
        else if (act === 'track') seekTrack(e);
        poke();
      }
    });
    // 进度条:点击跳转 + 按住拖动擦洗(scrubbing 期间暂停自动隐藏)
    const track = root.querySelector('.pl-track');
    let scrubbing = false;
    const scrubTo = e => {
      const rail = track.querySelector('.rail').getBoundingClientRect();
      const p = Math.min(1, Math.max(0, (e.clientX - rail.left) / rail.width));
      if (isFinite(video.duration)) {
        video.currentTime = p * video.duration;
        root.querySelector('.pl-track .fill').style.width = (p * 100) + '%';
        root.querySelector('#pl-cur').textContent = fmt(p * video.duration);
      }
    };
    track.addEventListener('pointerdown', e => {
      scrubbing = true; state.scrubbing = true;
      track.setPointerCapture(e.pointerId);
      scrubTo(e); wake();
    });
    track.addEventListener('pointermove', e => { if (scrubbing) { scrubTo(e); wake(); } });
    track.addEventListener('pointerup', e => { if (scrubbing) { scrubTo(e); scrubbing = false; state.scrubbing = false; wake(); } });
    track.addEventListener('pointercancel', () => { scrubbing = false; state.scrubbing = false; wake(); });
    const tip = root.querySelector('.pl-tip');
    track.addEventListener('mousemove', e => {
      if (!isFinite(video.duration) || !tip) return;
      const rail = track.querySelector('.rail').getBoundingClientRect();
      const p = Math.min(1, Math.max(0, (e.clientX - rail.left) / rail.width));
      tip.style.display = 'block';
      tip.style.left = (p * 100) + '%';
      tip.textContent = fmt(p * video.duration);
    });
    track.addEventListener('mouseleave', () => { if (tip) tip.style.display = 'none'; });

    video.addEventListener('timeupdate', onTime);
    video.addEventListener('play', updatePlayBtn);
    video.addEventListener('playing', () => {
      // 开始播放后清掉残留的失败提示
      const c = root.querySelector('.pl-center');
      if (c && c.textContent.includes('失败')) showCenter('');
    });
    video.addEventListener('pause', () => { updatePlayBtn(); saveProgress(); });
    window.addEventListener('beforeunload', saveProgress);
    video.addEventListener('ended', () => switchEp(1));
    // 点击画面:暂停/播放;双击:全屏(遥控器与鼠标用户的直觉操作)
    video.addEventListener('click', () => { togglePlay(); poke(); });
    video.addEventListener('dblclick', () => { toggleFs(); });
    video.addEventListener('error', () => {
      // 空源(切换集时 reset)也会触发 error,忽略之
      if (!video.currentSrc) return;
      const handled = maybeAutoSwitch('播放失败');
      if (!handled && document.getElementById('player')) {
        showCenter(`<div class="pl-msg">播放失败:该链接不可用或格式不支持</div>`);
      }
    });

    document.addEventListener('keydown', playerKeys, true);
    document.addEventListener('mousemove', poke);
    saveTimer = setInterval(saveProgress, 5000);
    updateFavBtn();
    updatePlayBtn();
    armStallWatchdog();
    rcStart();
    wake();
  }

  /* ---------- 局域网 Web 遥控:状态上报给本机服务 + 执行手机端命令 ---------- */
  const RC_SRV = location.protocol === 'file:' ? 'http://127.0.0.1:9978' : '';
  let rcTimer = null, rcSince = 0;
  function rcReport() {
    if (!video || !state || !state.groups) return;
    const g = state.groups[state.groupIndex];
    const ep = g && g.eps && g.eps[state.epIndex];
    try {
      fetch(RC_SRV + '/rc/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        title: state.name || state.title || '', ep: ep ? ep.name : '', group: g ? g.name : '',
        time: video.currentTime || 0, duration: isFinite(video.duration) ? video.duration : 0,
        paused: !!video.paused, live: !!state.liveMode, volume: video.volume, rate: video.playbackRate,
        groupIndex: state.groupIndex, epIndex: state.epIndex,
        groups: state.groups.map(x => x.name),
        eps: (g && g.eps ? g.eps : []).map(e => e.name).slice(0, 500),
      }) }).catch(() => {});
    } catch (e) {}
  }
  function rcExec(c) {
    if (!video || !state) return;
    try {
      switch (c.type) {
        case 'play': video.play().catch(() => {}); break;
        case 'pause': video.pause(); break;
        case 'toggle': togglePlay(); break;
        case 'seek': seekBy(Number(c.arg) || 0); break;
        case 'settime': video.currentTime = Number(c.arg) || 0; break;
        case 'vol': video.volume = Math.min(1, Math.max(0, Number(c.arg))); break;
        case 'rate': video.playbackRate = Number(c.arg) || 1; break;
        case 'next': switchEp(1); break;
        case 'prev': switchEp(-1); break;
        case 'ep': if (c.arg && isFinite(c.arg.g) && isFinite(c.arg.e)) loadEpisode(c.arg.g, c.arg.e); break;
        case 'ratio': setZoom(Number(c.arg) || 0); break;
        case 'fs': toggleFs(); break;
        case 'exit': close(); break;
      }
    } catch (e) {}
  }
  function rcStart() {
    rcStop(); rcSince = 0;
    rcReport();
    rcTimer = setInterval(async () => {
      if (!root || !video) return rcStop();
      rcReport();
      try {
        const r = await fetch(RC_SRV + '/rc/poll?since=' + rcSince).then(x => x.json());
        (r.cmds || []).forEach(c => { rcSince = Math.max(rcSince, c.id); rcExec(c); });
      } catch (e) {}
    }, 1500);
  }
  function rcStop() { if (rcTimer) { clearInterval(rcTimer); rcTimer = null; } }

  /* ---------- 加载某一集 ---------- */
  async function loadEpisode(gi, ei, { resume = false } = {}) {
    if (!state.groups[gi]) return;
    const g = state.groups[gi];
    const ep = g.eps[ei];
    if (!ep) return;

    state.groupIndex = gi; state.epIndex = ei;
    state._outroFired = false;
    state._stallHealed = false;
    setTitle();
    try { applyRatio(); } catch (_e) {}
    showCenter(`<div class="spinner"></div><div class="pl-msg">正在加载: ${ep.name}</div>`);
    destroyEngine();

    const url = DB.getConfig().proxyMode ? API.proxied(ep.url) : ep.url;
    const isIframe = /^https?:/i.test(ep.url) && !/\.(mp4|m3u8|mkv|webm)(\?|$)/i.test(ep.url) && !/\.mp4|m3u8/.test(ep.url);
    const isHls = /\.m3u8(\?|$)/i.test(ep.url) || /m3u8/.test(ep.url);
    const isFile = /\.(mp4|webm|mkv|mov)(\?|$)/i.test(ep.url);

    try {
      if (isIframe && !isFile && !isHls) {
        // iframe 兜底(网页播放)
        video.style.display = 'none';
        iframe = el(`<iframe allow="autoplay; fullscreen; encrypted-media" referrerpolicy="no-referrer"></iframe>`);
        iframe.src = url;
        root.insertBefore(iframe, root.querySelector('.pl-top'));
        showCenter('');
        return;
      }

      video.style.display = '';
      let useMSE = false;
      /* HLS 内核选择:EXO(MSE)优先(Chromium 的 canPlayType 返回 "maybe" 但实际不解 HLS);
         系统内核仅在显式选择且浏览器真支持("probably",如 Safari)时使用 */
      const effEngine = state.engineMode || DB.getConfig().kernel || 'auto';
      const effDecode = state.decodeMode || DB.getConfig().decodeMode || 'hw';
      const nativeHlsOk = video.canPlayType('application/vnd.apple.mpegurl') === 'probably';
      const useNativeEngine = isHls && ((effEngine === 'native' && nativeHlsOk) || !window.Hls || !Hls.isSupported());
      if (isHls && !useNativeEngine) {
        if (!window.Hls || !Hls.isSupported()) throw new Error('当前浏览器不支持 HLS');
        useMSE = true;
        // 广告切片过滤 loader:包装默认 loader,对 playlist 响应做 m3u8 文本过滤
        const adFilterLoader = (window.AdFilter && DB.getConfig().adFilter !== false) ? (function () {
          const Base = Hls.DefaultConfig.loader;
          return class AdFilterLoader extends Base {
            load(context, config, callbacks) {
              if (callbacks && typeof callbacks.onSuccess === 'function') {
                const origSuccess = callbacks.onSuccess;
                callbacks.onSuccess = function (response, stats, ctx2, net) {
                  try {
                    if (response && response.data && /#EXTM3U/.test(response.data)) {
                      const r = window.AdFilter.filterM3U8(response.data);
                      if (r.removed > 0) { response.data = r.text; if (window.toast) toast('已过滤 ' + r.removed + ' 个广告切片'); }
                    }
                  } catch (_e) {}
                  origSuccess(response, stats, ctx2, net);
                };
              }
              super.load(context, config, callbacks);
            }
          };
        })() : undefined;
        const hlsConf = {
          maxBufferLength: 30,
          startLevel: 0,                  // 从最低码率起播,快速出画,后续自动升档
          abrEwmaDefaultEstimate: 100000, // 初始带宽估计保守(适配慢速网络)
          /* 解码方式:硬解默认开 Worker(弱机多线程易黑屏时切软解:关 Worker+小缓冲) */
          enableWorker: effDecode !== 'sw',
          maxBufferSize: effDecode === 'sw' ? 30 * 1000 * 1000 : 60 * 1000 * 1000,
          manifestLoadingTimeOut: 30000,
          manifestLoadingMaxRetry: 4,
          levelLoadingTimeOut: 30000,
          levelLoadingMaxRetry: 4,
          fragLoadingTimeOut: 120000,
          fragLoadingMaxRetry: 8,
        };
        if (effDecode === 'sw') hlsConf.maxBufferLength = 12;
        if (adFilterLoader) hlsConf.loader = adFilterLoader;
        hls = new Hls(hlsConf);
        hls.loadSource(url);
        hls.attachMedia(video);
        hls.on(Hls.Events.ERROR, (_e, data) => {
          if (!data.fatal) return;
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            try { hls.recoverMediaError(); return; } catch {}
          }
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            try { hls.startLoad(); return; } catch {}
          }
          showCenter(`<div class="pl-msg">HLS 加载失败(${data.details})</div>`);
        });
      } else {
        video.src = url;
      }

      await new Promise((resolve, reject) => {
        const ok = () => { cleanup(); resolve(); };
        const bad = () => {
          cleanup();
          if (!video.getAttribute('src')) { resolve(); return; } // 空源的假错误
          reject(new Error('load failed'));
        };
        const cleanup = () => {
          video.removeEventListener('loadedmetadata', ok);
          video.removeEventListener('error', bad);
          setTimeout(() => clearTimeout(t), 0);
        };
        const t = setTimeout(bad, useMSE ? 45000 : 20000);
        video.addEventListener('loadedmetadata', ok);
        video.addEventListener('error', bad);
        // 注意:MSE(hls.js)模式下不能调用 video.load(),否则会重置掉已挂载的 MediaSource
        if (!useMSE) video.load();
      });

      // 断点续播
      let startAt = 0;
      if (resume) {
        const h = DB.getHist(state.key);
        if (h && h.epIndex === ei && h.position > 30 && h.duration && h.position < h.duration * 0.95) {
          startAt = h.position;
          showCenter(`<div class="pl-msg">已从上次位置 ${fmt(startAt)} 继续播放</div>`);
        }
      }
      if (resume && !state.liveMode) {   // 直播不跳片头(缓冲有限,越界 seek 会致死循环)
        try {
          const intro = introSecOf();
          if (intro > 3 && startAt < intro) startAt = intro;
        } catch (_e) {}
      }
      if (startAt > 0) { try { video.currentTime = startAt; } catch {} }
      setupSubtitles();
      video.play().catch(() => showCenter(`<button class="bigplay" data-act="play">▶</button>`));
      showCenter('');
      saveProgress();
      // MSE 时间轴起点可能不在 0(如 PTS 偏移的流):currentTime 落在缓冲区外会永久停滞,跳到缓冲区起点
      if (startAt === 0) {
        const nudge = () => {
          if (state && state.epIndex === ei && state.groupIndex === gi && !video.seeking &&
              video.buffered.length && video.currentTime < video.buffered.start(0) - 0.3) {
            try { video.currentTime = video.buffered.start(0) + 0.1; } catch {}
          }
        };
        video.addEventListener('loadeddata', nudge, { once: true });
        setTimeout(nudge, 1500);
        setTimeout(nudge, 5000);
      }
    } catch (err) {
      try { console.log('LOADERR ' + (err && err.message || err) + ' url=' + ep.url); } catch (_e) {}
      const handled = maybeAutoSwitch(err);
      if (!handled && document.getElementById('player')) {
        showCenter(`<div class="pl-msg">加载失败: ${err.message || err}<br>小贴士:可在设置开启「自动换源」。</div>`);
      }
    }
  }

  function destroyEngine() {
    if (hls) { try { hls.destroy(); } catch {} hls = null; }
    if (iframe) { iframe.remove(); iframe = null; }
    video.removeAttribute('src');
    try { video.load(); } catch {}
  }

  /* ---------- 中心区提示 ---------- */
  function showCenter(html) {
    const c = root.querySelector('.pl-center');
    c.innerHTML = html;
    c.style.display = html ? '' : 'none';
  }

  /* ---------- 控制 ---------- */
  function updatePlayBtn() {
    if (!root || !video) return;
    const b = root.querySelector('[data-act="play"]');
    if (b) b.innerHTML = video.paused ? I.play : I.pause;
  }
  /* 播放/暂停中心闪烁反馈 */
  function flashIcon() {
    if (!root) return;
    const c = root.querySelector('.pl-center');
    if (!c) return;
    const f = el('<div class="pl-flash">' + (video.paused ? I.play : I.pause) + '</div>');
    c.appendChild(f);
    setTimeout(() => f.remove(), 550);
  }
  function togglePlay() {
    if (iframe) return;
    if (video.paused) video.play().catch(() => {});
    else video.pause();
    flashIcon();
  }
  function seekBy(d) {
    if (iframe) return;
    if (isFinite(video.duration)) video.currentTime = Math.min(Math.max(0, video.currentTime + d), video.duration);
  }
  function seekTrack(e) {
    if (iframe || !isFinite(video.duration)) return;
    const rail = root.querySelector('.pl-track .rail').getBoundingClientRect();
    const p = Math.min(1, Math.max(0, (e.clientX - rail.left) / rail.width));
    video.currentTime = p * video.duration;
  }
  const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3];
  function cycleSpeed(btn) {
    if (iframe) return;
    const cur = SPEEDS.indexOf(video.playbackRate) === -1 ? 0 : SPEEDS.indexOf(video.playbackRate);
    const next = SPEEDS[(cur + 1) % SPEEDS.length];
    video.playbackRate = next;
    btn.textContent = '倍速 x' + next;
  }
  function toggleFs() {
    if (document.fullscreenElement) document.exitFullscreen();
    else root.requestFullscreen && root.requestFullscreen();
  }
  function switchEp(d) {
    const g = state.groups[state.groupIndex];
    let ni = state.epIndex + d;
    if (ni < 0 || ni >= g.eps.length) {
      // 跨线路
      let ng = state.groupIndex + d;
      if (ng >= 0 && ng < state.groups.length) { loadEpisode(ng, d > 0 ? 0 : state.groups[ng].eps.length - 1); return; }
      toast && toast('已经是第' + (d > 0 ? '一' : '后一') + '集了');
      return;
    }
    loadEpisode(state.groupIndex, ni);
  }

  /* ---------- 画面比例:原始/满屏/拉伸 ---------- */
  const RATIOS = [['contain', '原始'], ['cover', '满屏'], ['fill', '拉伸']];
  const ZOOMS = [1, 1.1, 1.2, 1.3];
  function applyZoom() {
    if (video) video.style.transform = 'scale(' + (state.zoom || 1) + ')';
  }
  function setZoom(z) {
    if (!state) return;
    state.zoom = z;
    applyZoom();
    if (window.toast) toast('画面缩放:' + Math.round(z * 100) + '%' + (z > 1 ? '(边缘裁切)' : ''));
  }
  function cycleRatio() {
    if (!state) return;
    const idx = RATIOS.findIndex(function (r) { return r[0] === (state.ratio || 'contain'); });
    state.ratio = RATIOS[(idx + 1) % RATIOS.length][0];
    applyRatio();
    if (window.toast) toast('画面比例:' + RATIOS.find(function (r) { return r[0] === state.ratio; })[1]);
  }
  function applyRatio() {
    if (video) {
      video.style.objectFit = state.ratio || 'contain';
      video.style.transform = 'scale(' + (state.zoom || 1) + ')';
    }
    const b = root && root.querySelector('[data-act="ratio"]');
    if (b) b.textContent = '🖼 ' + (RATIOS.find(function (r) { return r[0] === (state.ratio || 'contain'); }) || RATIOS[0])[1];
  }

  /* ---------- 跳过片头/片尾 ---------- */
  function introSecOf() {
    const mark = DB.getMark(state.key);
    if (mark && mark.intro) return mark.intro;
    if (DB.getConfig().skipIntroAuto) return Number(DB.getConfig().defaultIntroSec) || 0;
    return 0;
  }
  function skipIntroNow() {
    if (video && isFinite(video.duration)) {
      const t = Math.min(introSecOf() || 90, video.duration - 15);
      video.currentTime = t;
      video.play().catch(function () {});
      if (window.toast) toast('已跳过片头');
    }
  }
  function onTimeExtra() {
    if (!state || iframe) return;
    const intro = state.liveMode ? 0 : introSecOf();
    const skipBtn = root.querySelector('[data-act="skipintro"]');
    if (skipBtn) skipBtn.style.display = (intro > 5 && video.currentTime < intro - 2 && video.currentTime > 3) ? '' : 'none';
    const mark = DB.getMark(state.key);
    if (mark && mark.outro && mark.outro > 20 && isFinite(video.duration)) {
      if (video.currentTime > mark.outro - 1.5 && video.currentTime < video.duration - 3) {
        if (!state._outroFired) { state._outroFired = true; if (window.toast) toast('已到片尾,自动播放下一集'); switchEp(1); }
        return;
      }
      if (video.currentTime < mark.outro - 15) state._outroFired = false;
    }
  }

  /* ---------- 播放设置抽屉:画质/音轨/字幕/内核/倍速/比例/片头片尾 ---------- */
  function togglePset() {
    const old = root.querySelector('.pl-strip');
    if (old && old.dataset.kind === 'set') { closePanels(); wake(); return; }
    closePanels(); wake();
    const d = el('<div class="pl-strip" data-kind="set"><div class="d-body"></div></div>');
    const body = d.querySelector('.d-body');
    root.appendChild(d);
    KeyNav.setModal(true);

    /* ---------- 弹幕状态与控件(dm 声明在模块级,exit 时统一销毁) ---------- */
    function ensureDanmaku() {
      if (dm || !window.Danmaku) return;
      const saved = JSON.parse(localStorage.getItem('tvw_danmaku') || '{"on":true,"opacity":0.85,"fontScale":1,"speed":1,"text":""}');
      dm = window.Danmaku.createRenderer(root, () => video);
      dm.setOpacity(typeof saved.opacity === 'number' ? saved.opacity : 0.85);
      dm.setFontScale(typeof saved.fontScale === 'number' ? saved.fontScale : 1);
      dm.setSpeed(saved.speed); // setSpeed 内部对非法值兜底为1
      dm.setOn(saved.on && !!saved.text);
      if (saved.text) { try { dm.setItems(window.Danmaku.parseXML(saved.text)); } catch (e) {} }
    }
    function saveDm() {
      if (!dm) return;
      localStorage.setItem('tvw_danmaku', JSON.stringify({
        on: dm.state.on, opacity: dm.state.opacity, fontScale: dm.state.fontScale, speed: dm.state.speed,
        text: (localStorage.getItem('tvw_danmaku') && JSON.parse(localStorage.getItem('tvw_danmaku')).text) || '',
      }));
    }

    function render(body) {
      body.innerHTML = '';
      /* 快捷操作:换源 / 嗅探 / 上集(低频功能收纳进二级抽屉) */
      const quick = el('<div class="ep-grid" style="margin-bottom:6px"></div>');
      const qSrc = el('<button class="ep" data-f tabindex="-1">🔀 换源</button>');
      qSrc.onclick = () => { closePanels(); toggleSourcePanel(); };
      quick.appendChild(qSrc);
      const qSniff = el('<button class="ep" data-f tabindex="-1">🔍 嗅探</button>');
      qSniff.onclick = () => { closePanels(); toggleSniff(); };
      quick.appendChild(qSniff);
      const qPrev = el('<button class="ep" data-f tabindex="-1">⏮ 上一集</button>');
      qPrev.onclick = () => { closePanels(); switchEp(-1); };
      quick.appendChild(qPrev);
      const qRc = el('<button class="ep" data-f tabindex="-1">📱 远程遥控</button>');
      qRc.onclick = () => {
        body.innerHTML = '';
        const back = el('<button class="ep" data-f tabindex="-1">← 返回</button>');
        back.onclick = () => render(body);
        body.appendChild(back);
        body.appendChild(el('<div class="d-group">手机遥控(同一 Wi-Fi)</div>'));
        const box = el('<div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap;padding:4px 2px 10px">' +
          '<img id="rc-qr" style="width:150px;height:150px;border-radius:10px;background:#fff;padding:6px">' +
          '<div style="flex:1;min-width:200px"><div class="hint" style="margin-bottom:8px">手机扫码,或浏览器输入下方地址:</div>' +
          '<div id="rc-url" style="font-size:15px;color:var(--acc);word-break:break-all;user-select:all"></div>' +
          '<div class="hint" style="margin-top:10px">手机端可控制:播放/暂停、快进快退、拖进度、音量、倍速、选集、全屏、关闭播放器</div></div></div>');
        body.appendChild(box);
        fetch((location.protocol === 'file:' ? 'http://127.0.0.1:9978' : '') + '/rc/info').then(r => r.json()).then(info => {
          const url = info.url || '';
          body.querySelector('#rc-url').textContent = url;
          body.querySelector('#rc-qr').src = 'https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=' + encodeURIComponent(url);
        }).catch(() => { body.querySelector('#rc-url').textContent = '获取失败(服务未运行?)'; });
      };
      quick.appendChild(qRc);
      body.appendChild(quick);
      const isMSE = !!hls;
      const isHlsUrl = state && state.groups[state.groupIndex] && /m3u8/i.test(state.groups[state.groupIndex].eps[state.epIndex].url);

      if (isMSE && hls.levels && hls.levels.length > 1) {
        body.appendChild(el('<div class="d-group">画质(' + hls.levels.length + '档)</div>'));
        const grid = el('<div class="ep-grid"></div>');
        const auto = el('<button class="ep' + (hls.autoLevelEnabled ? ' current' : '') + '" data-f tabindex="-1">自动</button>');
        auto.onclick = function () { hls.currentLevel = -1; render(body); };
        grid.appendChild(auto);
        hls.levels.forEach(function (lv, i) {
          const label = (lv.height ? lv.height + 'p' : Math.round(lv.bitrate / 1000) + 'kbps');
          const b = el('<button class="ep' + (!hls.autoLevelEnabled && hls.currentLevel === i ? ' current' : '') + '" data-f tabindex="-1">' + label + '</button>');
          b.onclick = function () { hls.currentLevel = i; if (window.toast) toast('画质锁定:' + label); render(body); };
          grid.appendChild(b);
        });
        body.appendChild(grid);
      } else if (isMSE) {
        body.appendChild(el('<div class="d-group">画质</div>'));
        body.appendChild(el('<div class="hint">该流为单码率,无画质切换</div>'));
      } else if (isHlsUrl) {
        body.appendChild(el('<div class="d-group">画质</div>'));
        body.appendChild(el('<div class="hint">当前为原生HLS内核,由系统解码器自适应</div>'));
      }

      if (isMSE && hls.audioTracks && hls.audioTracks.length) {
        body.appendChild(el('<div class="d-group">音轨</div>'));
        const grid = el('<div class="ep-grid"></div>');
        hls.audioTracks.forEach(function (t, i) {
          const b = el('<button class="ep' + (hls.audioTrack === i ? ' current' : '') + '" data-f tabindex="-1">' + (t.name || t.lang || ('音轨' + (i + 1))) + '</button>');
          b.onclick = function () { hls.audioTrack = i; if (window.toast) toast('音轨:' + (t.name || t.lang || i)); render(body); };
          grid.appendChild(b);
        });
        body.appendChild(grid);
      }

      if (isMSE && hls.subtitleTracks && hls.subtitleTracks.length) {
        body.appendChild(el('<div class="d-group">字幕(内嵌)</div>'));
        const grid = el('<div class="ep-grid"></div>');
        const off = el('<button class="ep' + (hls.subtitleTrack === -1 ? ' current' : '') + '" data-f tabindex="-1">关闭</button>');
        off.onclick = function () { hls.subtitleDisplay = false; hls.subtitleTrack = -1; render(body); };
        grid.appendChild(off);
        hls.subtitleTracks.forEach(function (t, i) {
          const b = el('<button class="ep' + (hls.subtitleTrack === i ? ' current' : '') + '" data-f tabindex="-1">' + (t.name || t.lang || ('字幕' + (i + 1))) + '</button>');
          b.onclick = function () { hls.subtitleDisplay = true; hls.subtitleTrack = i; if (window.toast) toast('字幕:' + (t.name || t.lang || i)); render(body); };
          grid.appendChild(b);
        });
        body.appendChild(grid);
      }

      if (isHlsUrl) {
        /* 播放内核(偏好持久化,全局生效) */
        body.appendChild(el('<div class="d-group">播放内核</div>'));
        const grid = el('<div class="ep-grid"></div>');
        const native = video ? video.canPlayType('application/vnd.apple.mpegurl') : '';
        const curMode = state.engineMode || DB.getConfig().kernel || 'auto';
        const mk = function (label, mode, ok, note) {
          const b = el('<button class="ep' + (curMode === mode ? ' current' : '') + (ok ? '' : ' watched') + '" data-f tabindex="-1" title="' + (note || '') + '">' + label + '</button>');
          b.onclick = function () {
            if (!ok) { if (window.toast) toast(note || '当前浏览器不支持'); return; }
            state.engineMode = mode;
            DB.setConfig({ kernel: mode });   // 记为全局默认
            closePanels();
            loadEpisode(state.groupIndex, state.epIndex);
          };
          grid.appendChild(b);
        };
        mk('自动', 'auto', true, '优先EXO内核,按需回退');
        mk('EXO内核', 'mse', !!(window.Hls && Hls.isSupported()), 'MSE分层加载,对网络流适应性最好(推荐)');
        mk('系统内核', 'native', native === 'probably', '系统播放器(仅Safari等真支持时可选)');
        body.appendChild(grid);

        /* 解码方式(硬解优先;老电视黑屏时切软解兼容) */
        body.appendChild(el('<div class="d-group">解码方式</div>'));
        const dg = el('<div class="ep-grid"></div>');
        const curDec = state.decodeMode || DB.getConfig().decodeMode || 'hw';
        const dk = function (label, mode, note) {
          const b = el('<button class="ep' + (curDec === mode ? ' current' : '') + '" data-f tabindex="-1" title="' + note + '">' + label + '</button>');
          b.onclick = function () {
            state.decodeMode = mode;
            DB.setConfig({ decodeMode: mode });
            if (window.toast) toast(mode === 'hw' ? '已切换硬件解码' : '已切换软解兼容模式');
            closePanels();
            loadEpisode(state.groupIndex, state.epIndex);
          };
          dg.appendChild(b);
        };
        dk('硬解(推荐)', 'hw', '硬件解码,发热小且流畅');
        dk('软解兼容', 'sw', '关闭解码线程+小缓冲,老设备黑屏时用');
        body.appendChild(dg);

        /* 音画同步修复 */
        const fixAv = el('<button class="ep" style="width:100%;margin-top:6px" data-f tabindex="-1">🔧 音画不同步?点此修复</button>');
        fixAv.onclick = function () {
          if (hls) { try { hls.recoverMediaError(); } catch (_e) {} }
          if (video.buffered.length) {
            try { video.currentTime = video.buffered.start(0) + 0.1; } catch (_e) {}
          }
          video.play().catch(() => {});
          if (window.toast) toast('已重挂解码器并校准时间轴');
        };
        body.appendChild(fixAv);
        body.appendChild(el('<div class="hint">黑屏/卡顿:先试「软解兼容」;网络流建议用 EXO 内核;片头跳过在「设置」页配置。</div>'));
      }

      /* 字幕 */
      const subList = subTrackList();
      if (subList.length || (state.subs && state.subs.length)) {
        body.appendChild(el('<div class="d-group">字幕</div>'));
        const sg = el('<div class="ep-grid"></div>');
        const offB = el('<button class="ep" data-f tabindex="-1">关闭</button>');
        offB.onclick = function () { subList.forEach(function (t) { t.track.mode = 'hidden'; }); render(body); };
        sg.appendChild(offB);
        subList.forEach(function (t, i) {
          const b = el('<button class="ep' + (t.track.mode === 'showing' ? ' current' : '') + '" data-f tabindex="-1">' + t.name + '</button>');
          b.onclick = function () {
            subList2 = subTrackList();
            subList2.forEach(function (x, xi) { x.track.mode = (xi === i ? 'showing' : 'hidden'); });
            render(body);
          };
          sg.appendChild(b);
        });
        const loadB = el('<button class="ep" data-f tabindex="-1">📂 加载字幕文件</button>');
        loadB.onclick = function () {
          const inp = el('<input type="file" accept=".srt,.vtt,.ass,.ssa,text/plain" style="display:none">');
          inp.onchange = function () {
            const f = inp.files[0];
            if (!f) return;
            f.arrayBuffer().then(function (buf) {
              const text = window.Subtitles.decodeSmart(buf);
              const cues = window.Subtitles.parse(text, f.name);
              if (!cues.length) { if (window.toast) toast('字幕解析失败(格式不支持)'); return; }
              let track = null;
              for (let i = 0; i < video.textTracks.length; i++) {
                if (video.textTracks[i].label === f.name) { track = video.textTracks[i]; break; }
              }
              if (!track) {
                track = video.addTextTrack('subtitles', f.name, 'zh');
                cues.forEach(function (c) { try { track.addCue(new VTTCue(c.start, c.end, c.text)); } catch (e) {} });
              }
              track.mode = 'showing';
              if (window.toast) toast('字幕已加载:' + f.name);
              render(body);
            });
          };
          inp.click();
        };
        sg.appendChild(loadB);
        body.appendChild(sg);
        body.appendChild(el('<div class="hint">音轨切换:HLS 流的多音轨支持;纯 MP4 的内封多音轨浏览器暂不支持切换。</div>'));
      }

      /* ============ 在线字幕(SubHD) + 时间轴 Offset + 样式 ============ */
      body.appendChild(el('<div class="d-group">在线字幕 · 时间轴 · 样式</div>'));
      const og = el('<div class="ep-grid"></div>');
      const onlB = el('<button class="ep" data-f tabindex="-1">🌐 在线字幕搜索</button>');
      onlB.onclick = function () { renderOnlineSubs(body); };
      og.appendChild(onlB);
      const mko = function (label, d, title) {
        const b = el('<button class="ep" data-f tabindex="-1" title="' + (title || '') + '">' + label + '</button>');
        b.onclick = function () { shiftSubOffset(d); };
        og.appendChild(b);
      };
      mko('⏱ 字幕提前0.5s', -0.5, '字幕比台词快半拍时点此');
      mko('⏱ 字幕延迟+0.5s', 0.5, '字幕比台词慢半拍时点此');
      mko('↺ Offset归零', 'reset', '重新加载本集恢复原始时间轴');
      body.appendChild(og);

      /* 字幕样式:字号/描边/背景 */
      const stRow = el('<div class="ep-grid" style="margin-top:6px"></div>');
      (function () {
        const st = subStyle();
        const bs = el('<button class="ep" data-f tabindex="-1">字号 ' + st.scale + 'x(点切换)</button>');
        bs.onclick = function () { const s = DB.getConfig().subStyle || {}; const seq = [0.7, 1, 1.3, 1.6, 2]; s.scale = seq[(seq.indexOf(s.scale || 1) + 1) % seq.length]; DB.setConfig({ subStyle: s }); enableSubOverlay(); applySubStyle(); render(body); };
        stRow.appendChild(bs);
        const bt = el('<button class="ep" data-f tabindex="-1">描边 ' + st.stroke + 'px(点切换)</button>');
        bt.onclick = function () { const s = DB.getConfig().subStyle || {}; const seq = [0, 1, 2, 3, 4]; s.stroke = seq[(seq.indexOf(s.stroke === undefined ? 2 : s.stroke) + 1) % seq.length]; DB.setConfig({ subStyle: s }); enableSubOverlay(); applySubStyle(); render(body); };
        stRow.appendChild(bt);
        const bg = el('<button class="ep" data-f tabindex="-1">背景 ' + Math.round(st.bg * 100) + '%(点切换)</button>');
        bg.onclick = function () { const s = DB.getConfig().subStyle || {}; const seq = [0, 0.25, 0.45, 0.7]; const cur = s.bg === undefined ? 0.35 : s.bg; s.bg = seq[(seq.indexOf(cur) + 1) % seq.length] || 0; DB.setConfig({ subStyle: s }); enableSubOverlay(); applySubStyle(); render(body); };
        stRow.appendChild(bg);
      })();
      body.appendChild(stRow);
      body.appendChild(el('<div class="hint">在线字幕来自 SubHD(简体/繁体/双语/特效字幕,支持 SRT/ASS);时间轴微调对当前集立即生效;样式对所有外挂字幕生效并记忆。</div>'));

      /* 在线字幕搜索面板 */
      function renderOnlineSubs(box2) {
        box2.innerHTML = '';
        box2.appendChild(el('<div class="d-group">在线字幕(SubHD)</div>'));
        const epName = (state.groups[state.groupIndex].eps[state.epIndex] || {}).name || state.name || '';
        const kw0 = epName.replace(/\.(mp4|mkv|ts|m2ts|avi|webm|flv)$/i, '').replace(/[._\[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
        const bar = el('<div class="search-bar" style="display:flex;gap:8px;margin-bottom:10px"><input class="inp" value="' + kw0.replace(/"/g, '') + '" placeholder="片名或版本关键词" style="flex:1"><button class="ep" data-f tabindex="-1">搜索</button></div>');
        const listBox = el('<div></div>');
        const doSearch = function () {
          const kw = bar.querySelector('input').value.trim();
          if (!kw) return;
          listBox.innerHTML = UI.spinner();
          const SRV = location.protocol === 'file:' ? 'http://127.0.0.1:9978' : '';
          fetch(SRV + '/sub/search?kw=' + encodeURIComponent(kw)).then(r => r.json()).then(d => {
            listBox.innerHTML = '';
            if (d.error) { listBox.appendChild(el('<div class="hint">' + d.error + '</div>')); return; }
            if (!d.list.length) { listBox.appendChild(el('<div class="hint">没有找到字幕,换个关键词试试(建议用片名)</div>')); return; }
            const grid = el('<div class="ep-grid"></div>');
            d.list.slice(0, 24).forEach(function (it) {
              const b = el('<button class="ep" style="text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" data-f tabindex="-1" title="' + (it.lang + ' ' + it.fmt) + '">' +
                (it.name.slice(0, 36)) + ' · ' + (it.lang || '?') + (it.fmt ? ' ' + it.fmt : '') + '</button>');
              b.onclick = function () {
                b.textContent = '下载中…';
                fetch(SRV + '/sub/down?id=' + it.id).then(r => {
                  if (!r.ok) return r.json().then(j => { throw new Error(j.error || '下载失败'); });
                  return r.arrayBuffer();
                }).then(buf => {
                  const text = window.Subtitles.decodeSmart(buf);
                  const cues = window.Subtitles.parse(text, it.name);
                  if (!cues.length) throw new Error('字幕解析失败');
                  attachSub(it.name.slice(0, 24), cues);
                  render(body);
                }).catch(e => { if (window.toast) toast('字幕下载失败:' + (e.message || e)); b.textContent = '重试 ' + it.name.slice(0, 20); });
              };
              grid.appendChild(b);
            });
            listBox.appendChild(grid);
          }).catch(e => { listBox.innerHTML = ''; listBox.appendChild(el('<div class="hint">搜索失败:' + (e.message || e) + '</div>')); });
        };
        bar.querySelector('button').onclick = doSearch;
        bar.querySelector('input').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
        box2.appendChild(bar);
        box2.appendChild(listBox);
        const back = el('<button class="ep" data-f tabindex="-1">← 返回设置</button>');
        back.onclick = function () { render(body); };
        box2.appendChild(back);
        KeyNav.focusFirst(box2);
      }

      /* 弹幕 */
      ensureDanmaku();
      if (window.Danmaku) {
        body.appendChild(el('<div class="d-group">弹幕</div>'));
        const dg = el('<div class="ep-grid"></div>');
        const savedDm = JSON.parse(localStorage.getItem('tvw_danmaku') || '{"on":true,"opacity":0.85,"fontScale":1}');
        const onB = el('<button class="ep' + (dm.state.on ? ' current' : '') + '" data-f tabindex="-1">' + (dm.state.on ? '弹幕 开' : '弹幕 关') + '</button>');
        onB.onclick = function () { dm.setOn(!dm.state.on); saveDm(); render(body); };
        dg.appendChild(onB);
        /* 在线弹幕:按当前文件名从弹幕接口拉取(接口在「设置」页配置) */
        const dmoB = el('<button class="ep" data-f tabindex="-1">🌐 在线弹幕</button>');
        dmoB.onclick = function () {
          dmoB.textContent = '匹配中…';
          const epName = ((state.groups[state.groupIndex].eps[state.epIndex] || {}).name || '') + '';
          Danmaku.fetchOnline(epName).then(function (r) {
            if (!r.items.length) throw new Error('接口没有返回弹幕');
            dm.setItems(r.items);
            dm.setOn(true);
            if (window.toast) toast('弹幕已加载:' + (r.matched || r.items.length + ' 条'));
            render(body);
          }).catch(function (e) {
            dmoB.textContent = '🌐 在线弹幕(重试)';
            if (window.toast) toast('弹幕获取失败:' + (e.message || e));
          });
        };
        dg.appendChild(dmoB);
        [[0.5, '淡'], [0.85, '标准'], [1, '浓']].forEach(function (pair) {
          const cur = Math.abs(dm.state.opacity - pair[0]) < 0.05;
          const b = el('<button class="ep' + (cur ? ' current' : '') + '" data-f tabindex="-1">透明 ' + pair[1] + '</button>');
          b.onclick = function () { dm.setOpacity(pair[0]); saveDm(); render(body); };
          dg.appendChild(b);
        });
        [[0.8, '小'], [1, '中'], [1.3, '大']].forEach(function (pair) {
          const cur = Math.abs(dm.state.fontScale - pair[0]) < 0.05;
          const b = el('<button class="ep' + (cur ? ' current' : '') + '" data-f tabindex="-1">' + pair[1] + '字</button>');
          b.onclick = function () { dm.setFontScale(pair[0]); saveDm(); render(body); };
          dg.appendChild(b);
        });
        const fileB = el('<button class="ep" data-f tabindex="-1">📂 加载弹幕文件(XML)</button>');
        fileB.onclick = function () {
          const inp = el('<input type="file" accept=".xml,text/xml" style="display:none">');
          inp.onchange = function () {
            const f = inp.files[0];
            if (!f) return;
            const r = new FileReader();
            r.onload = function () {
              try {
                dm.setItems(window.Danmaku.parseXML(r.result));
                const sv = JSON.parse(localStorage.getItem('tvw_danmaku') || '{}');
                sv.text = r.result; sv.on = true;
                localStorage.setItem('tvw_danmaku', JSON.stringify(sv));
                dm.setOn(true);
                if (window.toast) toast('弹幕已加载:' + f.name);
                render(body);
              } catch (e) { if (window.toast) toast('弹幕解析失败:' + e.message); }
            };
            r.readAsText(f, 'utf-8');
          };
          inp.click();
        };
        dg.appendChild(fileB);
        body.appendChild(dg);
        body.appendChild(el('<div class="hint">弹幕文件:B站格式 XML(弹弹play 兼容),加载后本片自动记忆</div>'));
      }

      body.appendChild(el('<div class="d-group">倍速</div>'));
      const sg = el('<div class="ep-grid"></div>');
      const curRate = video ? video.playbackRate : 1;
      SPEEDS.forEach(function (v) {
        const b = el('<button class="ep' + (Math.abs(curRate - v) < 0.01 ? ' current' : '') + '" data-f tabindex="-1">' + v + 'x</button>');
        b.onclick = function () { if (video) video.playbackRate = v; const rb = root.querySelector('[data-act="speed"]'); if (rb) rb.textContent = '倍速 x' + v; render(body); };
        sg.appendChild(b);
      });
      body.appendChild(sg);

      body.appendChild(el('<div class="d-group">画面比例</div>'));
      const rg = el('<div class="ep-grid"></div>');
      const curR = (state && state.ratio) || 'contain';
      RATIOS.forEach(function (pair) {
        const b = el('<button class="ep' + (curR === pair[0] ? ' current' : '') + '" data-f tabindex="-1">' + pair[1] + '</button>');
        b.onclick = function () { state.ratio = pair[0]; applyRatio(); render(body); };
        rg.appendChild(b);
      });
      body.appendChild(rg);
      body.appendChild(el('<div class="d-group">画面缩放(裁掉片源自带边框)</div>'));
      const zg = el('<div class="ep-grid"></div>');
      const curZ = (state && state.zoom) || 1;
      ZOOMS.forEach(function (z) {
        const b = el('<button class="ep' + (Math.abs(curZ - z) < 0.01 ? ' current' : '') + '" data-f tabindex="-1">' + Math.round(z * 100) + '%</button>');
        b.onclick = function () { setZoom(z); render(body); };
        zg.appendChild(b);
      });
      body.appendChild(zg);

      const mark = DB.getMark(state.key) || {};
      body.appendChild(el('<div class="d-group">片头片尾(自动跳过)</div>'));
      const ig = el('<div class="ep-grid"></div>');
      const mI = el('<button class="ep" data-f tabindex="-1">' + (mark.intro ? '★ 片头 ' + fmt(mark.intro) : '标记当前位置为片头') + '</button>');
      mI.onclick = function () {
        if (video && video.currentTime > 5) {
          DB.setMark(state.key, { intro: Math.floor(video.currentTime) });
          if (window.toast) toast('已标记片头 ' + fmt(video.currentTime));
          render(body);
        }
      };
      const mO = el('<button class="ep" data-f tabindex="-1">' + (mark.outro ? '★ 片尾 ' + fmt(mark.outro) : '标记当前位置为片尾') + '</button>');
      mO.onclick = function () {
        if (video && isFinite(video.duration) && video.currentTime < video.duration - 20) {
          DB.setMark(state.key, { outro: Math.floor(video.currentTime) });
          if (window.toast) toast('已标记片尾,此后自动播下一集');
          render(body);
        }
      };
      const clr = el('<button class="ep' + (!mark.intro && !mark.outro ? ' watched' : '') + '" data-f tabindex="-1">清除本片标记</button>');
      clr.onclick = function () { DB.clearMark(state.key, 'intro'); DB.clearMark(state.key, 'outro'); if (window.toast) toast('已清除'); render(body); };
      ig.appendChild(mI); ig.appendChild(mO); ig.appendChild(clr);
      body.appendChild(ig);
      body.appendChild(el('<div class="hint">默认自动跳过片头:' + (DB.getConfig().skipIntroAuto ? (DB.getConfig().defaultIntroSec + '秒') : '关闭') + '(全局默认在「设置」页调整)</div>'));
    }

    render(body);
  }

  /* ---------- 卡顿/黑屏看门狗:三级自愈 ①MSE修复+跳缓冲区 ②切软解兼容 ③自动换源 ---------- */
  let stallTimer = null;
  function armStallWatchdog() {
    video.addEventListener('waiting', () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        if (!video || video.readyState >= 3 || video.paused || iframe) return;
        /* ① 解码层修复:重挂解码器 + seek 回缓冲区起点(治 PTS 偏移/解码器卡死) */
        if (!state._stallHealed && hls) {
          state._stallHealed = true;
          try { hls.recoverMediaError(); } catch (_e) {}
          if (video.buffered.length) { try { video.currentTime = video.buffered.start(0) + 0.1; } catch (_e) {} }
          video.play().catch(() => {});
          if (window.toast) toast('检测到卡顿,已尝试解码修复…');
          return;
        }
        /* ② 硬解卡死 → 本次会话自动切软解兼容模式重载 */
        const curDec = state.decodeMode || DB.getConfig().decodeMode || 'hw';
        if (hls && curDec === 'hw') {
          state.decodeMode = 'sw';
          state._stallHealed = false;
          if (window.toast) toast('已自动切换软解兼容模式');
          loadEpisode(state.groupIndex, state.epIndex);
          return;
        }
        /* ③ 兜底:自动换源 */
        maybeAutoSwitch('播放卡顿');
      }, 15000);
    });
    ['playing', 'canplay', 'timeupdate'].forEach(n => video.addEventListener(n, () => clearTimeout(stallTimer)));
  }

  /* ---------- 横排面板(选集/设置/换源):一排横向选项,非抽屉 ---------- */
  function closePanels() {
    ['.pl-strip', '.pl-drawer'].forEach(function (sel) {
      const elx = root.querySelector(sel);
      if (elx) { if (elx.__cleanup) elx.__cleanup(); elx.remove(); }
    });
    KeyNav.setModal(false);
  }

  /* ---------- 选集(横排) ---------- */
  function toggleDrawer() {
    const old = root.querySelector('.pl-strip');
    if (old && old.dataset.kind === 'eps') { closePanels(); wake(); return; }
    closePanels(); wake();
    const d = el(`<div class="pl-strip" data-kind="eps"><div class="d-body"></div></div>`);
    const body = d.querySelector('.d-body');
    state.groups.forEach((g, gi) => {
      const gh = el(`<div class="d-group">${g.name}</div>`);
      body.appendChild(gh);
      g.eps.forEach((ep, ei) => {
        const b = el(`<button class="ep" data-f tabindex="-1">${ep.name}</button>`);
        if (gi === state.groupIndex && ei === state.epIndex) b.classList.add('current');
        b.onclick = () => { closePanels(); loadEpisode(gi, ei); };
        body.appendChild(b);
      });
    });
    root.appendChild(d);
    KeyNav.setModal(true);
    wake();
    const cur = d.querySelector('.ep.current');
    if (cur) { cur.focus(); cur.scrollIntoView({ inline: 'center', block: 'nearest' }); }
  }

  /* ---------- 换源面板 ---------- */
  function toggleSourcePanel() {
    if (!state.onFindSources || !state.onPlayFromSource) { toast && toast('该播放内容不支持换源'); return; }
    const old = root.querySelector('.pl-strip');
    if (old && old.dataset.kind === 'src') { closePanels(); wake(); return; }
    closePanels(); wake();
    const d = el(`<div class="pl-strip" data-kind="src"><div class="d-body">${UI.spinner()}</div></div>`);
    root.appendChild(d);
    KeyNav.setModal(true);
    state.onFindSources().then(list => {
      const body = d.querySelector('.d-body');
      if (!document.body.contains(d)) return;
      if (!list || !list.length) {
        body.innerHTML = '<div class="d-group">其他源暂无同名影片,可尝试搜索页全网搜索</div>';
        return;
      }
      body.innerHTML = '';
      const closeChip = el('<button class="ep" data-f tabindex="-1" title="关闭">✕</button>');
      closeChip.onclick = () => { closePanels(); wake(); };
      body.appendChild(closeChip);
      list.forEach(it => {
        const b = el(`<button class="ep${it.srcId === state.sourceId ? ' current' : ''}" data-f tabindex="-1">${it.srcName} · ${it.remarks || '直链'} · ${it.ms}ms</button>`);
        b.onclick = () => { closePanels(); state.onPlayFromSource(it, state.epIndex); };
        body.appendChild(b);
      });
      KeyNav.focusFirst(d);
    });
  }

  /* ---------- 失败自动换源(返回 true 表示已接管) ---------- */
  function maybeAutoSwitch(err) {
    const reason = '加载失败' + (err && err.message ? '(' + err.message + ')' : '');
    if (!state || iframe || state.switching) return false;
    if (!DB.getConfig().autoSwitch) return false;
    if (!state.onFindSources || !state.onPlayFromSource) return false;
    state.tried = state.tried || [];
    if (state.tried.length >= 3) { showCenter(`<div class="pl-msg">${reason},自动换源已达上限,可手动「🔀 换源」</div>`); return true; }
    state.switching = true;
    showCenter(`<div class="pl-msg">${reason},正在自动换源…</div>`);
    state.onFindSources().then(list => {
      state.switching = false;
      if (!state || !document.getElementById('player')) return;
      const next = list.find(x => !state.tried.includes(x.srcId) && x.srcId !== state.sourceId);
      if (!next) { state.switching = false; showCenter(`<div class="pl-msg">${reason} · 其他源暂无同名影片</div>`); return; }
      state.tried.push(next.srcId);
      toast && toast('自动换源 → ' + next.srcName);
      state.onPlayFromSource(next, state.epIndex, state.tried.slice());
    }).catch(() => { state.switching = false; });
    return true;
  }

  /* ---------- 底层嗅探:打开网页,捕获媒体直链 ---------- */
  function currentEpUrl() {
    const g = state.groups[state.groupIndex];
    return g && g.eps[state.epIndex] ? g.eps[state.epIndex].url : '';
  }
  function toggleSniff() {
    if (API.IN_APP) { toast && toast('嗅探依赖本地代理,App 内暂不支持'); return; }
    const old = root.querySelector('.pl-drawer');
    if (old) { if (old.__cleanup) old.__cleanup(); old.remove(); KeyNav.setModal(false); return; }
    const epUrl = currentEpUrl();
    const d = el(`<div class="pl-drawer"><div class="d-head">🔍 嗅探直链</div><div class="d-body"></div></div>`);
    const body = d.querySelector('.d-body');
    root.appendChild(d);
    KeyNav.setModal(true);
    if (/\.(m3u8|mp4|mkv|webm|flv|avi|mov|ts)(\?|$)/i.test(epUrl)) {
      body.innerHTML = '<div class="empty" style="padding:26px 0">当前已是媒体直链,无需嗅探</div>';
      setTimeout(() => { if (document.body.contains(d)) { if (d.__cleanup) d.__cleanup(); d.remove(); KeyNav.setModal(false); } }, 1500);
      return;
    }
    body.innerHTML = `<div class="spinner"></div><div class="pl-msg">后台加载网页中,自动捕获 m3u8/mp4 直链…</div>`;
    const frame = el('<iframe style="position:absolute;inset:0;width:100%;height:100%;border:0;background:#111" referrerpolicy="no-referrer"></iframe>');
    frame.src = '/sniff/' + epUrl;
    root.insertBefore(frame, root.querySelector('.pl-top'));
    const found = [];
    const onMsg = e => {
      if (e.data && e.data.__tvsniff && e.data.url && !found.includes(e.data.url)) {
        found.push(e.data.url); render();
        // 智能模式:发现直链后自动择优直连(m3u8 优先)
        if (DB.getConfig().sniffAuto !== false && !state._sniffAutoPlayed) {
          state._sniffAutoPlayed = true;
          setTimeout(() => {
            if (!document.body.contains(d)) return;
            const best = found.find(u => /\.m3u8/i.test(u)) || found.find(u => /\.(mp4|mkv)/i.test(u)) || found[0];
            if (best) { if (window.toast) toast('智能嗅探已捕获直链,自动播放'); playSniffed(best); }
          }, 5000);
        }
      }
    };
    window.addEventListener('message', onMsg);
    function render() {
      if (!document.body.contains(d)) return;
      body.innerHTML = '';
      if (!found.length) { body.innerHTML = '<div class="empty" style="padding:24px 0">尚未捕获到直链,继续等待…</div>'; return; }
      body.innerHTML = `<div class="d-group">捕获 ${found.length} 条,点击直连播放</div>`;
      const rows = el('<div class="list-rows" style="max-width:none"></div>');
      found.forEach(u => {
        const row = el(`<div class="list-row" data-f tabindex="-1">
          <span style="font-size:22px">🎞️</span>
          <div class="li-main"><div class="li-name">${u.split('?')[0].split('/').pop().slice(0, 42) || '(直链)'}</div><div class="li-sub">${u.slice(0, 64)}</div></div>
          <div class="li-ops"><button class="mini-btn">▶ 播放</button></div>
        </div>`);
        row.onclick = () => playSniffed(u);
        rows.appendChild(row);
      });
      body.appendChild(rows);
      KeyNav.focusFirst(d);
    }
    // 兜底:同源页面可直接读取钩子收集结果
    const poll = setInterval(() => {
      try {
        const arr = frame.contentWindow.__tvsniffed || [];
        arr.forEach(u => { if (!found.includes(u)) { found.push(u); render(); } });
      } catch {}
      if (!document.body.contains(d)) clearInterval(poll);
    }, 2500);
    function close() {
      clearInterval(poll);
      window.removeEventListener('message', onMsg);
      frame.remove();
    }
    d.__cleanup = close;
    function playSniffed(u) {
      close();
      if (d.parentNode) { d.remove(); KeyNav.setModal(false); }
      destroyEngine();
      video.style.display = '';
      video.src = DB.getConfig().proxyMode ? API.proxied(u) : u;
      video.load();
      video.play().catch(() => {});
      toast && toast('已切换为嗅探到的直链播放');
    }
  }

  /* ---------- 进度与历史 ---------- */
  function onTime() {
    lastPos = video.currentTime; lastDur = video.duration || 0;
    try { onTimeExtra(); } catch (_e) {}
    root.querySelector('#pl-cur').textContent = fmt(video.currentTime);
    root.querySelector('#pl-dur').textContent = fmt(video.duration);
    if (isFinite(video.duration) && video.duration > 0) {
      root.querySelector('.pl-track .fill').style.width = (video.currentTime / video.duration * 100) + '%';
      try {
        if (video.buffered.length) {
          const end = video.buffered.end(video.buffered.length - 1);
          root.querySelector('.pl-buf').style.width = (end / video.duration * 100) + '%';
        }
      } catch (_e) {}
    }
  }
  function saveProgress() {
    if (!state || !video || iframe) return;
    if (lastDur > 0 && lastPos > 3) {
      DB.updateProgress(state.key, state.epIndex, lastPos, lastDur);
      DB.saveHist({
        key: state.key, name: state.name, pic: state.pic || '', from: state.fromName || '',
        epIndex: state.epIndex, epName: currentEpName(), position: lastPos, duration: lastDur,
        sourceId: state.sourceId, vodId: state.vodId,
      });
    }
  }
  function currentEpName() {
    const g = state.groups[state.groupIndex];
    return g && g.eps[state.epIndex] ? g.eps[state.epIndex].name : '';
  }

  /* ---------- 收藏 ---------- */
  function updateFavBtn() {
    const b = root.querySelector('[data-act="favors"]');
    if (b) b.textContent = (state && DB.isFav(state.key)) ? '★ 已收藏' : '♡ 收藏';
  }
  function toggleFavBtn(btn) {
    const added = DB.toggleFav({ key: state.key, name: state.name, pic: state.pic || '', sourceId: state.sourceId, vodId: state.vodId });
    btn.textContent = added ? '★ 已收藏' : '♡ 收藏';
    toast && toast(added ? '已加入收藏' : '已取消收藏');
  }
  function setTitle() {
    const g = state.groups[state.groupIndex];
    const epn = g && g.eps[state.epIndex] ? g.eps[state.epIndex].name : '';
    root.querySelector('.t-name').textContent = state.title || '';
    root.querySelector('.t-ep').textContent = epn ? '· ' + epn : '';
  }

  /* ---------- 快捷键 ---------- */
  function playerKeys(e) {
    if (!root) return;
    poke();
    const k = e.key;
    if (k === 'Escape' || k === 'Backspace') { e.preventDefault(); exit(); }
    else if (k === ' ' || k === 'Enter') { e.preventDefault(); togglePlay(); }
    else if (k === 'ArrowLeft') { e.preventDefault(); seekBy(-SEEK); }
    else if (k === 'ArrowRight') { e.preventDefault(); seekBy(SEEK); }
    else if (k === 'ArrowUp') { e.preventDefault(); video.volume = Math.min(1, video.volume + 0.1); poke(); }
    else if (k === 'ArrowDown') { e.preventDefault(); video.volume = Math.max(0, video.volume - 0.1); poke(); }
    else if (k === 'f' || k === 'F') toggleFs();
    else if (k === 'e' || k === 'E') toggleDrawer();
    else if (k === 's' || k === 'S') toggleSourcePanel();
    else if (k === 'n' || k === 'N') switchEp(1);
  }

  /* ---------- OSD 唤出与自动渐隐(拖动进度/抽屉打开时暂停计时) ---------- */
  function setBarsHidden(hidden) {
    ['.pl-top', '.pl-bottom'].forEach(sel => {
      const el = root.querySelector(sel);
      if (el) el.classList.toggle('pl-hide', hidden);
    });
  }
  function barsHidden() {
    const top = root.querySelector('.pl-top');
    return top && top.classList.contains('pl-hide');
  }
  function hidePaused() {
    return state.scrubbing || !!root.querySelector('.pl-strip') || !!root.querySelector('.pl-drawer') || !video || video.paused;
  }
  function wake() {
    setBarsHidden(false);
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (!hidePaused()) setBarsHidden(true);
      else if (hidePaused() && !state.scrubbing) wake(); // 抽屉开着:挂起,关抽屉后重新计时
    }, 4000);
  }
  function poke() { wake(); }

  /* ---------- 退出 ---------- */
  function exit() {
    saveProgress();
    destroyEngine();
    rcStop();
    try { fetch(RC_SRV + '/rc/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ended: true }) }).catch(() => {}); } catch (e) {}
    if (dm) { try { dm.destroy(); } catch (_e) {} dm = null; }
    subsLoading = false;
    window.removeEventListener('beforeunload', saveProgress);
    clearTimeout(stallTimer);
    ['.pl-strip', '.pl-drawer'].forEach(function (sel) {
      const elx = root && root.querySelector(sel);
      if (elx && elx.__cleanup) elx.__cleanup();
    });
    document.removeEventListener('keydown', playerKeys, true);
    document.removeEventListener('mousemove', poke);
    clearInterval(saveTimer);
    KeyNav.setPlayer(false);
    if (root.querySelector('.pl-drawer')) KeyNav.setModal(false);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    root.remove(); root = null; video = null;
    state && state.onClose && state.onClose();
  }
  function close(silent) { if (root) exit(); else if (silent) {} }

  function isOpen() { return !!root; }

  return { open, close, isOpen };
})();
