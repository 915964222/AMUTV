# -*- coding: utf-8 -*-
import io

p = r'C:\Users\91596\.zcode\workspace\17e4ecba-c7c4-40ce-b117-87a9e9f578b3\tvbox-web\js\player.js'
s = io.open(p, encoding='utf-8').read()

# 1) 控制行收敛为7个高频项(播放/快退/快进/下集/选集/更多/全屏)
old_btns = '''        <div class="pl-ctrls">
          <button class="pbtn" data-act="rew">⏪ 10秒</button>
          <button class="pbtn" data-act="play">▶ 播放</button>
          <button class="pbtn" data-act="ff">⏩ 10秒</button>
          <button class="pbtn" data-act="prev">⏮ 上集</button>
          <button class="pbtn" data-act="next">⏭ 下集</button>
          <button class="pbtn" data-act="speed">倍速 x1.0</button>
          <button class="pbtn" data-act="ratio">🖼 原始</button>
          <button class="pbtn" data-act="eps">📋 选集</button>
          <button class="pbtn" data-act="src">🔀 换源</button>
          <button class="pbtn" data-act="sniff">🔍 嗅探</button>
          <button class="pbtn" data-act="pset">⚙ 设置</button>
          <button class="pbtn" data-act="fs">⛶ 全屏</button>
        </div>'''
new_btns = '''        <div class="pl-ctrls">
          <button class="pbtn" data-act="rew" title="快退10秒">⏪</button>
          <button class="pbtn" data-act="play" title="暂停/播放">▶</button>
          <button class="pbtn" data-act="ff" title="快进10秒">⏩</button>
          <button class="pbtn" data-act="next" title="下一集">⏭</button>
          <button class="pbtn" data-act="eps" title="选集">📋 选集</button>
          <button class="pbtn" data-act="pset" title="画质/音轨/倍速/换源/嗅探">⚙ 更多</button>
          <button class="pbtn" data-act="fs" title="全屏">⛶</button>
        </div>'''
assert old_btns in s, 'btns anchor missing'
s = s.replace(old_btns, new_btns)

# 2) wake() 重写:只隐藏顶/底控制条;拖动进度条或抽屉打开时暂停计时
old_wake = '''  /* ---------- 控件自动隐藏 ---------- */
  function wake() {
    root.classList.remove('pl-hide');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (video && !video.paused) root.classList.add('pl-hide');
    }, 3500);
  }
  function poke() { wake(); }'''
new_wake = '''  /* ---------- OSD 唤出与自动渐隐(拖动进度/抽屉打开时暂停计时) ---------- */
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
    return state.scrubbing || !!root.querySelector('.pl-drawer') || !video || video.paused;
  }
  function wake() {
    setBarsHidden(false);
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (!hidePaused()) setBarsHidden(true);
      else if (hidePaused() && !state.scrubbing) wake(); // 抽屉开着:挂起,关抽屉后重新计时
    }, 4000);
  }
  function poke() { wake(); }'''
assert old_wake in s, 'wake anchor missing'
s = s.replace(old_wake, new_wake)

# 3) 进度条拖动擦洗(scrubbing):按住拖动连续 seek,期间暂停自动隐藏
old_track = '''    // 进度条点击/拖动
    const track = root.querySelector('.pl-track');
    track.addEventListener('click', e => { seekTrack(e); });'''
new_track = '''    // 进度条:点击跳转 + 按住拖动擦洗(scrubbing 期间暂停自动隐藏)
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
    track.addEventListener('pointercancel', () => { scrubbing = false; state.scrubbing = false; wake(); });'''
assert old_track in s, 'track anchor missing'
s = s.replace(old_track, new_track)

# 4) togglePset 抽屉顶部加 换源/嗅探/上集 入口
old_sec = '''    function render(body) {
      body.innerHTML = '';
      const isMSE = !!hls;'''
new_sec = '''    function render(body) {
      body.innerHTML = '';
      /* 快捷操作:换源 / 嗅探 / 上集(低频功能收纳进二级抽屉) */
      const quick = el('<div class="ep-grid" style="margin-bottom:6px"></div>');
      const qSrc = el('<button class="ep" data-f tabindex="-1">🔀 换源</button>');
      qSrc.onclick = () => { if (d.__cleanup) d.__cleanup(); d.remove(); KeyNav.setModal(false); toggleSourcePanel(); };
      quick.appendChild(qSrc);
      const qSniff = el('<button class="ep" data-f tabindex="-1">🔍 嗅探</button>');
      qSniff.onclick = () => { if (d.__cleanup) d.__cleanup(); d.remove(); KeyNav.setModal(false); toggleSniff(); };
      quick.appendChild(qSniff);
      const qPrev = el('<button class="ep" data-f tabindex="-1">⏮ 上一集</button>');
      qPrev.onclick = () => { if (d.__cleanup) d.__cleanup(); d.remove(); KeyNav.setModal(false); switchEp(-1); };
      quick.appendChild(qPrev);
      body.appendChild(quick);
      const isMSE = !!hls;'''
assert old_sec in s, 'pset render anchor missing'
s = s.replace(old_sec, new_sec)

# 5) 关抽屉后重新唤醒控制条(wake 在抽屉打开期间被挂起)
s = s.replace('''      const old = root.querySelector('.pl-drawer');
    if (old) { if (old.__cleanup) old.__cleanup(); old.remove(); KeyNav.setModal(false); return; }
    const d = el('<div class="pl-drawer"><div class="d-head">⚙ 播放设置</div><div class="d-body"></div></div>');''',
'''      const old = root.querySelector('.pl-drawer');
    if (old) { if (old.__cleanup) old.__cleanup(); old.remove(); KeyNav.setModal(false); wake(); return; }
    const d = el('<div class="pl-drawer"><div class="d-head">⚙ 播放设置</div><div class="d-body"></div></div>');''')

io.open(p, 'w', encoding='utf-8').write(s)
print('player.js OSD refactor done')
