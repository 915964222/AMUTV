# -*- coding: utf-8 -*-
import io

p = r'C:\Users\91596\.zcode\workspace\17e4ecba-c7c4-40ce-b117-87a9e9f578b3\tvbox-web\js\app.js'
s = io.open(p, encoding='utf-8').read()

# 1) TABS 加 直播
s = s.replace("""    { id: 'search', name: '搜索' },""",
"""    { id: 'search', name: '搜索' },
    { id: 'live', name: '直播' },""")
s = s.replace("""    else if (id === 'search') pageSearch();""",
"""    else if (id === 'search') pageSearch();
    else if (id === 'live') pageLive();""")

# 2) 直播页(插在 搜索页 前)
old = "  /* ============ 搜索页 ============"
live_page = """  /* ============ 直播(IPTV)页 ============ */
  const liveState = { pl: null, groups: [], gIdx: 0, chIdx: -1 };

  async function pageLive() {
    view().innerHTML = `<div class="page-title">直播 <span class="sub">IPTV · M3U/txt 源 · EPG 节目单</span></div>` + UI.spinner();
    // 无列表 → 引导
    const pls = Live.getPlaylists();
    if (!liveState.pl && pls.length) liveState.pl = Live.currentPl() || pls[0].id;
    if (!pls.length && !liveState.pl) {
      view().innerHTML = '';
      const box = UI.el('<div></div>');
      box.appendChild(UI.el('<div class="hint" style="margin-bottom:12px">导入 M3U / txt 直播源,或选择内置源:</div>'));
      const row = UI.el('<div class="cat-row"></div>');
      Live.PRESETS.forEach(pr => {
        const b = UI.el(`<button class="cat" data-f tabindex="-1">${pr.name}</button>`);
        b.onclick = async () => {
          toast('正在拉取直播源…');
          try {
            const text = await API.fetchText ? await (async () => {
              const r = await fetch('/proxy/' + pr.url);
              if (!r.ok) throw new Error('HTTP ' + r.status);
              return r.text();
            })() : '';
            const r = Live.addPlaylist(pr.name, pr.url, text);
            if (!r.ok) { toastErr(r.msg); return; }
            liveState.pl = r.id;
            Live.setCurrentPl(r.id);
            toast('已导入');
            pageLive();
          } catch (e) { toastErr('拉取失败:' + (e.message || e)); }
        };
        row.appendChild(b);
      });
      box.appendChild(row);
      const manual = UI.el('<div class="section" style="margin-top:14px"><h3>手动导入</h3><div class="form">' +
        '<input id="live-url" data-f tabindex="-1" placeholder="M3U/txt 地址(http://…)">' +
        '<button class="btn primary" id="live-add-url" data-f tabindex="-1">导入URL</button></div>' +
        '<div class="form" style="margin-top:10px"><textarea id="live-text" data-f tabindex="-1" placeholder="…或粘贴 M3U(#EXTINF…)/txt(频道名,地址) 内容"></textarea>' +
        '<button class="btn" id="live-add-text" data-f tabindex="-1">导入文本</button></div>' +
        '<div class="hint">支持 TVBox 配置里 lives 段的 m3u/txt;分组识别 #EXTINF group-title 与 组名,#genre# 两种格式。EPG 节目单自动匹配(51zmt 数据源)。</div></div>');
      box.appendChild(manual);
      bindLiveImport();
      view().appendChild(box);
      KeyNav.focusFirst();
      return;
    }
    // 加载列表
    const plObj = pls.find(x => x.id === liveState.pl) || pls[0];
    if (!plObj) { liveState.pl = null; pageLive(); return; }
    try {
      let text = plObj.text || '';
      if (!text && plObj.url) text = await (await fetch('/proxy/' + plObj.url)).text();
      const groups = Live.parsePlaylist(text);
      if (!groups.length) throw new Error('未解析到频道(检查格式)');
      liveState.groups = groups;
    } catch (e) {
      view().innerHTML = '';
      view().appendChild(UI.empty('直播源加载失败:' + (e.message || e), '重试', () => { liveState.pl = null; pageLive(); }));
      return;
    }
    renderLiveUI(pls, plObj);
  }

  function bindLiveImport() {
    const b1 = view().querySelector('#live-add-url');
    if (b1) b1.onclick = async () => {
      const url = view().querySelector('#live-url').value.trim();
      if (!/^https?:/i.test(url)) { toastErr('请填写 http(s) 地址'); return; }
      toast('正在拉取…');
      try {
        const text = await (await fetch('/proxy/' + url)).text();
        const r = Live.addPlaylist(url.split('/').pop().slice(0, 24), url, text);
        if (!r.ok) { toastErr(r.msg); return; }
        liveState.pl = r.id; Live.setCurrentPl(r.id);
        toast('导入成功'); pageLive();
      } catch (e) { toastErr('拉取失败:' + (e.message || e)); }
    };
    const b2 = view().querySelector('#live-add-text');
    if (b2) b2.onclick = () => {
      const text = view().querySelector('#live-text').value.trim();
      if (!text) { toastErr('请粘贴内容'); return; }
      const r = Live.addPlaylist('手动导入', '', text);
      if (!r.ok) { toastErr(r.msg); return; }
      liveState.pl = r.id; Live.setCurrentPl(r.id);
      toast('导入成功'); pageLive();
    };
  }

  function renderLiveUI(pls, plObj) {
    view().innerHTML = '';
    const root = UI.el('<div></div>');
    // 源选择 + 管理
    const top = UI.el('<div class="cat-row" style="margin-bottom:6px"></div>');
    pls.forEach(pl => {
      const b = UI.el(`<button class="cat${pl.id === plObj.id ? ' active' : ''}" data-f tabindex="-1">${pl.name}</button>`);
      b.onclick = () => { liveState.pl = pl.id; Live.setCurrentPl(pl.id); liveState.gIdx = 0; liveState.chIdx = -1; pageLive(); };
      top.appendChild(b);
    });
    const add = UI.el('<button class="cat" data-f tabindex="-1">+ 导入源</button>');
    add.onclick = () => { Live.setCurrentPl(''); liveState.pl = null; pageLive(); };
    top.appendChild(add);
    const del = UI.el('<button class="cat" data-f tabindex="-1">退订当前源</button>');
    del.onclick = () => { Live.removePlaylist(plObj.id); liveState.pl = null; pageLive(); toast('已退订'); };
    top.appendChild(del);
    root.appendChild(top);
    // 分组chips
    const gRow = UI.el('<div class="cat-row"></div>');
    liveState.groups.forEach((g, i) => {
      const b = UI.el(`<button class="cat${i === liveState.gIdx ? ' active' : ''}" data-f tabindex="-1">${g.name}(${g.channels.length})</button>`);
      b.onclick = () => { liveState.gIdx = i; liveState.chIdx = -1; renderLiveUI(pls, plObj); };
      gRow.appendChild(b);
    });
    root.appendChild(gRow);
    // 频道列表(带EPG)
    const g = liveState.groups[liveState.gIdx];
    const rows = UI.el('<div class="list-rows"></div>');
    g.channels.forEach((ch, ci) => {
      const row = UI.el(`<div class="list-row${ci === liveState.chIdx ? ' active-src' : ''}" data-f tabindex="-1">
        <span style="font-size:22px">📺</span>
        <div class="li-main">
          <div class="li-name">${ch.name}</div>
          <div class="li-sub epg-line" style="color:var(--muted)">节目单加载中…</div>
        </div>
        <div class="li-ops"><button class="mini-btn" data-op="play">▶ 播放</button></div>
      </div>`);
      row.onclick = e => {
        if (e.target.dataset && e.target.dataset.op === 'play') { e.stopPropagation(); playLive(ch, g); return; }
        playLive(ch, g);
      };
      rows.appendChild(row);
      // EPG 懒加载(可视区才查)
      setTimeout(() => {
        if (!row.isConnected) return;
        Live.fetchEpg(ch.name).then(epg => {
          const line = row.querySelector('.epg-line');
          if (!line || !row.isConnected) return;
          if (!epg) { line.textContent = '—'; return; }
          const nn = Live.nowNext(epg);
          line.textContent = nn && nn.now
            ? '正在播:' + nn.now.title + '(' + nn.now.start + ')' + (nn.next ? ' · 接下来:' + nn.next.title : '')
            : '暂无节目信息';
        }).catch(() => {
          const line = row.querySelector('.epg-line');
          if (line) line.textContent = '—';
        });
      }, ci * 120); // 轻限流
    });
    root.appendChild(rows);
    view().appendChild(root);
    KeyNav.focusFirst();
  }

  function playLive(ch, group) {
    const url = DB.getConfig().proxyMode ? API.proxied(ch.url) : ch.url;
    Player.open({
      key: 'live|' + ch.name, title: ch.name + ' · 直播', name: ch.name, pic: '',
      sourceId: 'live', vodId: ch.name, fromName: group.name,
      groups: [{ name: group.name, eps: [{ name: ch.name, url: url }] }],
      groupIndex: 0, epIndex: 0,
      onClose: () => {},
    });
    // 直播流自动隐藏控件
    setTimeout(() => { try { Player._liveMode && Player._liveMode(); } catch (e) {} }, 100);
    liveState.chIdx = group.channels.indexOf(ch);
    // 标题行显示 EPG
    Live.fetchEpg(ch.name).then(epg => {
      const nn = epg && Live.nowNext(epg);
      const t = document.querySelector('#player .t-name');
      if (t && nn && nn.now) t.textContent = ch.name + ' · ' + nn.now.title;
    }).catch(() => {});
  }

  /* ============ 搜索页 ============"""
assert old in s, 'search anchor missing'
s = s.replace(old, live_page, 1)
io.open(p, 'w', encoding='utf-8').write(s)
print('live page added')
