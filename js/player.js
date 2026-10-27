/* ================= 播放器组件 =================
 * Player.open({ title, groups, groupIndex, epIndex, key, onClose })
 *  - groups: API.parsePlay 的结果 [{name, eps:[{name,url}]}]
 *  - key: 历史/续播键 (sourceId|vodId)
 * 支持: HLS(m3u8, hls.js)/MP4/iframe 兜底、断点续播、选集、倍速、快捷键
 * ================================================= */
const Player = (() => {
  let root = null, video = null, hls = null, iframe = null;
  const sniffCache = {};   // 分享页 → 直链 的缓存(同一站点的多集共用一次解析)
  let state = null; // 当前播放状态
  let saveTimer = null, hideTimer = null;
  let lastPos = 0, lastDur = 0;

  const SEEK = 15;

  function el(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; }

  /* SVG 矢量图标(跨平台一致) */
  const I = {"back": "<svg viewBox=\"0 0 24 24\" width=\"22\" height=\"22\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M19 12H5\"/><path d=\"M12 19l-7-7 7-7\"/></svg>", "fav": "<svg viewBox=\"0 0 24 24\" width=\"20\" height=\"20\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"><path d=\"M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z\"/></svg>", "favOn": "<svg viewBox=\"0 0 24 24\" width=\"20\" height=\"20\" fill=\"currentColor\" stroke=\"currentColor\" stroke-width=\"2\"><path d=\"M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z\"/></svg>", "rew": "<svg viewBox=\"0 0 24 24\" width=\"22\" height=\"22\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M11 17l-5-5 5-5\"/><path d=\"M18 17l-5-5 5-5\"/></svg>", "play": "<svg viewBox=\"0 0 24 24\" width=\"24\" height=\"24\" fill=\"currentColor\"><path d=\"M6 4l14 8-14 8z\"/></svg>", "pause": "<svg viewBox=\"0 0 24 24\" width=\"24\" height=\"24\" fill=\"currentColor\"><rect x=\"5\" y=\"4\" width=\"5\" height=\"16\" rx=\"1\"/><rect x=\"14\" y=\"4\" width=\"5\" height=\"16\" rx=\"1\"/></svg>", "ff": "<svg viewBox=\"0 0 24 24\" width=\"22\" height=\"22\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M13 17l5-5-5-5\"/><path d=\"M6 17l5-5-5-5\"/></svg>", "next": "<svg viewBox=\"0 0 24 24\" width=\"22\" height=\"22\" fill=\"currentColor\"><path d=\"M5 5l9 7-9 7z\"/><rect x=\"16\" y=\"5\" width=\"3\" height=\"14\" rx=\"1\"/></svg>", "eps": "<svg viewBox=\"0 0 24 24\" width=\"20\" height=\"20\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\"><path d=\"M8 6h13M8 12h13M8 18h13\"/><circle cx=\"4\" cy=\"6\" r=\"1.2\" fill=\"currentColor\" stroke=\"none\"/><circle cx=\"4\" cy=\"12\" r=\"1.2\" fill=\"currentColor\" stroke=\"none\"/><circle cx=\"4\" cy=\"18\" r=\"1.2\" fill=\"currentColor\" stroke=\"none\"/></svg>", "more": "<svg viewBox=\"0 0 24 24\" width=\"20\" height=\"20\" fill=\"currentColor\"><circle cx=\"5\" cy=\"12\" r=\"2\"/><circle cx=\"12\" cy=\"12\" r=\"2\"/><circle cx=\"19\" cy=\"12\" r=\"2\"/></svg>", "fs": "<svg viewBox=\"0 0 24 24\" width=\"20\" height=\"20\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M8 3H5a2 2 0 0 0-2 2v3\"/><path d=\"M16 3h3a2 2 0 0 1 2 2v3\"/><path d=\"M8 21H5a2 2 0 0 1-2-2v-3\"/><path d=\"M16 21h3a2 2 0 0 0 2-2v-3\"/></svg>", "dm": "<svg viewBox=\"0 0 24 24\" width=\"20\" height=\"20\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z\"/></svg>", "qr": "<svg viewBox=\"0 0 24 24\" width=\"20\" height=\"20\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><rect x=\"3\" y=\"3\" width=\"7\" height=\"7\" rx=\"1\"/><rect x=\"14\" y=\"3\" width=\"7\" height=\"7\" rx=\"1\"/><rect x=\"3\" y=\"14\" width=\"7\" height=\"7\" rx=\"1\"/><path d=\"M14 14h3v3h-3z\"/><path d=\"M21 14v.01\"/><path d=\"M14 21v.01\"/><path d=\"M21 21l-4-4\"/></svg>", "vol": "<svg viewBox=\"0 0 24 24\" width=\"20\" height=\"20\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M11 5 6 9H2v6h4l5 4z\"/><path d=\"M15.54 8.46a5 5 0 0 1 0 7.07\"/><path d=\"M19.07 4.93a10 10 0 0 1 0 14.14\"/></svg>", "volOff": "<svg viewBox=\"0 0 24 24\" width=\"20\" height=\"20\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M11 5 6 9H2v6h4l5 4z\"/><path d=\"m23 9-6 6\"/><path d=\"m17 9 6 6\"/></svg>", "prev": "<svg viewBox=\"0 0 24 24\" width=\"22\" height=\"22\" fill=\"currentColor\"><path d=\"M19 5l-9 7 9 7z\"/><rect x=\"4\" y=\"5\" width=\"3\" height=\"14\" rx=\"1\"/></svg>"};
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
        <div class="pl-title">
          <div class="t-row"><span class="t-name"></span><span class="t-ep"></span></div>
          <div class="pl-badges"></div>
        </div>
        <div class="pl-status">
          <span class="st-badge" id="st-qual" style="display:none"></span>
          <span class="st-badge" id="st-net" style="display:none"></span>
          <span class="st-badge" id="st-clock">--:--</span>
        </div>
      </div>
      <div class="pl-center"></div>
      <div class="pl-pausehint" style="display:none">⏸ 暂停中</div>
      <div class="pl-bottom">
        <button class="pbtn skip-intro" data-act="skipintro" style="display:none">跳过片头 ⏭</button>
        <div class="pl-seekprev" id="seekprev" style="display:none"><img id="sp-img" alt=""><span class="sp-time" id="sp-time">00:00</span></div>
        <div class="pl-time-row">
          <span class="pl-timebox"><span class="pl-time" id="pl-cur">00:00</span></span>
          <div class="pl-track" data-act="track" tabindex="-1" data-f>
            <div class="rail"><div class="pl-buf"></div><div class="fill" style="width:0%"><div class="thumb"></div></div></div>
            <div class="pl-tip" style="display:none"></div>
          </div>
          <span class="pl-timebox right"><span class="pl-time" id="pl-dur">00:00</span><span class="pl-time remain" id="pl-remain"></span></span>
        </div>
        <div class="pl-transport">
          <button class="tp-btn" data-act="prev" data-f tabindex="-1"><span class="tp-ic">${I.prev}</span><span class="tp-sub" id="tp-prev">上一集</span></button>
          <button class="tp-btn" data-act="rew" data-f tabindex="-1"><span class="tp-ic">${I.rew}</span><span class="tp-sub">15秒</span></button>
          <button class="tp-btn tp-play" data-act="play" data-f tabindex="-1">${I.pause}</button>
          <button class="tp-btn" data-act="ff" data-f tabindex="-1"><span class="tp-ic">${I.ff}</span><span class="tp-sub">15秒</span></button>
          <button class="tp-btn" data-act="next" data-f tabindex="-1"><span class="tp-ic">${I.next}</span><span class="tp-sub" id="tp-next">下一集</span></button>
        </div>
        <div class="pl-chips">
          <button class="pill" data-act="eps" data-f tabindex="-1">选集<span class="pv" id="pv-eps">-</span></button>
          <button class="pill" data-act="src" data-f tabindex="-1">换源<span class="pv" id="pv-src">-</span></button>
          <button class="pill" data-act="speed" data-f tabindex="-1">倍速<span class="pv" id="pv-speed">1x</span></button>
          <button class="pill" data-act="sub" data-f tabindex="-1">字幕<span class="pv" id="pv-sub">关</span></button>
          <button class="pill" data-act="atrack" data-f tabindex="-1" style="display:none">音轨<span class="pv" id="pv-atrack">-</span></button>
          <button class="pill" data-act="dm" data-f tabindex="-1">弹幕<span class="pv" id="pv-dm">开启</span></button>
          <button class="pill" data-act="pset" data-f tabindex="-1">更多设置<span class="pv">比例/解码</span></button>
        </div>
      </div>
    </div>`);
    document.body.appendChild(root);
    video = root.querySelector('video');
    iframe = null;

    /* 轻量状态层:时钟15秒刷新 + 网络状态 */
    if (clockTimer) clearInterval(clockTimer);
    try { spDestroy(); } catch (e) {}
    if (typeof updateStatusLayer === 'function' && updateStatusLayer._netHooked) { /* 保留全局钩子 */ }
    lastDecBytes = 0; lastDecT = 0;
    updateStatusLayer();
    clockTimer = setInterval(updateStatusLayer, 1000);
    video.addEventListener('pause', updatePauseHint);
    video.addEventListener('play', updatePauseHint);
    if (!updateStatusLayer._netHooked && navigator.connection && navigator.connection.addEventListener) {
      navigator.connection.addEventListener('change', updateStatusLayer);
      updateStatusLayer._netHooked = true;
    }
    video.addEventListener('loadedmetadata', () => { updateQualBadge(); updateAtrackLabels(); });

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
        else if (act === 'q') cycleQuality();
        else if (act === 'sub') cycleSubTrack(btn);
        else if (act === 'dm') toggleDmQuick(btn);
        else if (act === 'dec') cycleDecode();
        else if (act === 'atrack') cycleAtrack();
        else if (act === 'mute') { if (video) { video.muted = !video.muted; updateVolUI(); } }
        else if (act === 'pset') togglePset();
        else if (act === 'rcqr') { togglePset(); const rb = [...root.querySelectorAll('.pl-strip .ep')].find(x => x.textContent.includes('远程遥控')); if (rb) rb.click(); }
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
        showSeekPreview(p, e.clientX);
      }
    };
    /* 擦洗悬浮缩略图:第二路video同源解码目标帧,seeked后画到悬浮框 */
    let spv = null, spvHls = null, spCanvas = null;
    const spDestroy = () => {
      try { if (spvHls) { spvHls.destroy(); } } catch (e) {}
      spvHls = null;
      if (spv) { spv.removeAttribute('src'); try { spv.load(); } catch (e) {} spv.remove(); spv = null; }
    };
    const spEnsure = () => {
      if (spv) return true;
      const url = currentEpUrl();
      if (!url) return false;
      const u = DB.getConfig().proxyMode ? API.proxied(url) : url;
      spv = document.createElement('video');
      spv.muted = true; spv.crossOrigin = 'anonymous'; spv.preload = 'auto';
      spv.playsInline = true; spv.setAttribute('playsinline', '');
      spv.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:2px;height:2px;opacity:0;pointer-events:none';
      spCanvas = document.createElement('canvas');
      spCanvas.width = 224;
      spv.addEventListener('seeked', () => {
        try {
          if (!spv.videoWidth) return;
          spCanvas.height = Math.max(2, Math.round(224 * spv.videoHeight / spv.videoWidth));
          spCanvas.getContext('2d').drawImage(spv, 0, 0, spCanvas.width, spCanvas.height);
          const img = root.querySelector('#sp-img');
          if (img) img.src = spCanvas.toDataURL('image/jpeg', 0.55);
        } catch (e) {}
      });
      if (/\.m3u8/i.test(url) && window.Hls && Hls.isSupported()) {
        spvHls = new Hls({ maxBufferLength: 4, maxBufferSize: 20, enableWorker: true });
        spvHls.on(Hls.Events.ERROR, (evt, data) => { if (data && data.fatal) spDestroy(); });
        spvHls.loadSource(u); spvHls.attachMedia(spv);
      } else {
        spv.src = u;
      }
      document.body.appendChild(spv);
      return true;
    };
    const showSeekPreview = (p, clientX) => {
      if (iframe || !isFinite(video.duration) || video.duration <= 0) return;
      const box = root.querySelector('#seekprev');
      if (!box || !spEnsure()) return;
      const rail2 = track.querySelector('.rail').getBoundingClientRect();
      const t = Math.min(Math.max(0.1, p * video.duration), Math.max(0.1, video.duration - 0.5));
      try { spv.currentTime = t; } catch (e) {}
      box.style.display = 'block';
      const half = 116;
      box.style.left = Math.min(Math.max(clientX - half, 8), window.innerWidth - 240) + 'px';
      const lb = box.querySelector('#sp-time');
      if (lb) lb.textContent = fmt(t);
    };
    const hideSeekPreview = () => {
      const box = root.querySelector('#seekprev');
      if (box) box.style.display = 'none';
    };
    track.addEventListener('pointerdown', e => {
      scrubbing = true; state.scrubbing = true;
      track.setPointerCapture(e.pointerId);
      scrubTo(e); wake();
    });
    track.addEventListener('pointermove', e => { if (scrubbing) { scrubTo(e); wake(); } });
    track.addEventListener('pointerup', e => { if (scrubbing) { scrubTo(e); scrubbing = false; state.scrubbing = false; wake(); } hideSeekPreview(); });
    track.addEventListener('pointercancel', () => { scrubbing = false; state.scrubbing = false; wake(); hideSeekPreview(); });
    const tip = root.querySelector('.pl-tip');
    track.addEventListener('mousemove', e => {
      if (!isFinite(video.duration) || !video.duration || !tip) return;
      const rail = track.querySelector('.rail').getBoundingClientRect();
      const p = Math.min(1, Math.max(0, (e.clientX - rail.left) / rail.width));
      const t = p * video.duration;
      let label = fmt(t) + ' / ' + fmt(video.duration);
      const mark = DB.getMark(state.key) || {};
      if (mark.intro && t < mark.intro) label += ' · 片头区';
      else if (mark.outro && t > mark.outro) label += ' · 片尾区';
      if (state._resumeAt && Math.abs(t - state._resumeSec) < 15) label += ' · 上次看到';
      tip.style.display = 'block';
      tip.style.left = (p * 100) + '%';
      tip.textContent = label;
    });
    track.addEventListener('mouseleave', () => { if (tip) tip.style.display = 'none'; });
    video.addEventListener('volumechange', updateVolUI);
    video.addEventListener('loadedmetadata', () => { if (state) state._marksDone = false; updateBadges(); updateVolUI(); });

    video.addEventListener('timeupdate', onTime);
    video.addEventListener('play', updatePlayBtn);
    video.addEventListener('playing', () => {
      if (!root || !video) return;
      // 开始播放后清掉残留的失败提示
      const c = root.querySelector('.pl-center');
      if (c && c.textContent.includes('失败')) showCenter('');
    });
    video.addEventListener('pause', onPauseEv);
    window.addEventListener('beforeunload', saveProgress);
    video.addEventListener('ended', onEndedEv);
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
  /* 注意:必须用 localhost 而不是 127.0.0.1 —— Chromium 按 host 字符串分连接池(每 host 6 条),
     /rc/poll 是长轮询会长期占住连接;与 API(sniff2/proxy 等)分池,否则换源嗅探等请求会被饿死挂起 */
  const RC_SRV = location.protocol === 'file:' ? 'http://localhost:9978' : '';
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
    state._marksDone = false;
    state._resumeAt = ''; state._resumeSec = 0;
    setTitle();
    try { applyRatio(); } catch (_e) {}
    showCenter(`<div class="spinner"></div><div class="pl-msg">正在加载: ${ep.name}</div>`);
    destroyEngine();
    try { spDestroy(); } catch (e) {}

    let url = DB.getConfig().proxyMode ? API.proxied(ep.url) : ep.url;
    let isIframe = /^https?:/i.test(ep.url) && !/\.(mp4|m3u8|mkv|webm)(\?|$)/i.test(ep.url) && !/\.mp4|m3u8/.test(ep.url);
    let isHls = /\.m3u8(\?|$)/i.test(ep.url) || /m3u8/.test(ep.url);
    let isFile = /\.(mp4|webm|mkv|mov)(\?|$)/i.test(ep.url);

    try {
      if (isIframe && !isFile && !isHls) {
        /* 采集源给的常是 HTML 分享页(带广告),先让服务端把真直链抽出来;
           抽到就走正常 HLS/MP4 播放,抽不到才退回 iframe 兜底 */
        let direct = '';
        try {
          direct = sniffCache[ep.url] || '';
          if (!direct) {
            direct = await API.sniffResolve(ep.url);
            if (direct) sniffCache[ep.url] = direct;
          }
        } catch (_e) {}
        if (direct && /\.(m3u8|mp4)(\?|$)/i.test(direct)) {
          url = DB.getConfig().proxyMode ? API.proxied(direct) : direct;
          isHls = /\.m3u8(\?|$)/i.test(direct);
          isFile = !isHls;
          isIframe = false;
          if (window.toast) toast('已解析出直链,正在播放');
        } else {
          // iframe 兜底(网页播放)
          video.style.display = 'none';
          iframe = el(`<iframe allow="autoplay; fullscreen; encrypted-media" referrerpolicy="no-referrer"></iframe>`);
          iframe.src = url;
          root.insertBefore(iframe, root.querySelector('.pl-top'));
          showCenter('');
          return;
        }
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
          const seen = {};  // 同一播放列表只提示一次(直播每几秒刷新一次,避免刷屏)
          return class AdFilterLoader extends Base {
            load(context, config, callbacks) {
              if (callbacks && typeof callbacks.onSuccess === 'function') {
                const origSuccess = callbacks.onSuccess;
                callbacks.onSuccess = function (response, stats, ctx2, net) {
                  try {
                    if (response && response.data && /#EXTM3U/.test(response.data)) {
                      /* 传入播放列表自身的 URL:结构性广告检测要把相对切片解析成绝对地址后比目录 */
                      const base = (response.url) || (ctx2 && ctx2.url) || (context && context.url) || '';
                      const r = window.AdFilter.filterM3U8(response.data, base);
                      if (r.removed > 0) {
                        response.data = r.text;
                        const key = base.split('?')[0];
                        if (window.toast && !seen[key]) { seen[key] = 1; toast('已过滤 ' + r.removed + ' 个广告切片'); }
                      }
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
        hls.on(Hls.Events.LEVEL_SWITCHED, () => { updateBadges(); updateQualBadge(); });
        hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, updateAtrackLabels);
        hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, updateAtrackLabels);
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
          state._resumeAt = fmt(startAt); state._resumeSec = startAt;
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
      updateBadges();
      const rb = root.querySelector('[data-act="speed"]');
      if (rb) rb.textContent = 'x' + (video.playbackRate || 1);
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

  /* ---------- 顶部 OSD 徽章:来源 / 画质 / 解码 / 续播 ---------- */
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function updateBadges() {
    if (!root || !state || !video) return;
    const box = root.querySelector('.pl-badges');
    if (!box) return;
    const parts = [];
    const g = state.groups[state.groupIndex];
    if (g && g.name) parts.push('<span class="pb pb-src">' + esc(g.name) + '</span>');
    if (state._resumeAt) parts.push('<span class="pb pb-resume">续播 ' + esc(state._resumeAt) + '</span>');
    box.innerHTML = parts.join('');
    updateQBtn();
    updateQualBadge();
    updateDecLabels();
  }
  /* 画质快捷键:多码率循环锁档,否则进设置面板 */
  function cycleQuality() {
    if (iframe || !video) return;
    if (hls && hls.levels && hls.levels.length > 1) {
      const n = hls.levels.length;
      const order = [-1].concat(Array.from({ length: n }, (_, i) => i));
      const idx = (order.indexOf(hls.autoLevelEnabled ? -1 : hls.currentLevel) + 1) % order.length;
      hls.currentLevel = order[idx];
      const label = order[idx] === -1 ? '自动' : (hls.levels[order[idx]].height ? hls.levels[order[idx]].height + 'P' : Math.round(hls.levels[order[idx]].bitrate / 1000) + 'kbps');
      if (window.toast) toast('画质:' + label);
      updateBadges();
    } else {
      if (window.toast) toast('单码率流,无画质切换');
      togglePset();
    }
  }
  function updateQBtn() {
    const b = root && root.querySelector('[data-act="q"]');
    if (!b) return;
    if (hls && hls.levels && hls.levels.length > 1 && !hls.autoLevelEnabled) {
      const lv = hls.levels[hls.currentLevel];
      b.textContent = '画质:' + (lv && lv.height ? (lv.height >= 2160 ? '4K' : lv.height + 'P') : '直连');
    } else if (hls && hls.levels && hls.levels.length > 1) {
      b.textContent = '画质:自动';
    } else {
      b.textContent = '画质';
    }
  }
  /* ---------- 进度条片头/片尾标记 ---------- */
  function renderTrackMarks() {
    if (!root || !video || !state) return;
    const rail = root.querySelector('.pl-track .rail');
    if (!rail) return;
    rail.querySelectorAll('.pl-marker').forEach(m => m.remove());
    if (!isFinite(video.duration) || video.duration <= 0) return;
    const mark = DB.getMark(state.key) || {};
    const mk = (sec, cls, label) => {
      if (!sec || sec <= 3 || sec >= video.duration - 3) return;
      const m = el('<span class="pl-marker ' + cls + '" title="' + label + ' ' + fmt(sec) + '"></span>');
      m.style.left = (sec / video.duration * 100) + '%';
      rail.appendChild(m);
    };
    mk(mark.intro, 'm-op', '片头');
    mk(mark.outro, 'm-ed', '片尾');
  }
  /* ---------- 音量控件 ---------- */
  function updateVolUI() {
    if (!root || !video) return;
    const fill = root.querySelector('.vol-bar i');
    if (fill) fill.style.width = Math.round((video.muted ? 0 : video.volume) * 100) + '%';
    const pct = root.querySelector('.vol-pct');
    if (pct) pct.textContent = Math.round((video.muted ? 0 : video.volume) * 100);
    const ic = root.querySelector('[data-act="mute"]');
    if (ic) ic.innerHTML = (video.muted || !video.volume) ? I.volOff : I.vol;
  }
  /* ---------- 顶栏弹幕按钮状态 ---------- */
  function updateDmBtn() {
    ensureDanmaku();
    const on = dm && dm.state.on;
    root.querySelectorAll('.pl-chips [data-act="dm"]').forEach(b => b.textContent = '弹幕:' + (on ? '开' : '关'));
  }
  /* ---------- 轻量状态层:时钟/网络/画质徽章(纯展示,不接收点击) ---------- */
  let clockTimer = 0, lastDecBytes = 0, lastDecT = 0;
  function updateStatusLayer() {
    if (!root || !root.isConnected) return;
    const ck = root.querySelector('#st-clock');
    if (ck) { const d = new Date(); ck.textContent = new Date().toTimeString().slice(0, 5) + ' 星期' + '日一二三四五六'[d.getDay()]; }
    const nb = root.querySelector('#st-net');
    if (nb) {
      const c = navigator.connection || {};
      const et = (c.effectiveType || '').toUpperCase();
      let txt = c.type === 'wifi' ? 'Wi-Fi' : (c.type === 'ethernet' ? '局域网' : (et || ''));
      /* 实时网速:解码字节数差分(Chrome/WebView) */
      if (video && video.webkitVideoDecodedByteCount && lastDecT) {
        const kbps = (video.webkitVideoDecodedByteCount - lastDecBytes) / (Date.now() - lastDecT);   /* KB/s */
        if (kbps > 8) txt += (txt ? ' ' : '') + (kbps >= 1024 ? (kbps / 1024).toFixed(1) + 'MB/s' : Math.round(kbps) + 'KB/s');
      }
      if (video) { lastDecBytes = video.webkitVideoDecodedByteCount || 0; lastDecT = Date.now(); }
      nb.style.display = txt ? '' : 'none';
      nb.textContent = txt;
    }
    updateChipValues();
  }
  /* 深度配置层chips状态值 */
  function updateChipValues() {
    if (!root || !state) return;
    const g = state.groups[state.groupIndex];
    const set = (id, v) => { const e = root.querySelector('#' + id); if (e) e.textContent = v; };
    set('pv-eps', (state.epIndex + 1) + '/' + (g ? g.eps.length : 0));
    set('pv-src', (g && g.name) || state.fromName || '-');
    set('pv-speed', 'x' + (video ? video.playbackRate : 1));
    set('pv-dm', dm && dm.state && dm.state.on ? '开启 ' + Math.round((dm.state.opacity || 0.85) * 100) + '%' : '关闭');
  }
  /* 暂停中央轻提示 */
  function updatePauseHint() {
    if (!root || !video) return;
    const h = root.querySelector('.pl-pausehint');
    if (!h) return;
    const show = video.paused && !video.ended && video.currentTime > 0.5 && !video.error;
    h.style.display = show ? 'flex' : 'none';
  }
  function updateQualBadge() {
    if (!root || !video) return;
    const q = root.querySelector('#st-qual');
    if (!q) return;
    let txt = '';
    let auto = false;
    if (hls && hls.levels && hls.levels.length) {
      const lv = hls.levels[hls.currentLevel] || hls.levels[hls.loadLevel];
      if (lv) {
        const h = lv.height || 0;
        /* 档位阈值按真实像素高度:1080 档从 1000 起(兼容 1088/1080),
           720 档从 700 起,避免 1088 被误判成 4K、608 被误判成 1080 */
        txt = h >= 2000 ? '4K' : h >= 1000 ? '1080P' : h >= 700 ? '720P' : h >= 500 ? '480P' : (h ? h + 'P' : Math.round(lv.bitrate / 1000) + 'K');
        const fr = Number(lv.frameRate || (lv.attrs && lv.attrs['FRAME-RATE']) || 0);
        if (fr >= 50) txt += '/' + Math.round(fr);
        const vr = lv.videoRange || (lv.attrs && lv.attrs['VIDEO-RANGE']) || '';
        if (vr && vr !== 'SDR') txt += ' ' + (vr === 'PQ' ? 'HDR' : vr);
        auto = !!hls.autoLevelEnabled;
      }
    }
    /* 清单声明的 RESOLUTION 常与实际转码分辨率不符(标 1920x1080 实为 466p 上采样),
       所以已解码出画面时以 video.videoHeight(真实像素高度)为准。 */
    if (video.videoHeight) {
      const vh = video.videoHeight;
      const real = vh >= 2000 ? '4K' : vh >= 1000 ? '1080P' : vh >= 700 ? '720P' : vh >= 500 ? '480P' : vh + 'P';
      txt = real;
    }
    if (auto) txt += '·自动';
    q.textContent = txt;
    q.style.display = txt ? '' : 'none';
  }
  /* ---------- 音轨/解码 循环(深度配置层快捷) ---------- */
  function updateAtrackLabels() {
    if (!root) return;
    const chip = root.querySelector('[data-act="atrack"]');
    if (!chip) return;
    const has = hls && hls.audioTracks && hls.audioTracks.length > 1;
    chip.style.display = has ? '' : 'none';
    if (has) {
      const t = hls.audioTracks[hls.audioTrack] || {};
      const pv2 = chip.querySelector('#pv-atrack');
      if (pv2) pv2.textContent = t.name || t.lang || '音轨' + (hls.audioTrack + 1);
    }
  }
  function cycleAtrack() {
    if (!hls || !hls.audioTracks || hls.audioTracks.length < 2) { if (window.toast) toast('当前流无可切换音轨'); return; }
    hls.audioTrack = (hls.audioTrack + 1) % hls.audioTracks.length;
    updateAtrackLabels();
    const t = hls.audioTracks[hls.audioTrack] || {};
    if (window.toast) toast('音轨:' + (t.name || t.lang || '音轨' + (hls.audioTrack + 1)));
  }
  function updateDecLabels() {
    if (!root) return;
    const dec = state.decodeMode || DB.getConfig().decodeMode || 'hw';
    root.querySelectorAll('[data-act="dec"]').forEach(b => b.textContent = '解码:' + (dec === 'hw' ? '硬解' : '软解'));
  }
  function cycleDecode() {
    const cur = state.decodeMode || DB.getConfig().decodeMode || 'hw';
    const next = cur === 'hw' ? 'sw' : 'hw';
    state.decodeMode = next;
    DB.setConfig({ decodeMode: next });
    updateDecLabels();
    if (window.toast) toast(next === 'hw' ? '已切换硬件解码' : '已切换软解兼容模式');
    closePanels();
    loadEpisode(state.groupIndex, state.epIndex);
  }
  const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3];
  function cycleSpeed(btn) {
    if (iframe) return;
    const cur = SPEEDS.indexOf(video.playbackRate) === -1 ? 0 : SPEEDS.indexOf(video.playbackRate);
    const next = SPEEDS[(cur + 1) % SPEEDS.length];
    video.playbackRate = next;
    root.querySelectorAll('#pv-speed').forEach(b => b.textContent = 'x' + next);
  }
  function toggleFs() {
    if (document.fullscreenElement) document.exitFullscreen();
    else root.requestFullscreen && root.requestFullscreen();
  }
  function switchEp(d) {
    if (!root || !video || !state) return; // 退出后残留 ended 事件
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

  /* 快捷字幕:循环内嵌字幕轨,无轨则打开字幕抽屉 */
  function cycleSubTrack(btn) {
    const list = subTrackList();
    if (!list.length) {
      if (window.toast) toast('无内嵌字幕,可加载外挂或搜在线字幕');
      toggleMediaDrawer('sub');
      return;
    }
    let cur = -1;
    list.forEach(function (t, i) { if (t.track.mode === 'showing') cur = i; });
    const next = cur + 1 >= list.length ? -1 : cur + 1;
    list.forEach(function (t, i) { t.track.mode = (i === next ? 'showing' : 'hidden'); });
    root.querySelectorAll('#pv-sub').forEach(function (b) { b.textContent = next < 0 ? '关' : list[next].name; });
    if (window.toast) toast(next < 0 ? '字幕已关闭' : '字幕:' + list[next].name);
  }
  /* 快捷弹幕开关 */
  function toggleDmQuick(btn) {
    ensureDanmaku();
    if (!dm || !window.Danmaku) { if (window.toast) toast('弹幕组件未加载'); return; }
    dm.setOn(!dm.state.on);
    saveDm();
    root.querySelectorAll('.pl-chips [data-act="dm"]').forEach(b => b.textContent = '弹幕:' + (dm.state.on ? '开' : '关'));
    updateDmBtn();
    if (window.toast) toast(dm.state.on ? '弹幕已开' : '弹幕已关');
  }
  /* ---------- 播放设置横条:画质/音轨/内核/解码/倍速/比例/缩放/遥控 ---------- */
  function togglePset() {
    const old = root.querySelector('.pl-strip');
    if (old && old.dataset.kind === 'set') { closePanels(); wake(); return; }
    closePanels(); wake();
    const d = el('<div class="pl-strip" data-kind="set"><div class="d-body"></div></div>');
    const body = d.querySelector('.d-body');
    root.appendChild(d);
    KeyNav.setModal(true);

    function render(body) {
      body.innerHTML = '';
      /* 快捷操作:上一集(字幕/弹幕/换源/选集在右侧抽屉) */
      const quick = el('<div class="ep-grid" style="margin-bottom:6px"></div>');
      const qPrev = el('<button class="ep" data-f tabindex="-1">⏮ 上一集</button>');
      qPrev.onclick = () => { closePanels(); switchEp(-1); };
      quick.appendChild(qPrev);
      const qFav = el('<button class="ep" data-f tabindex="-1">♡ 收藏 / 取消收藏</button>');
      qFav.onclick = () => toggleFavBtn(qFav);
      quick.appendChild(qFav);
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
        body.appendChild(el('<div class="hint">黑屏/卡顿:先试「软解兼容」;网络流建议用 EXO 内核;片头跳过在「选集」抽屉底部标记。</div>'));
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
    }

    render(body);
    KeyNav.setScope(d);
    KeyNav.focusFirst(d);
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

    /* 无进度看门狗:有些源(如分享页解析失败)不会触发 waiting,也不报错,
       只是画面不动、时间不走。这里定时检查「有没有在推进」,没有就按卡死处理。 */
    if (state._progressTimer) clearInterval(state._progressTimer);
    let lastTick = -1, lastTickAt = Date.now();
    state._progressTimer = setInterval(() => {
      if (!root || !video || iframe) return;
      if (video.paused) return;          // 用户主动暂停不算卡死
      const t = video.currentTime || 0;
      if (t !== lastTick) { lastTick = t; lastTickAt = Date.now(); return; }
      /* 时间不动持续 25 秒 → 视为卡死 */
      if (Date.now() - lastTickAt < 25000) return;
      lastTickAt = Date.now();
      const dur = video.duration || 0;
      if (!isFinite(dur) || dur <= 0) return;                 // 直播/未知时长不判卡死
      if (video.seeking || video.buffered.length === 0) return; // 正常缓冲中
      if (maybeAutoSwitch('播放无响应')) return;
      showCenter(`<div class="pl-msg">播放无响应(已停止推进)<br>可尝试「换源」或返回重选</div>`);
    }, 5000);
  }

  /* ---------- 横排面板(选集/设置/换源):一排横向选项,非抽屉 ---------- */
  function closePanels() {
    ['.pl-strip', '.pl-drawer'].forEach(function (sel) {
      const elx = root.querySelector(sel);
      if (elx) { if (elx.__cleanup) elx.__cleanup(); elx.remove(); }
    });
    KeyNav.setModal(false);
    KeyNav.setScope(null);
  }

  /* ---------- 右侧媒体抽屉:选集 / 换源 / 字幕 / 弹幕 四 Tab ---------- */
  function toggleDrawer() { toggleMediaDrawer('eps'); }
  function toggleSourcePanel() {
    if (!state.onFindSources || !state.onPlayFromSource) { toast && toast('该播放内容不支持换源'); return; }
    toggleMediaDrawer('src');
  }
  function toggleMediaDrawer(tab) {
    const old = root.querySelector('.pl-drawer');
    if (old && old.dataset.kind === 'media' && old.dataset.tab === tab) { closePanels(); wake(); return; }
    closePanels(); wake();
    const d = el(`<div class="pl-drawer" data-kind="media" data-tab="${tab}">
      <div class="d-head"></div>
      <div class="pl-tabs">
        <button class="pl-tab" data-t="eps" data-f tabindex="-1">选集</button>
        <button class="pl-tab" data-t="src" data-f tabindex="-1">换源</button>
        <button class="pl-tab" data-t="sub" data-f tabindex="-1">字幕</button>
        <button class="pl-tab" data-t="dm" data-f tabindex="-1">弹幕</button>
      </div>
      <div class="d-body"></div>
    </div>`);
    root.appendChild(d);
    d.querySelectorAll('.pl-tab').forEach(t => {
      t.onclick = () => { if (d.dataset.tab !== t.dataset.t) { d.dataset.tab = t.dataset.t; renderMediaTab(d); } };
    });
    renderMediaTab(d);
    KeyNav.setModal(true);
    wake();
    KeyNav.focusFirst(d);
  }
  function renderMediaTab(d) {
    const tab = d.dataset.tab;
    d.querySelectorAll('.pl-tab').forEach(t => t.classList.toggle('current', t.dataset.t === tab));
    const body = d.querySelector('.d-body');
    body.innerHTML = '';
    if (tab === 'eps') renderEpsTab(d, body);
    else if (tab === 'src') renderSrcTab(d, body);
    else if (tab === 'sub') renderSubTab(d, body);
    else renderDmTab(d, body);
  }

  /* --- Tab:选集(带图卡片墙:缩略图取帧 + 观看进度标记) --- */

  /* 单集缩略图:隐藏 video 解码一帧 -> canvas JPEG dataURL;失败/超时/跨域污染返回 null */
  const epThumbCache = new Map();   /* ep.url -> dataURL(内存级,面板重开秒出) */
  let epThumbToken = 0;
  function epThumb(url) {
    if (epThumbCache.has(url)) return Promise.resolve(epThumbCache.get(url));
    if (epThumbCache.size > 150) epThumbCache.clear();
    const u = DB.getConfig().proxyMode ? API.proxied(url) : url;
    return new Promise(resolve => {
      let done = false, hls = null;
      const v = document.createElement('video');
      v.muted = true; v.crossOrigin = 'anonymous'; v.preload = 'auto';
      v.playsInline = true; v.setAttribute('playsinline', '');
      v.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:2px;height:2px;opacity:0;pointer-events:none';
      const finish = r => {
        if (done) return; done = true;
        if (r) epThumbCache.set(url, r);
        clearTimeout(timer);
        try { if (hls) hls.destroy(); } catch (e) {}
        v.onseeked = v.onerror = v.onloadedmetadata = null;
        v.removeAttribute('src'); try { v.load(); } catch (e) {} v.remove();
        resolve(r);
      };
      const timer = setTimeout(() => finish(null), 14000);
      const capture = () => {
        try {
          if (!v.videoWidth) { finish(null); return; }
          const c = document.createElement('canvas');
          c.width = 320; c.height = Math.max(2, Math.round(320 * v.videoHeight / v.videoWidth));
          c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
          finish(c.toDataURL('image/jpeg', 0.62));
        } catch (e) { finish(null); }   /* 直链无CORS头时画布被污染 */
      };
      let seekDone = false, mdAt = 0;
      v.onseeked = () => { seekDone = true; capture(); };
      /* 弱源兜底:seek 3秒未完成就先抓当前帧(好过没有) */
      v.ontimeupdate = () => { if (!seekDone && mdAt && Date.now() - mdAt > 3000 && v.videoWidth) capture(); };
      v.onloadedmetadata = () => {
        mdAt = Date.now();
        const dur = v.duration;
        const at = isFinite(dur) && dur > 0 ? Math.min(dur * 0.28, 300) : 90;
        try { v.currentTime = at; } catch (e) { capture(); }
      };
      v.onerror = () => finish(null);
      if (/\.m3u8/i.test(url) && window.Hls && Hls.isSupported()) {
        hls = new Hls({ maxBufferLength: 6, capLevelToPlayerSize: true, enableWorker: false });
        hls.on(Hls.Events.ERROR, (evt, data) => { if (data && data.fatal) finish(null); });
        hls.loadSource(u); hls.attachMedia(v);
      } else {
        v.src = u;
      }
      document.body.appendChild(v);
    });
  }
  /* 并发3的取帧队列;面板关闭即停止 */
  function genWallThumbs(d, items) {
    const token = ++epThumbToken;
    const queue = items.filter(it => !epThumbCache.has(it.url));
    let idx = 0;
    const worker = async () => {
      while (idx < queue.length) {
        if (token !== epThumbToken || !document.body.contains(d)) return;
        const it = queue[idx++];
        const data = await epThumb(it.url);
        if (document.body.contains(d) && it.img && it.ph) {
          if (data) {
            it.img.src = data; it.img.style.display = 'block'; it.ph.style.display = 'none';
          } else {
            it.ph.classList.remove('loading');
          }
        }
      }
    };
    for (let i = 0; i < 3; i++) worker();
  }
  function escName(s) {
    return String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function renderEpsTab(d, body) {
    d.classList.add('has-eps');
    const g0 = state.groups[state.groupIndex];
    d.querySelector('.d-head').textContent = (state.title || state.name || '') + (g0 && g0.eps[state.epIndex] ? ' · ' + g0.eps[state.epIndex].name : '');
    const hist = DB.getHist(state.key);
    const wallItems = [];
    state.groups.forEach((g, gi) => {
      body.appendChild(el('<div class="d-group">' + escName(g.name) + ' · ' + g.eps.length + '集</div>'));
      const wall = el('<div class="ep-wall"></div>');
      g.eps.forEach((ep, ei) => {
        const isCur = gi === state.groupIndex && ei === state.epIndex;
        const isWatched = !isCur && gi === 0 && hist && typeof hist.epIndex === 'number' && ei < hist.epIndex;
        const card = el('<div class="ep-card' + (isCur ? ' current' : '') + (isWatched ? ' watched' : '') + '" data-f tabindex="-1" role="button" aria-label="' + escName(ep.name) + '"></div>');
        const thumb = el('<div class="ep-thumb"></div>');
        const ph = el('<div class="ep-ph' + (isCur ? '' : ' loading') + '">' + escName(ep.name) + '</div>');
        const img = document.createElement('img');
        img.alt = ep.name || '';
        img.style.display = 'none';
        thumb.appendChild(ph); thumb.appendChild(img);
        card.appendChild(thumb);
        card.appendChild(el('<div class="ep-tag">' + escName(ep.name) + '</div>'));
        if (isCur) card.appendChild(el('<span class="ep-badge">正在播</span>'));
        card.onclick = () => { epThumbToken++; closePanels(); loadEpisode(gi, ei); };
        wall.appendChild(card);
        wallItems.push({ url: ep.url, img, ph });
      });
      body.appendChild(wall);
    });
    /* 当前组取帧(并发3,逐个填充);失败落回片名占位 */
    genWallThumbs(d, wallItems.filter(it => it.url && !/^(blob:|data:)/i.test(it.url)));
    const mark = DB.getMark(state.key) || {};
    const ig = el('<div class="ep-grid"></div>');
    const mI = el('<button class="ep" data-f tabindex="-1">' + (mark.intro ? '★ 片头 ' + fmt(mark.intro) : '标记当前位置为片头') + '</button>');
    mI.onclick = function () {
      if (video && video.currentTime > 5) {
        DB.setMark(state.key, { intro: Math.floor(video.currentTime) });
        if (window.toast) toast('已标记片头 ' + fmt(video.currentTime));
        renderTrackMarks();
        renderMediaTab(d);
      }
    };
    const mO = el('<button class="ep" data-f tabindex="-1">' + (mark.outro ? '★ 片尾 ' + fmt(mark.outro) : '标记当前位置为片尾') + '</button>');
    mO.onclick = function () {
      if (video && isFinite(video.duration) && video.currentTime < video.duration - 20) {
        DB.setMark(state.key, { outro: Math.floor(video.currentTime) });
        if (window.toast) toast('已标记片尾,此后自动播下一集');
        renderTrackMarks();
        renderMediaTab(d);
      }
    };
    const clr = el('<button class="ep' + (!mark.intro && !mark.outro ? ' watched' : '') + '" data-f tabindex="-1">清除本片标记</button>');
    clr.onclick = function () { DB.clearMark(state.key, 'intro'); DB.clearMark(state.key, 'outro'); renderTrackMarks(); if (window.toast) toast('已清除'); renderMediaTab(d); };
    ig.appendChild(mI); ig.appendChild(mO); ig.appendChild(clr);
    body.appendChild(ig);
    body.appendChild(el('<div class="hint">默认自动跳过片头:' + (DB.getConfig().skipIntroAuto ? (DB.getConfig().defaultIntroSec + '秒') : '关闭') + '(全局默认在「设置」页调整)</div>'));
  }

  /* --- Tab:换源 --- */
  function renderSrcTab(d, body) {
    d.querySelector('.d-head').textContent = '换源 · 同名影片';
    body.innerHTML = UI.spinner();
    state.onFindSources().then(list => {
      if (!document.body.contains(d)) return;
      const b2 = d.querySelector('.d-body');
      b2.innerHTML = '';
      /* 自动换源开关(失败/卡顿15秒自动切换) */
      const auto = DB.getConfig().autoSwitch;
      const autoRow = el('<button class="ep wide' + (auto ? ' current' : '') + '" data-f tabindex="-1">' + (auto ? '自动换源 开 · 失败/卡顿15秒自动切换' : '自动换源 关') + '</button>');
      autoRow.onclick = () => { DB.setConfig({ autoSwitch: !DB.getConfig().autoSwitch }); if (window.toast) toast(!DB.getConfig().autoSwitch ? '已开启自动换源' : '已关闭自动换源'); renderMediaTab(d); };
      b2.appendChild(autoRow);
      b2.appendChild(el('<div class="d-group">' + (list && list.length ? list.length + ' 个源命中 · 按测速排序' : '') + '</div>'));
      if (!list || !list.length) {
        b2.appendChild(el('<div class="hint">其他源暂无同名影片,可尝试搜索页全网搜索</div>'));
        KeyNav.focusFirst(b2);
        return;
      }
      const grid = el('<div class="ep-grid"></div>');
      list.forEach(it => {
        const b = el(`<button class="ep${it.srcId === state.sourceId ? ' current' : ''}" data-f tabindex="-1" title="${it.srcName} · ${it.remarks || '直链'} · ${it.ms}ms">${it.srcName} · ${it.remarks || '直链'} · ${it.ms}ms</button>`);
        b.onclick = () => { closePanels(); state.onPlayFromSource(it, state.epIndex); };
        grid.appendChild(b);
      });
      b2.appendChild(grid);
      KeyNav.focusFirst(b2);
    }).catch(() => { if (document.body.contains(d)) d.querySelector('.d-body').innerHTML = '<div class="hint">测源失败,请稍后重试</div>'; });
  }

  /* --- Tab:字幕(轨道/外挂/在线/时间轴/样式) --- */
  function renderSubTab(d, body) {
    d.querySelector('.d-head').textContent = '字幕';
    const subList = subTrackList();
    if (subList.length) {
      body.appendChild(el('<div class="d-group">内嵌字幕轨</div>'));
      const grid = el('<div class="ep-grid"></div>');
      const offB = el('<button class="ep" data-f tabindex="-1">关闭</button>');
      offB.onclick = function () { subList.forEach(function (t) { t.track.mode = 'hidden'; }); renderMediaTab(d); };
      grid.appendChild(offB);
      subList.forEach(function (t, i) {
        const b = el('<button class="ep' + (t.track.mode === 'showing' ? ' current' : '') + '" data-f tabindex="-1">' + t.name + '</button>');
        b.onclick = function () {
          subTrackList().forEach(function (x, xi) { x.track.mode = (xi === i ? 'showing' : 'hidden'); });
          renderMediaTab(d);
        };
        grid.appendChild(b);
      });
      body.appendChild(grid);
    }
    body.appendChild(el('<div class="d-group">外挂与在线</div>'));
    const sg = el('<div class="ep-grid"></div>');
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
          renderMediaTab(d);
        });
      };
      inp.click();
    };
    sg.appendChild(loadB);
    const onlB = el('<button class="ep" data-f tabindex="-1">🌐 SubHD 在线搜索</button>');
    onlB.onclick = function () { renderOnlineSubs(d); };
    sg.appendChild(onlB);
    body.appendChild(sg);

    body.appendChild(el('<div class="d-group">时间轴</div>'));
    const og = el('<div class="ep-grid"></div>');
    const mko = function (label, delta, title) {
      const b = el('<button class="ep" data-f tabindex="-1" title="' + (title || '') + '">' + label + '</button>');
      b.onclick = function () { shiftSubOffset(delta); };
      og.appendChild(b);
    };
    mko('⏱ 提前0.5s', -0.5, '字幕比台词快半拍时点此');
    mko('⏱ 延迟+0.5s', 0.5, '字幕比台词慢半拍时点此');
    mko('↺ Offset归零', 'reset', '重新加载本集恢复原始时间轴');
    body.appendChild(og);

    body.appendChild(el('<div class="d-group">字幕样式</div>'));
    const stRow = el('<div class="ep-grid"></div>');
    (function () {
      const st = subStyle();
      const bs = el('<button class="ep" data-f tabindex="-1">字号 ' + st.scale + 'x(点切换)</button>');
      bs.onclick = function () { const s = DB.getConfig().subStyle || {}; const seq = [0.7, 1, 1.3, 1.6, 2]; s.scale = seq[(seq.indexOf(s.scale || 1) + 1) % seq.length]; DB.setConfig({ subStyle: s }); enableSubOverlay(); applySubStyle(); renderMediaTab(d); };
      stRow.appendChild(bs);
      const bt = el('<button class="ep" data-f tabindex="-1">描边 ' + st.stroke + 'px(点切换)</button>');
      bt.onclick = function () { const s = DB.getConfig().subStyle || {}; const seq = [0, 1, 2, 3, 4]; s.stroke = seq[(seq.indexOf(s.stroke === undefined ? 2 : s.stroke) + 1) % seq.length]; DB.setConfig({ subStyle: s }); enableSubOverlay(); applySubStyle(); renderMediaTab(d); };
      stRow.appendChild(bt);
      const bg = el('<button class="ep" data-f tabindex="-1">背景 ' + Math.round(st.bg * 100) + '%(点切换)</button>');
      bg.onclick = function () { const s = DB.getConfig().subStyle || {}; const seq = [0, 0.25, 0.45, 0.7]; const cur = s.bg === undefined ? 0.35 : s.bg; s.bg = seq[(seq.indexOf(cur) + 1) % seq.length] || 0; DB.setConfig({ subStyle: s }); enableSubOverlay(); applySubStyle(); renderMediaTab(d); };
      stRow.appendChild(bg);
    })();
    body.appendChild(stRow);
    body.appendChild(el('<div class="hint">在线字幕来自 SubHD(支持 SRT/ASS);时间轴微调对当前集立即生效;样式记忆后对所有外挂字幕生效。</div>'));
  }
  /* 在线字幕搜索(SubHD),返回按钮回到字幕 Tab */
  function renderOnlineSubs(d) {
    const box2 = d.querySelector('.d-body');
    box2.innerHTML = '';
    d.querySelector('.d-head').textContent = '在线字幕(SubHD)';
    const epName = (state.groups[state.groupIndex].eps[state.epIndex] || {}).name || state.name || '';
    const kw0 = epName.replace(/\.(mp4|mkv|ts|m2ts|avi|webm|flv)$/i, '').replace(/[._\[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
    const bar = el('<div class="search-bar" style="display:flex;gap:8px;margin-bottom:10px"><input class="inp" value="' + kw0.replace(/"/g, '') + '" placeholder="片名或版本关键词" style="flex:1"><button class="ep" data-f tabindex="-1">搜索</button></div>');
    const listBox = el('<div></div>');
    const doSearch = function () {
      const kw = bar.querySelector('input').value.trim();
      if (!kw) return;
      listBox.innerHTML = UI.spinner();
      const SRV = location.protocol === 'file:' ? 'http://127.0.0.1:9978' : '';
      fetch(SRV + '/sub/search?kw=' + encodeURIComponent(kw)).then(r => r.json()).then(dd => {
        listBox.innerHTML = '';
        if (dd.error) { listBox.appendChild(el('<div class="hint">' + dd.error + '</div>')); return; }
        if (!dd.list.length) { listBox.appendChild(el('<div class="hint">没有找到字幕,换个关键词试试(建议用片名)</div>')); return; }
        const grid = el('<div class="ep-grid"></div>');
        dd.list.slice(0, 24).forEach(function (it) {
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
              renderMediaTab(d);
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
    const back = el('<button class="ep" data-f tabindex="-1">← 返回字幕</button>');
    back.onclick = function () { renderMediaTab(d); };
    box2.appendChild(back);
    KeyNav.focusFirst(box2);
  }

  /* --- Tab:弹幕(开关/在线/透明度/字号/文件) --- */
  function renderDmTab(d, body) {
    d.querySelector('.d-head').textContent = '弹幕';
    ensureDanmaku();
    if (!window.Danmaku || !dm) { body.innerHTML = '<div class="hint">弹幕组件未加载</div>'; return; }
    const dg = el('<div class="ep-grid"></div>');
    const onB = el('<button class="ep' + (dm.state.on ? ' current' : '') + '" data-f tabindex="-1">' + (dm.state.on ? '弹幕 开' : '弹幕 关') + '</button>');
    onB.onclick = function () { dm.setOn(!dm.state.on); saveDm(); updateDmBtn(); renderMediaTab(d); };
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
        updateDmBtn();
        if (window.toast) toast('弹幕已加载:' + (r.matched || r.items.length + ' 条'));
        renderMediaTab(d);
      }).catch(function (e) {
        dmoB.textContent = '🌐 在线弹幕(重试)';
        if (window.toast) toast('弹幕获取失败:' + (e.message || e));
      });
    };
    dg.appendChild(dmoB);
    [[0.5, '淡'], [0.85, '标准'], [1, '浓']].forEach(function (pair) {
      const cur = Math.abs(dm.state.opacity - pair[0]) < 0.05;
      const b = el('<button class="ep' + (cur ? ' current' : '') + '" data-f tabindex="-1">透明 ' + pair[1] + '</button>');
      b.onclick = function () { dm.setOpacity(pair[0]); saveDm(); renderMediaTab(d); };
      dg.appendChild(b);
    });
    [[0.8, '小'], [1, '中'], [1.3, '大']].forEach(function (pair) {
      const cur = Math.abs(dm.state.fontScale - pair[0]) < 0.05;
      const b = el('<button class="ep' + (cur ? ' current' : '') + '" data-f tabindex="-1">' + pair[1] + '字</button>');
      b.onclick = function () { dm.setFontScale(pair[0]); saveDm(); renderMediaTab(d); };
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
            updateDmBtn();
            if (window.toast) toast('弹幕已加载:' + f.name);
            renderMediaTab(d);
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
    if (!root || !video) return; // 退出后仍可能派发残留 timeupdate
    lastPos = video.currentTime; lastDur = video.duration || 0;
    try { onTimeExtra(); } catch (_e) {}
    root.querySelector('#pl-cur').textContent = fmt(video.currentTime);
    const durEl = root.querySelector('#pl-dur'), remEl = root.querySelector('#pl-remain');
    if (durEl && isFinite(video.duration) && video.duration > 0) {
      durEl.textContent = fmt(video.duration);
      if (remEl) remEl.textContent = video.duration - video.currentTime > 1 ? '(剩余 ' + fmt(video.duration - video.currentTime) + ')' : '';
    }
    root.querySelector('#pl-dur').textContent = fmt(video.duration);
    if (isFinite(video.duration) && video.duration > 0) {
      root.querySelector('.pl-track .fill').style.width = (video.currentTime / video.duration * 100) + '%';
      /* 时长就绪后渲染一次片头/片尾标记 */
      if (!state._marksDone) { state._marksDone = true; renderTrackMarks(); }
      try {
        if (video.buffered.length) {
          const end = video.buffered.end(video.buffered.length - 1);
          root.querySelector('.pl-buf').style.width = (end / video.duration * 100) + '%';
        }
      } catch (_e) {}
    }
  }
  function onPauseEv() { if (!root) return; updatePlayBtn(); saveProgress(); }
  function onEndedEv() { switchEp(1); }
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
    updateTpEps();
    updateChipValues();
  }
  /* 核心播放行:上下集副标(第 N 集),无集可切时降透明度 */
  function updateTpEps() {
    if (!root || !state) return;
    const g = state.groups[state.groupIndex];
    if (!g) return;
    const p = root.querySelector('#tp-prev'), n = root.querySelector('#tp-next');
    if (p) {
      const has = state.epIndex > 0;
      p.style.opacity = has ? '' : '.35';
      const s = p.querySelector('.tp-sub');
      if (s) s.textContent = has ? '第 ' + state.epIndex + ' 集' : '上一集';
    }
    if (n) {
      const has = state.epIndex < g.eps.length - 1;
      n.style.opacity = has ? '' : '.35';
      const s = n.querySelector('.tp-sub');
      if (s) s.textContent = has ? '第 ' + (state.epIndex + 2) + ' 集' : '下一集';
    }
  }

  /* ---------- 快捷键 ---------- */
  function playerKeys(e) {
    if (!root) return;
    poke();
    const k = e.key;
    const ae = document.activeElement;
    const inInput = ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA');
    const panel = root.querySelector('.pl-strip, .pl-drawer');

    /* 面板(选集/换源/设置/嗅探)打开时:方向键在面板内导航,Enter 确认,Esc/Backspace 关面板 */
    if (panel) {
      if (k === 'Escape') { e.preventDefault(); if (inInput) ae.blur(); else closePanels(); return; }
      if (k === 'Backspace') { if (inInput) return; e.preventDefault(); closePanels(); return; } // 输入框内退格删字(不拦截默认)
      if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'ArrowUp' || k === 'ArrowDown') {
        if (inInput) return; // 输入框内方向键留给光标/软键盘
        e.preventDefault();
        KeyNav.setScope(panel);
        KeyNav.move({ ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }[k]);
        return;
      }
      if (k === 'Enter') {
        if (ae && ae.matches && ae.matches('[data-f]')) { e.preventDefault(); ae.click(); }
        return;
      }
      return; // 面板开启时吞掉 f/e/s/v/n 等快捷,避免误触播放器
    }

    /* 无面板:输入框内退格删字、Esc 清空并失焦,均不退出播放器 */
    if (inInput && k === 'Backspace') return;
    if (inInput && k === 'Escape') {
      e.preventDefault();
      if (ae.value) { ae.value = ''; ae.dispatchEvent(new Event('input', { bubbles: true })); }
      else ae.blur();
      return;
    }

    if (k === 'Escape' || k === 'Backspace') { e.preventDefault(); exit(); }
    else if (k === ' ' || k === 'Enter') { e.preventDefault(); togglePlay(); }
    else if (k === 'ArrowLeft') { e.preventDefault(); seekBy(-SEEK); }
    else if (k === 'ArrowRight') { e.preventDefault(); seekBy(SEEK); }
    else if (k === 'ArrowUp') { e.preventDefault(); video.volume = Math.min(1, video.volume + 0.1); poke(); }
    else if (k === 'ArrowDown') { e.preventDefault(); video.volume = Math.max(0, video.volume - 0.1); poke(); }
    else if (k === 'f' || k === 'F') toggleFs();
    else if (k === 'e' || k === 'E') toggleDrawer();
    else if (k === 's' || k === 'S') toggleSourcePanel();
    else if (k === 'v' || k === 'V') toggleSniff();
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
    if (clockTimer) clearInterval(clockTimer);
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
    if (state && state._progressTimer) { clearInterval(state._progressTimer); state._progressTimer = null; }
    KeyNav.setPlayer(false);
    KeyNav.setScope(null);
    if (root.querySelector('.pl-drawer')) KeyNav.setModal(false);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    /* 摘掉挂在 video 上的监听,防止退出后残留事件回调访问已置空的 root */
    if (video) {
      try {
        video.removeEventListener('timeupdate', onTime);
        video.removeEventListener('pause', onPauseEv);
        video.removeEventListener('ended', onEndedEv);
      } catch (_e) {}
    }
    root.remove(); root = null; video = null;
    state && state.onClose && state.onClose();
  }
  function close(silent) { if (root) exit(); else if (silent) {} }

  function isOpen() { return !!root; }

  return { open, close, isOpen };
})();
