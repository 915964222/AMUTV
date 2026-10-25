# -*- coding: utf-8 -*-
import io

p = r'C:\Users\91596\.zcode\workspace\17e4ecba-c7c4-40ce-b117-87a9e9f578b3\tvbox-web\js\player.js'
s = io.open(p, encoding='utf-8').read()

ANCHOR = "  /* ---------- 卡顿看门狗:waiting 持续15秒 → 自动换源 ---------- */"
assert ANCHOR in s, 'anchor missing'

NEW = '''  /* ---------- 画面比例:原始/满屏/拉伸 ---------- */
  const RATIOS = [['contain', '原始'], ['cover', '满屏'], ['fill', '拉伸']];
  function cycleRatio() {
    if (!state) return;
    const idx = RATIOS.findIndex(function (r) { return r[0] === (state.ratio || 'contain'); });
    state.ratio = RATIOS[(idx + 1) % RATIOS.length][0];
    applyRatio();
    if (window.toast) toast('画面比例:' + RATIOS.find(function (r) { return r[0] === state.ratio; })[1]);
  }
  function applyRatio() {
    if (video) video.style.objectFit = state.ratio || 'contain';
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
    const intro = introSecOf();
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
    const old = root.querySelector('.pl-drawer');
    if (old) { if (old.__cleanup) old.__cleanup(); old.remove(); KeyNav.setModal(false); return; }
    const d = el('<div class="pl-drawer"><div class="d-head">⚙ 播放设置</div><div class="d-body"></div></div>');
    const body = d.querySelector('.d-body');
    root.appendChild(d);
    KeyNav.setModal(true);

    function render(body) {
      body.innerHTML = '';
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
        body.appendChild(el('<div class="d-group">解码内核</div>'));
        const grid = el('<div class="ep-grid"></div>');
        const native = video ? video.canPlayType('application/vnd.apple.mpegurl') : '';
        const curMode = state.engineMode || 'auto';
        const mk = function (label, mode, ok, note) {
          const b = el('<button class="ep' + (curMode === mode ? ' current' : '') + (ok ? '' : ' watched') + '" data-f tabindex="-1" title="' + (note || '') + '">' + label + '</button>');
          b.onclick = function () {
            if (!ok) { if (window.toast) toast(note || '当前浏览器不支持'); return; }
            state.engineMode = mode;
            if (d.parentNode) { if (d.__cleanup) d.__cleanup(); d.remove(); KeyNav.setModal(false); }
            loadEpisode(state.groupIndex, state.epIndex);
          };
          grid.appendChild(b);
        };
        mk('自动', 'auto', true, '优先MSE,按需回退');
        mk('MSE内核', 'mse', !!(window.Hls && Hls.isSupported()), 'hls.js 软解分层');
        mk('原生内核', 'native', !!(native && String(native) !== ''), '系统解码器');
        body.appendChild(grid);
        body.appendChild(el('<div class="hint">4K/HEVC 流畅度取决于系统硬解;MSE 内核可手动锁档。</div>'));
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

  /* ---------- 卡顿看门狗:waiting 持续15秒 → 自动换源 ---------- */'''

s = s.replace(ANCHOR, NEW)

# 跳过片头按钮显隐 + 片尾自动下集 挂到 timeupdate(onTime 尾部)
s = s.replace("""  function onTime() {
    lastPos = video.currentTime; lastDur = video.duration || 0;""",
"""  function onTime() {
    lastPos = video.currentTime; lastDur = video.duration || 0;
    try { onTimeExtra(); } catch (_e) {}""")

# loadEpisode 里应用片头跳过(resume 之后)
s = s.replace("""      if (startAt > 0) { try { video.currentTime = startAt; } catch {} }""",
"""      if (resume) {
        try {
          const intro = introSecOf();
          if (intro > 3 && startAt < intro) startAt = intro;
        } catch (_e) {}
      }
      if (startAt > 0) { try { video.currentTime = startAt; } catch {} }""")

# 新播放时重置片尾触发标记 + 应用比例
s = s.replace("""    state.groupIndex = gi; state.epIndex = ei;
    setTitle();""",
"""    state.groupIndex = gi; state.epIndex = ei;
    state._outroFired = false;
    setTitle();
    try { applyRatio(); } catch (_e) {}""")

io.open(p, 'w', encoding='utf-8').write(s)
print('player.js part2 patched')
