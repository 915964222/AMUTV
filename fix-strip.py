# -*- coding: utf-8 -*-
import io

p = r'C:\Users\91596\.zcode\workspace\17e4ecba-c7c4-40ce-b117-87a9e9f578b3\tvbox-web\js\player.js'
s = io.open(p, encoding='utf-8').read()

# 1) 统一面板关闭函数(插在 选集抽屉 注释前)
s = s.replace("""  /* ---------- 选集抽屉 ---------- */""",
"""  /* ---------- 横排面板(选集/设置/换源):一排横向选项,非抽屉 ---------- */
  function closePanels() {
    ['.pl-strip', '.pl-drawer'].forEach(function (sel) {
      const elx = root.querySelector(sel);
      if (elx) { if (elx.__cleanup) elx.__cleanup(); elx.remove(); }
    });
    KeyNav.setModal(false);
  }

  /* ---------- 选集(横排) ---------- */""")

# 2) toggleDrawer → strip
old_td = """  function toggleDrawer() {
    const old = root.querySelector('.pl-drawer');
    if (old) { old.remove(); KeyNav.setModal(false); return; }
    const d = el(`<div class="pl-drawer"><div class="d-head">选集</div><div class="d-body"></div></div>`);
    const body = d.querySelector('.d-body');
    state.groups.forEach((g, gi) => {
      const gh = el(`<div class="d-group">${g.name}(${g.eps.length}集)</div>`);
      body.appendChild(gh);
      const grid = el(`<div class="ep-grid"></div>`);
      g.eps.forEach((ep, ei) => {
        const b = el(`<button class="ep" data-f tabindex="-1">${ep.name}</button>`);
        if (gi === state.groupIndex && ei === state.epIndex) b.classList.add('current');
        b.onclick = () => { loadEpisode(gi, ei); toggleDrawer(); };
        grid.appendChild(b);
      });
      body.appendChild(grid);
    });
    root.appendChild(d);
    KeyNav.setModal(true);
    const cur = d.querySelector('.ep.current');
    if (cur) { cur.focus(); cur.scrollIntoView({ block: 'center' }); }
  }"""
new_td = """  function toggleDrawer() {
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
  }"""
assert old_td in s, 'td missing'
s = s.replace(old_td, new_td)

# 3) toggleSourcePanel → strip
old_ts = """  function toggleSourcePanel() {
    const old = root.querySelector('.pl-drawer');
    if (old) { old.remove(); KeyNav.setModal(false); return; }
    if (!state.onFindSources || !state.onPlayFromSource) { toast && toast('该播放内容不支持换源'); return; }
    const d = el(`<div class="pl-drawer"><div class="d-head">换源: ${state.name || ''}</div><div class="d-body">${UI.spinner()}</div></div>`);
    root.appendChild(d);
    KeyNav.setModal(true);
    state.onFindSources().then(list => {
      const body = d.querySelector('.d-body');
      if (!document.body.contains(d)) return;
      if (!list || !list.length) {
        body.innerHTML = '<div class="empty" style="padding:30px 0">其他源暂无同名影片<br><span style="font-size:12px">可尝试搜索页全网搜索</span></div>';
        return;
      }
      body.innerHTML = '';"""
new_ts = """  function toggleSourcePanel() {
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
      body.innerHTML = '';"""
assert old_ts in s, 'ts missing'
s = s.replace(old_ts, new_ts)

# 3b) 换源条目点击 → 关面板后切换;追加快捷关闭chip
old_pick = """      list.forEach(it => {
        const row = el(`<div class="src-item" data-f tabindex="-1">
          <span>${it.srcId === state.sourceId ? '▶' : '▫️'}</span>
          <span class="s-name">${it.name}<br><span class="s-api">${it.srcName} · ${it.remarks || '未知画质'} · ${it.ms}ms</span></span>
        </div>`);
        row.onclick = () => { d.remove(); KeyNav.setModal(false); state.onPlayFromSource(it, state.epIndex); };
        body.appendChild(row);
      });"""
new_pick = """      const closeChip = el('<button class="ep" data-f tabindex="-1" title="关闭">✕</button>');
      closeChip.onclick = () => { closePanels(); wake(); };
      body.appendChild(closeChip);
      list.forEach(it => {
        const b = el(`<button class="ep${it.srcId === state.sourceId ? ' current' : ''}" data-f tabindex="-1">${it.srcName} · ${it.remarks || '直链'} · ${it.ms}ms</button>`);
        b.onclick = () => { closePanels(); state.onPlayFromSource(it, state.epIndex); };
        body.appendChild(b);
      });"""
assert old_pick in s, 'pick missing'
s = s.replace(old_pick, new_pick)

# 4) togglePset 容器 → strip(渲染逻辑保留,横排CSS生效)
old_tp = """  function togglePset() {
    const old = root.querySelector('.pl-drawer');
    if (old) { if (old.__cleanup) old.__cleanup(); old.remove(); KeyNav.setModal(false); return; }
    const d = el('<div class="pl-drawer"><div class="d-head">⚙ 播放设置</div><div class="d-body"></div></div>');
    const body = d.querySelector('.d-body');
    root.appendChild(d);
    KeyNav.setModal(true);"""
new_tp = """  function togglePset() {
    const old = root.querySelector('.pl-strip');
    if (old && old.dataset.kind === 'set') { closePanels(); wake(); return; }
    closePanels(); wake();
    const d = el('<div class="pl-strip" data-kind="set"><div class="d-body"></div></div>');
    const body = d.querySelector('.d-body');
    root.appendChild(d);
    KeyNav.setModal(true);"""
assert old_tp in s, 'tp missing'
s = s.replace(old_tp, new_tp)

# 5) pset 内部所有抽屉式关闭 → closePanels
s = s.replace("if (d.__cleanup) d.__cleanup(); d.remove(); KeyNav.setModal(false); toggleSourcePanel();",
              "closePanels(); toggleSourcePanel();")
s = s.replace("if (d.__cleanup) d.__cleanup(); d.remove(); KeyNav.setModal(false); toggleSniff();",
              "closePanels(); toggleSniff();")
s = s.replace("if (d.__cleanup) d.__cleanup(); d.remove(); KeyNav.setModal(false); switchEp(-1);",
              "closePanels(); switchEp(-1);")
s = s.replace("""            state.engineMode = mode;
            if (d.parentNode) { if (d.__cleanup) d.__cleanup(); d.remove(); KeyNav.setModal(false); }
            loadEpisode(state.groupIndex, state.epIndex);""",
"""            state.engineMode = mode;
            closePanels();
            loadEpisode(state.groupIndex, state.epIndex);""")

# 6) hidePaused: 抽屉 → 横排面板
s = s.replace("return state.scrubbing || !!root.querySelector('.pl-drawer') || !video || video.paused;",
              "return state.scrubbing || !!root.querySelector('.pl-strip') || !!root.querySelector('.pl-drawer') || !video || video.paused;")

# 7) exit() 清理:两种面板都关
s = s.replace("""    const drawer = root && root.querySelector('.pl-drawer');
    if (drawer && drawer.__cleanup) drawer.__cleanup();""",
"""    ['.pl-strip', '.pl-drawer'].forEach(function (sel) {
      const elx = root && root.querySelector(sel);
      if (elx && elx.__cleanup) elx.__cleanup();
    });""")

io.open(p, 'w', encoding='utf-8').write(s)
print('strip refactor done')
