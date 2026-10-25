/* ================= 主应用:路由与页面 ================= */
/* 安卓本地/U盘文件桥:Java 选完文件并启动流服务后回调 */
window.__onLocalFile = function (url) {
  const name = '本地文件';
  Player.open({
    key: 'local|' + url, title: name, name: name, pic: '', sourceId: 'local', vodId: 'local', fromName: '本地',
    groups: [{ name: '本地文件', eps: [{ name: name, url: url }] }],
    groupIndex: 0, epIndex: 0,
  });
};

const App = (() => {
  const view = () => document.getElementById('view');
  /* 侧栏图标(线性 SVG,TVBox 风格竖排导航) */
  const ICONS = {
    home: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5L12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/></svg>',
    live: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13a10 10 0 0 1 14 0"/><path d="M8.5 16.5a5.5 5.5 0 0 1 7 0"/><circle cx="12" cy="19.5" r="1.4" fill="currentColor" stroke="none"/></svg>',
    drive: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 18a4.5 4.5 0 0 1-.4-9A6 6 0 0 1 17.8 8 4.5 4.5 0 0 1 17.5 18z"/></svg>',
    fav: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>',
    hist: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg>',
  };
  const TABS = [
    { id: 'home', name: '首页' },
    { id: 'live', name: '直播' },
    { id: 'drive', name: '网盘' },
    { id: 'fav', name: '收藏' },
    { id: 'hist', name: '历史' },
  ];
  let tab = 'home';
  let homeCache = new Map();   // srcId -> {classes, latest}
  let catCache = new Map();    // srcId|tid|pg -> data
  let searchSeq = 0;

  /* ============ 顶栏 ============ */
  function renderTabs() {
    const nav = document.getElementById('tabs');
    nav.innerHTML = '';
    TABS.forEach(t => {
      const b = document.createElement('button');
      b.className = 'tab' + (tab === t.id ? ' active' : '');
      b.dataset.f = ''; b.tabIndex = -1;
      b.textContent = t.name;
      b.onclick = () => go(t.id);
      nav.appendChild(b);
      if (t.name === '网盘') {
        let chipEl = document.getElementById('source-chip');
        if (!chipEl) {                        // 占位缺失时动态创建(兼容缓存的旧HTML)
          chipEl = document.createElement('button');
          chipEl.id = 'source-chip'; chipEl.className = 'chip';
          chipEl.dataset.f = ''; chipEl.tabIndex = -1; chipEl.title = '切换数据源';
        }
        chipEl.style.display = '';
        nav.appendChild(chipEl);              // 播放源紧跟网盘
      }
    });
    const chip = document.getElementById('source-chip');
    const cur = DB.getCurrentSource();
    chip.textContent = '播放源';
    chip.onclick = openSourceModal;
    document.getElementById('top-search').onclick = () => go('search');
    document.getElementById('top-set').onclick = () => go('set');
  }

  function go(id) {
    tab = id;
    renderTabs();
    if (id === 'home') pageHome();
    else if (id === 'search') pageSearch();
    else if (id === 'live') pageLive();
    else if (id === 'drive') pageDrive();
    else if (id === 'fav') pageFav();
    else if (id === 'hist') pageHist();
    else if (id === 'set') pageSet();
  }

  function toastErr(msg) { toast(msg, 'err'); }


  /* ============ 首页 ============ */
  function skeletonGrid() {
    const cards = Array.from({ length: 12 }, () =>
      '<div class="skel-card"><div class="skel-poster shimmer"></div><div class="skel-line shimmer"></div><div class="skel-line short shimmer"></div></div>').join('');
    return `<div class="grid">${cards}</div>`;
  }
  async function pageHome() {
    const src = DB.getCurrentSource();
    view().innerHTML = `<div class="row-head">为你推荐</div>` + skeletonGrid();
    KeyNav.focusFirst();

    try {
      if (!homeCache.has(src.id)) homeCache.set(src.id, await API.home(src));
      const { classes, latest } = homeCache.get(src.id);

      const root = UI.el('<div></div>');
      // 继续观看已并入「历史」页(带进度条与续播)
      // 分类快捷行(横向)
      if (classes.length) {
        const cats = UI.el('<section class="row-h"><div class="row-head">分类</div></section>');
        const cr = UI.el('<div class="cat-row"></div>');
        classes.slice(0, 14).forEach(c => {
          const b = UI.el(`<button class="cat" data-f tabindex="-1">${c.type_name}</button>`);
          b.onclick = () => pageCategory(c.type_id, c.type_name, 1);
          cr.appendChild(b);
        });
        cats.appendChild(cr);
        root.appendChild(cats);
      }
      // 最新(横向海报行)
      const sec = UI.el('<section class="row-h"><div class="row-head">最近更新</div></section>');
      const grid = UI.el('<div class="hscroll poster-scroll"></div>');
      latest.forEach(it => grid.appendChild(UI.card(it)));
      sec.appendChild(grid);
      root.appendChild(sec);

      view().innerHTML = '';
      view().appendChild(root);
      KeyNav.focusFirst();
    } catch (e) {
      view().innerHTML = '';
      view().appendChild(UI.empty('加载失败:' + (e.message || e) + '<br>请检查数据源接口是否可用', '重试', () => { homeCache.delete(src.id); pageHome(); }));
    }
  }


  /* ============ 分类页 ============ */
  async function pageCategory(tid, tname, pg = 1, append = false) {
    const src = DB.getCurrentSource();
    const key = src.id + '|' + tid + '|' + pg;
    if (!append) {
      view().innerHTML = `<div class="page-title">${tname}</div><div class="cat-row" id="cat-bar">${UI.spinner()}</div><div class="grid" id="cat-grid"></div>`;
      KeyNav.focusFirst();
    }
    let data;
    try {
      if (!catCache.has(key)) catCache.set(key, await API.category(src, tid, pg));
      data = catCache.get(key);
    } catch (e) {
      view().innerHTML = '';
      view().appendChild(UI.empty('分类加载失败:' + (e.message || e), '重试', () => pageCategory(tid, tname, 1)));
      return;
    }

    // 分类条:清掉加载圈,填充分类chips(当前分类高亮)
    const bar = document.getElementById('cat-bar');
    if (bar) {
      try {
        if (!homeCache.has(src.id)) homeCache.set(src.id, await API.home(src));
      } catch (_e) {}
      bar.innerHTML = '';
      const cls = (homeCache.get(src.id) || {}).classes || [];
      cls.forEach(c => {
        const b = UI.el(`<button class="cat${c.type_id === String(tid) ? ' active' : ''}" data-f tabindex="-1">${c.type_name}</button>`);
        b.onclick = () => pageCategory(c.type_id, c.type_name, 1);
        bar.appendChild(b);
      });
    }

    const grid = document.getElementById('cat-grid');
    data.list.forEach(it => grid.appendChild(UI.card(it)));

    // 加载更多
    const old = view().querySelector('.load-more');
    if (old) old.remove();
    if (data.pagecount && data.page < data.pagecount) {
      const lm = UI.el(`<div class="load-more"><button data-f tabindex="-1">加载更多(第${pg + 1}页)</button></div>`);
      lm.querySelector('button').onclick = () => pageCategory(tid, tname, pg + 1, true);
      view().appendChild(lm);
    }
    if (!data.list.length && !grid.children.length) view().appendChild(UI.empty('该分类暂无内容'));
  }

  /* 设备解码能力检测:4K/8K/HEVC/AV1/杜比视界/HDR10(绿=流畅硬解,白=可解,灰=不支持) */
  async function runCapTest() {
    const mc = navigator.mediaCapabilities;
    const withTimeout = function (p, ms, label) {
      return Promise.race([p, new Promise(function (res) { setTimeout(function () { res({ supported: false, smooth: false, hang: true }); }, ms); })]);
    };
    const test = async function (label, contentType, w, h, bitrate) {
      if (!mc || !mc.decodingInfo) return '<span class="cap-no">' + label + ':不支持检测</span>';
      try {
        const cfg = { type: 'file', video: { contentType: contentType, width: w, height: h, bitrate: bitrate, framerate: 30 } };
        const r = (await withTimeout(mc.decodingInfo(cfg), 6000));
        if (r.hang) return '<span class="cap-no">? ' + label + ':检测超时</span>';
        if (r.smooth) return '<span class="cap-ok">✔ ' + label + '(流畅硬解)</span>';
        if (r.supported) return '<span style="color:#e5e5ea">○ ' + label + '(可解,可能卡)</span>';
        return '<span class="cap-no">✘ ' + label + ':不支持</span>';
      } catch (e) { return '<span class="cap-no">✘ ' + label + ':检测失败</span>'; }
    };
    const rows = [];
    rows.push(await test('4K H.264', 'video/mp4; codecs="avc1.640033"', 3840, 2160, 25000000));
    rows.push(await test('4K HEVC/H.265', 'video/mp4; codecs="hvc1.1.6.L153.B0"', 3840, 2160, 30000000));
    rows.push(await test('4K VP9', 'video/webm; codecs="vp09.00.51.08"', 3840, 2160, 30000000));
    rows.push(await test('4K AV1', 'video/mp4; codecs="av01.0.13M.08"', 3840, 2160, 30000000));
    rows.push(await test('8K H.264', 'video/mp4; codecs="avc1.640034"', 7680, 4320, 60000000));
    const msOk = function (t) { try { return window.MediaSource && MediaSource.isTypeSupported(t); } catch (e) { return false; } };
    rows.push(msOk('video/mp4; codecs="dvh1.05.07"') ? '<span class="cap-ok">✔ 杜比视界(MSE)</span>' : '<span class="cap-no">✘ 杜比视界:不支持</span>');
    rows.push(msOk('video/mp4; codecs="hvc1.2.4.L153.B0"') ? '<span class="cap-ok">✔ HEVC HDR10(容器)</span>' : '<span class="cap-no">✘ HDR10(MSE):不支持</span>');
    return rows.join('<br>');
  }

  /* ============ 直播(IPTV)页 ============ */
  const liveState = { pl: null, groups: [], gIdx: 0, chIdx: -1, showImport: false };

  async function pageLive() {
    view().innerHTML = `<div class="page-title">直播 <span class="sub">IPTV · M3U/txt 源 · EPG 节目单</span></div>` + UI.spinner();
    // 无列表 → 引导
    const pls = Live.getPlaylists();
    if (!liveState.pl && pls.length) liveState.pl = Live.currentPl() || pls[0].id;
    if (!pls.length || liveState.showImport) {
      view().innerHTML = '';
      const box = UI.el('<div></div>');
      box.appendChild(UI.el('<div class="hint" style="margin-bottom:12px">导入 M3U / txt 直播源,或选择内置源:</div>'));
      const row = UI.el('<div class="cat-row"></div>');
      Live.PRESETS.forEach(pr => {
        const b = UI.el(`<button class="cat" data-f tabindex="-1">${pr.name}</button>`);
        b.onclick = async () => {
          toast('正在拉取直播源…');
          try {
            const text = await liveFetchText(pr.url);
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
      const addAll = UI.el('<div style="margin-top:12px"><button class="btn primary" id="live-add-all" data-f tabindex="-1">一键添加全部推荐源</button></div>');
      addAll.querySelector('button').onclick = async () => {
        if (window.toast) toast('正在添加推荐直播源…');
        for (const pr of Live.PRESETS) {
          if (pr.url === '/live-demo.txt') continue;   // 演示源不自动加
          try {
            const text = await liveFetchText(pr.url);
            Live.addPlaylist(pr.name, pr.url, text);
          } catch (e) { /* 单个失败继续 */ }
        }
        liveState.showImport = false;
        if (window.toast) toast('推荐源添加完成');
        pageLive();
      };
      box.appendChild(addAll);
      const manual = UI.el('<div class="section" style="margin-top:14px"><h3>手动导入</h3><div class="form">' +
        '<input id="live-url" data-f tabindex="-1" placeholder="M3U/txt 地址(http://…)">' +
        '<button class="btn primary" id="live-add-url" data-f tabindex="-1">导入URL</button></div>' +
        '<div class="form" style="margin-top:10px"><textarea id="live-text" data-f tabindex="-1" placeholder="…或粘贴 M3U(#EXTINF…)/txt(频道名,地址) 内容"></textarea>' +
        '<button class="btn" id="live-add-text" data-f tabindex="-1">导入文本</button></div>' +
        '<div class="hint">支持 TVBox 配置里 lives 段的 m3u/txt;分组识别 #EXTINF group-title 与 组名,#genre# 两种格式。EPG 节目单自动匹配(51zmt 数据源)。</div></div>');
      if (pls.length) {
        const back = UI.el('<div style="margin-top:12px"><button class="btn" data-f tabindex="-1">取消</button></div>');
        back.querySelector('button').onclick = () => { liveState.showImport = false; pageLive(); };
        box.appendChild(back);
      }
      box.appendChild(manual);
      view().appendChild(box);
      bindLiveImport();
      KeyNav.focusFirst();
      return;
    }
    // 加载列表
    const plObj = pls.find(x => x.id === liveState.pl) || pls[0];
    if (!plObj) { liveState.pl = null; pageLive(); return; }
    try {
      let text = plObj.text || '';
      if ((!text || /^proxy error/i.test(text)) && plObj.url) text = await liveFetchText(plObj.url);
      const groups = Live.parsePlaylist(text);
      if (!groups.length) {
        throw new Error(/^#EXTM3U/i.test(text.trim())
          ? '该源只有M3U头部、没有频道列表(源可能已失效)'
          : '未解析到频道(检查格式)');
      }
      liveState.groups = groups;
    } catch (e) {
      view().innerHTML = '';
      view().appendChild(UI.empty('直播源加载失败:' + (e.message || e), '重试', () => { liveState.pl = null; pageLive(); }));
      return;
    }
    renderLiveUI(pls, plObj);
  }

  /* 直播源拉取:校验内容有效;失败自动经 ghproxy 镜像重试 */
  async function liveFetchText(url) {
    const looksOk = t => t && t.length > 30 && !/^proxy error/i.test(t) &&
      (/#EXTM3U|#EXTINF|#genre#|^https?:\/\/\/?(\S+\s*,\s*https?:)|,/m.test(t));
    const tryFetch = async u => {
      const r = await fetch(/^https?:/i.test(u) ? ('/proxy/' + u) : u);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    };
    let text = '';
    try { text = await tryFetch(url); } catch (e) { text = ''; }
    if (looksOk(text)) return text;
    if (/^https?:\/\/raw\.githubusercontent\.com/i.test(url)) {
      const mirror = 'https://ghproxy.net/' + url;
      try { text = await tryFetch(mirror); } catch (e) { text = text || ''; }
      if (looksOk(text)) return text;
    }
    throw new Error((text && /^proxy error/i.test(text)) ? '上游连接被重置' : '内容无效或拉取失败');
  }

  function bindLiveImport() {
    const b1 = view().querySelector('#live-add-url');
    if (b1) b1.onclick = async () => {
      const url = view().querySelector('#live-url').value.trim();
      if (!/^https?:/i.test(url)) { toastErr('请填写 http(s) 地址'); return; }
      toast('正在拉取…');
      try {
        const text = await liveFetchText(url);
        const r = Live.addPlaylist(url.split('/').pop().slice(0, 24), url, text);
        if (!r.ok) { toastErr(r.msg); return; }
        liveState.pl = r.id; Live.setCurrentPl(r.id); liveState.showImport = false;
        toast('导入成功'); pageLive();
      } catch (e) { toastErr('拉取失败:' + (e.message || e)); }
    };
    const b2 = view().querySelector('#live-add-text');
    if (b2) b2.onclick = () => {
      const text = view().querySelector('#live-text').value.trim();
      if (!text) { toastErr('请粘贴内容'); return; }
      const r = Live.addPlaylist('手动导入', '', text);
      if (!r.ok) { toastErr(r.msg); return; }
      liveState.pl = r.id; Live.setCurrentPl(r.id); liveState.showImport = false;
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
    add.onclick = () => { liveState.showImport = true; pageLive(); };
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
      const lineBadge = (ch.urls && ch.urls.length > 1) ? ` <span style="color:var(--muted);font-size:11px">${ch.urls.length}线路</span>` : '';
      const row = UI.el(`<div class="list-row${ci === liveState.chIdx ? ' active-src' : ''}" data-f tabindex="-1">
        <span style="font-size:22px">📺</span>
        <div class="li-main">
          <div class="li-name">${ch.name}${lineBadge}</div>
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

  function playLive(ch, group, startLine) {
    const urls = (ch.urls && ch.urls.length ? ch.urls : [ch.url]);
    /* ottiltv(虎牙/斗鱼/B站/YY)裸地址 302 到 FLV,浏览器不能直解;同地址有 HLS 版 */
    const fixLive = function (u) {
      if (/live\.ottiptv\.cc\/[a-z]+\/\d+$/i.test(u)) return u + '.m3u8';
      return u;
    };
    const groups = urls.map(function (u, i) {
      return { name: '线路' + (i + 1), eps: [{ name: ch.name, url: (function(x){ return DB.getConfig().proxyMode ? API.proxied(x) : x; })(fixLive(u)) }] };
    });
    const gi = Math.min(startLine || 0, groups.length - 1);
    Player.open({
      key: 'live|' + ch.name, title: ch.name + ' · 直播', name: ch.name, pic: '',
      sourceId: 'L' + gi, vodId: ch.name, fromName: group.name, liveMode: true,
      groups: groups,
      groupIndex: gi, epIndex: 0,
      onFindSources: function () {
        return urls.map(function (u, i) { return { srcId: 'L' + i, srcName: '线路' + (i + 1), vodId: ch.name, name: ch.name, remarks: '', ms: 0 }; });
      },
      onPlayFromSource: function (entry) {
        const i = Number(String(entry.srcId || 'L0').slice(1)) || 0;
        playLive(ch, group, i);
      },
      onClose: () => { clearTimeout(liveState._watch); },
    });
    /* 线路看门狗:45秒未出画 → 直接切下一线路(不依赖播放器内部换源链) */
    clearTimeout(liveState._watch);
    liveState._watch = setTimeout(() => {
      const v = document.querySelector('#player video');
      if (!v || !document.getElementById('player')) return;   // 已关或已换
      if (v.paused || v.readyState < 2) {
        const next = (startLine || 0) + 1;
        if (next < urls.length) {
          if (window.toast) toast('线路' + ((startLine || 0) + 1) + '无响应,切换线路' + (next + 1));
          playLive(ch, group, next);
        } else if (window.toast) {
          toast('所有线路均无响应');
        }
      }
    }, 45000);
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

  /* ============ 搜索页 ============ */
  let searchMode = 'all';   // 'cur' | 'all'
  let searchSort = 'speed'; // 'speed' | 'quality'
  function pageSearch() {
    view().innerHTML = `
      <div class="page-title">搜索 <span class="sub">支持拼音/拼音首字母(如 dxt → 大雄兔)</span></div>
      <div class="cat-row" id="search-mode">
        <button class="cat${searchMode === 'all' ? ' active' : ''}" data-mode="all" data-f tabindex="-1">🌐 全源聚合</button>
        <button class="cat${searchMode === 'cur' ? ' active' : ''}" data-mode="cur" data-f tabindex="-1">📡 当前源</button>
        <button class="cat${searchSort === 'speed' ? ' active' : ''}" data-sort="speed" data-f tabindex="-1" title="按解析速度排序">⚡ 速度优先</button>
        <button class="cat${searchSort === 'quality' ? ' active' : ''}" data-sort="quality" data-f tabindex="-1" title="按清晰度排序">🎬 清晰度优先</button>
      </div>
      <div class="search-bar">
        <input id="kw" data-f tabindex="-1" placeholder="输入片名,方向键选择,Enter 搜索" />
        <button class="btn primary" id="do-search" data-f tabindex="-1">搜索</button>
      </div>
      <div class="hot-words" id="hot"></div>
      <div id="search-result"></div>`;

    view().querySelector('#search-mode').addEventListener('click', e => {
      const b = e.target.closest('[data-mode],[data-sort]');
      if (!b) return;
      if (b.dataset.mode) {
        searchMode = b.dataset.mode;
        view().querySelectorAll('#search-mode [data-mode]').forEach(x => x.classList.toggle('active', x === b));
      } else {
        searchSort = b.dataset.sort;
        view().querySelectorAll('#search-mode [data-sort]').forEach(x => x.classList.toggle('active', x === b));
      }
    });

    const hots = ['大雄兔', '辛特尔', '大象的梦想', '钢之泪', '狂飙'];
    const hot = view().querySelector('#hot');
    hots.forEach(w => {
      const b = UI.el(`<button class="cat" data-f tabindex="-1">${w}</button>`);
      b.onclick = () => { view().querySelector('#kw').value = w; doSearch(w); };
      hot.appendChild(b);
    });
    view().querySelector('#do-search').onclick = () => doSearch(view().querySelector('#kw').value.trim());
    view().querySelector('#kw').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(e.target.value.trim()); });
  }

  async function doSearch(wd) {
    if (!wd) { toastErr('请输入关键词'); return; }
    const seq = ++searchSeq;
    const box = view().querySelector('#search-result');
    if (!box) return;
    box.innerHTML = UI.spinner();

    if (searchMode === 'cur') {
      const src = DB.getCurrentSource();
      try {
        const r = await API.search(src, wd);
        if (seq !== searchSeq) return;
        box.innerHTML = '';
        if (!r.list.length) { box.appendChild(UI.empty(`「${wd}」没有找到结果,试试别的词或换源`)); return; }
        box.appendChild(UI.el(`<div class="src-head">${src.name} · ${r.list.length} 条</div>`));
        const grid = UI.el('<div class="grid"></div>');
        r.list.forEach(it => grid.appendChild(UI.card(it)));
        box.appendChild(grid);
        KeyNav.focusFirst(grid);
      } catch (e) {
        if (seq !== searchSeq) return;
        box.innerHTML = '';
        box.appendChild(UI.empty('搜索失败:' + (e.message || e)));
      }
      return;
    }

    // 全源聚合(纯字母关键词 → 拼音首字母/全拼模式:各源分类列表本地匹配)
    const pyMode = /^[a-zA-Z]{2,}$/.test(wd);
    try {
      const groups = await (pyMode ? API.searchPinyinAll(wd) : API.searchAll(wd));
      if (seq !== searchSeq) return;
      box.innerHTML = '';
      const okGroups = groups.filter(g => !g.error && g.list.length);
      const errGroups = groups.filter(g => g.error);
      const total = okGroups.reduce((s, g) => s + g.list.length, 0);
      const summary = UI.el(`<div class="src-head">🌐 全源聚合${pyMode ? ' · 拼音模式(' + wd.toUpperCase() + ')' : ''} · ${DB.getSources().length} 个源 · 命中 ${okGroups.length} 源 ${total} 条${errGroups.length ? ' · 失败 ' + errGroups.length + ' 源' : ''}</div>`);
      box.appendChild(summary);
      if (pyMode) box.appendChild(UI.el('<div class="hint" style="margin:6px 0 10px">拼音模式:并发扫描各源最近更新与影视主分类(约 400 部/源)按首字母/全拼匹配;较老的片建议直接用中文片名搜索</div>'));

      if (!okGroups.length) {
        box.appendChild(UI.empty(`「${wd}」所有源都没有找到结果`));
        return;
      }
      // 排序:速度优先(响应快在前) / 清晰度优先(最高画质备注在前)
      okGroups.forEach(g => {
        g.bestQ = Math.max(...g.list.map(it => API.qualityRank(it.remarks)));
      });
      if (searchSort === 'quality') okGroups.sort((a, b) => b.bestQ - a.bestQ || a.ms - b.ms);
      else okGroups.sort((a, b) => a.ms - b.ms);
      okGroups.forEach(g => {
        if (searchSort === 'quality') {
          g.list.sort((a, b) => API.qualityRank(b.remarks) - API.qualityRank(a.remarks));
        }
        const head = UI.el(`<div class="src-head">${g.srcName} <span class="sub" style="font-weight:400;color:var(--muted);font-size:12px">${g.list.length} 条 · ${g.ms}ms · 最高${{6:'蓝光',5:'1080P',4:'超清',3:'正片',2:'普通',1:'抢先'}[g.bestQ] || '未知'}</span></div>`);
        box.appendChild(head);
        const grid = UI.el('<div class="grid"></div>');
        g.list.slice(0, 12).forEach(it => grid.appendChild(UI.card(it)));
        box.appendChild(grid);
      });
      if (errGroups.length) {
        box.appendChild(UI.el(`<div class="hint" style="margin-top:14px">以下源搜索失败:${errGroups.map(g => g.srcName + '(' + g.error + ')').join('、')}</div>`));
      }
      KeyNav.focusFirst(box);
    } catch (e) {
      if (seq !== searchSeq) return;
      box.innerHTML = '';
      box.appendChild(UI.empty('聚合搜索失败:' + (e.message || e)));
    }
  }

  /* ============ 网盘页(WebDAV) ============ */
  const driveState = { driveId: null, path: '/', fid: null };
  const VIDEO_EXT = /\.(mp4|mkv|webm|mov|m3u8|flv|avi|ts)(\?|$)/i;

  function pageDrive() {
    const drives = DB.getDrives();
    view().innerHTML = `
      <div class="page-title">网盘 <span class="sub">WebDAV / SMB(Alist 可聚合阿里云盘/夸克/百度/115)· 本地U盘即插即播</span></div>
      <div style="display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap;align-items:center">
        <button class="btn" id="local-pick" data-f tabindex="-1">本地 / U 盘播放</button>
        <div class="cat-row" style="padding:0;margin:0" id="wall-mode">
          <button class="cat${driveState.wall ? '' : ' active'}" data-mode="list" data-f tabindex="-1">列表</button>
          <button class="cat${driveState.wall ? ' active' : ''}" data-mode="wall" data-f tabindex="-1">海报墙(刮削)</button>
        </div>
        <input type="file" id="local-file" accept="video/*,.m2ts,.ts,.mkv,.m3u8" style="display:none">
      </div>
      <div id="drive-area"></div>`;
    const area = view().querySelector('#drive-area');
    view().querySelector('#wall-mode').addEventListener('click', e => {
      const b = e.target.closest('[data-mode]');
      if (!b) return;
      driveState.wall = b.dataset.mode === 'wall';
      pageDrive();
    });
    // 本地/U盘:PC 走 objectURL;安卓 WebView 由 Java onShowFileChooser 接管并回调 __onLocalFile
    view().querySelector('#local-pick').onclick = () => view().querySelector('#local-file').click();
    view().querySelector('#local-file').onchange = e => {
      const f = e.target.files[0];
      if (!f) return;
      const url = URL.createObjectURL(f);
      Player.open({
        key: 'local|' + f.name + '|' + f.size, title: f.name, name: f.name, pic: '', sourceId: 'local', vodId: 'local', fromName: '本地',
        groups: [{ name: '本地文件', eps: [{ name: f.name, url: url }] }],
        groupIndex: 0, epIndex: 0,
      });
      e.target.value = '';
    };
    // 云盘账号(阿里扫码/夸克Cookie)也作为驱动出现
    const clouds = (window.Cloud ? Cloud.list() : []).map((c, i) => ({ id: 'cloud' + i, name: c.name + ' · 云盘', cloud: c }));
    const all = clouds.concat(drives);
    if (!all.length) {
      area.appendChild(UI.empty('还没有挂载网盘', '去设置里挂载', () => go('set')));
      return;
    }
    // 选择器
    if (!driveState.driveId || !all.find(d => d.id === driveState.driveId)) driveState.driveId = all[0].id;
    const cr = UI.el('<div class="cat-row" id="drive-chips"></div>');
    all.forEach(d => {
      const b = UI.el(`<button class="cat${d.id === driveState.driveId ? ' active' : ''}" data-f tabindex="-1">${d.name}</button>`);
      b.onclick = () => { driveState.driveId = d.id; driveState.path = '/'; driveState.fid = null; pageDrive(); };
      cr.appendChild(b);
    });
    area.appendChild(cr);
    const browser = UI.el('<div id="dav-browser"></div>');
    area.appendChild(browser);
    const cur = all.find(d => d.id === driveState.driveId);
    if (cur.cloud) browseCloud(cur.cloud, browser);
    else browseDav(cur, driveState.path, browser);
    KeyNav.focusFirst();
  }

  /* ============ 云盘(阿里/夸克)浏览 ============ */
  async function browseCloud(acct, box) {
    box.innerHTML = UI.spinner();
    try {
      const r = await Cloud.browse(acct, driveState.fid);
      const items = (r.list || []).filter(x => x.name);
      items.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, 'zh'));
      box.innerHTML = '';
      if (driveState.fid) {
        const up = UI.el('<button class="cat" style="font-size:13px;padding:5px 12px;margin-bottom:12px" data-f tabindex="-1">← 返回上级</button>');
        up.onclick = () => { driveState.fid = null; pageDrive(); };
        box.appendChild(up);
      }
      if (driveState.wall) { renderCloudWall(acct, items, box); return; }
      const rows = UI.el('<div class="list-rows"></div>');
      items.forEach(it => {
        const isVideo = !it.dir && VIDEO_EXT.test(it.name);
        const is4k = /2160|4k|uhd|remux/i.test(it.name) || it.size > 8e9;
        const sizeTxt = it.dir ? '文件夹' : fmtCloudSize(it.size);
        const row = UI.el(`<div class="list-row" data-f tabindex="-1">
          <span style="font-size:26px">${it.dir ? '📁' : (isVideo ? '🎬' : '📄')}</span>
          <div class="li-main">
            <div class="li-name">${it.name}</div>
            <div class="li-sub">${sizeTxt}${isVideo && is4k ? ' · <b style="color:#7cc4ff">4K</b>' : ''}</div>
          </div>
          ${isVideo ? '<div class="li-ops"><button class="mini-btn" data-op="play">▶ 播放</button></div>' : ''}
        </div>`);
        row.onclick = e => {
          if (e.target.dataset && e.target.dataset.op === 'play') { e.stopPropagation(); playCloudFile(acct, it); return; }
          if (it.dir) { driveState.fid = it.fid; pageDrive(); }
          else if (isVideo) playCloudFile(acct, it);
        };
        rows.appendChild(row);
      });
      if (!items.length) box.appendChild(UI.empty('此目录为空'));
      box.appendChild(rows);
      KeyNav.focusFirst(box);
    } catch (e) {
      box.innerHTML = '';
      box.appendChild(UI.empty('云盘访问失败:' + (e.message || e), '重试', () => pageDrive()));
    }
  }

  /* 云盘视频播放:先取直链再交给播放器(直链经本机 /cloud/dl 中转,支持拖动) */
  async function playCloudFile(acct, it) {
    if (window.toast) toast('正在获取直链…');
    try {
      const url = await Cloud.playUrl(acct, it.fid);
      Player.open({
        key: 'cloud|' + acct.kind + '|' + it.fid,
        title: it.name, name: it.name, pic: it.url || '', sourceId: 'local', vodId: it.fid, fromName: acct.name,
        groups: [{ name: '正片', eps: [{ name: it.name, url: url }] }],
        groupIndex: 0, epIndex: 0,
      });
    } catch (e) { toast('获取直链失败:' + (e.message || e)); }
  }

  function fmtCloudSize(n) {
    if (!n) return '';
    if (n > 1e9) return (n / 1e9).toFixed(1) + 'GB';
    return (n / 1024 / 1024).toFixed(1) + 'MB';
  }

  /* 云盘海报墙:4K/大文件优先刮削展示 */
  function renderCloudWall(acct, items, box) {
    const videos = items.filter(x => !x.dir && VIDEO_EXT.test(x.name));
    const dirs = items.filter(x => x.dir);
    const grid = UI.el('<div class="grid"></div>');
    dirs.forEach(d => {
      const c = UI.el('<div class="card" data-f tabindex="-1"><div class="poster"><div class="poster-empty" style="display:flex;align-items:center;justify-content:center;height:100%;font-size:34px">📁</div></div><div class="title">' + d.name + '</div></div>');
      c.onclick = () => { driveState.fid = d.fid; pageDrive(); };
      grid.appendChild(c);
    });
    box.appendChild(grid);
    if (!videos.length) { box.appendChild(UI.empty('此目录没有视频文件')); return; }
    const nodes = [];
    videos.forEach(f => {
      const is4k = /2160|4k|uhd|remux/i.test(f.name) || f.size > 8e9;
      const c = UI.el('<div class="card" data-f tabindex="-1"><div class="poster"><div class="poster-empty shimmer" style="height:100%"></div></div><div class="title">' + f.name + '</div></div>');
      c.onclick = () => playCloudFile(acct, f);
      if (is4k) {
        const b = document.createElement('div');
        b.className = 'remark'; b.textContent = '4K';
        b.style.background = 'linear-gradient(90deg,#0e4a8a,#1d7fd6)';
        c.querySelector('.poster').appendChild(b);
      }
      grid.appendChild(c);
      nodes.push({ node: c, file: f });
    });
    if (!DB.getConfig().scrapeOn) return;
    let idx = 0;
    const worker = async () => {
      while (idx < nodes.length) {
        const cur = nodes[idx++];
        try {
          const meta = await Scraper.scrapeFile(cur.file.name);
          if (!meta || !cur.node.isConnected) continue;
          if (!cur.node.querySelector('.remark')) {
            cur.node.querySelector('.poster').innerHTML = '<img src="' + (meta.poster || window.IMG_FB) + '" ' + IMG_ERR + '>';
            const badge = document.createElement('div');
            badge.className = 'remark';
            badge.textContent = meta.rating ? '★ ' + meta.rating : (meta.year || '未匹配');
            cur.node.querySelector('.poster').appendChild(badge);
          } else {
            cur.node.querySelector('.poster').insertAdjacentHTML('afterbegin', '<img src="' + (meta.poster || window.IMG_FB) + '" ' + IMG_ERR + ' style="position:absolute;inset:0">');
          }
          cur.node.querySelector('.title').textContent = meta.title + (meta.year ? ' (' + meta.year + ')' : '');
        } catch (e) {}
      }
    };
    worker(); worker(); worker();
  }

  async function browseDav(drive, sub, box) {
    box.innerHTML = UI.spinner();
    try {
      let list;
      if (API.IN_APP && drive.type === 'smb') throw new Error('SMB 需在电脑端(桌面版/浏览器)使用');
      if (API.IN_APP) {
        list = await API.listDriveDirect(drive, sub);          // App:JS 直连
      } else if (drive.type === 'smb') {
        const fullPath = (drive.url + sub).replace(/[\/]+$/, '');
        const q = 'p=' + encodeURIComponent(fullPath);
        const r = await fetch('/naslist?' + q).then(x => x.json());
        if (r.error && !r.list.length) throw new Error(r.error);
        list = r.list.map(x => ({ name: x.name, path: x.path, dir: x.dir, size: x.size }));
      } else if (drive.type === 'alist') {
        const q = 'u=' + encodeURIComponent(drive.url) + '&p=' + encodeURIComponent(sub) + '&t=' + encodeURIComponent(DB.driveAuth(drive));
        const r = await fetch('/alist?' + q).then(x => x.json());
        if (r.error) throw new Error(r.error);
        list = r.list;
      } else {
        const auth = btoa(unescape(encodeURIComponent(DB.driveAuth(drive))));
        const q = 'u=' + encodeURIComponent(drive.url) + '&p=' + encodeURIComponent(sub) + '&a=' + encodeURIComponent(auth);
        const r = await fetch('/webdav?' + q).then(x => x.json());
        if (r.error && !r.list.length) throw new Error(r.error);
        list = r.list;
      }
      box.innerHTML = '';
      // 面包屑
      const crumbs = UI.el('<div class="crumbs" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;font-size:13.5px;color:var(--muted)"></div>');
      const parts = sub.split('/').filter(Boolean);
      const mk = (label, p) => {
        const b = UI.el(`<button class="cat" style="font-size:13px;padding:5px 12px" data-f tabindex="-1">${label}</button>`);
        b.onclick = () => { driveState.path = p; pageDrive(); };
        crumbs.appendChild(b);
      };
      mk('🏠 根目录', '/');
      parts.forEach((seg, i) => mk(seg, '/' + parts.slice(0, i + 1).join('/') + '/'));
      box.appendChild(crumbs);

      const items = list.filter(x => x.name);
      items.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, 'zh'));
      driveState.curItems = items; driveState.curDriveId = drive.id;
      if (items.some(x => x.name.toUpperCase() === 'BDMV')) {
        box.appendChild(UI.el('<div class="hint" style="margin-bottom:10px">💡 检测到蓝光原盘结构:进入 BDMV → STREAM,选择体积最大的 .m2ts 即为正片</div>'));
      }
      if (driveState.wall) { renderWall(drive, sub, items, box); return; }
      const rows = UI.el('<div class="list-rows"></div>');
      items.forEach(it => {
        const isVideo = !it.dir && VIDEO_EXT.test(it.name);
        const sizeTxt = it.dir ? '文件夹' : ((it.size / 1024 / 1024).toFixed(1) + 'MB');
        const row = UI.el(`<div class="list-row" data-f tabindex="-1">
          <span style="font-size:26px">${it.dir ? '📁' : (isVideo ? '🎬' : '📄')}</span>
          <div class="li-main">
            <div class="li-name">${it.name}</div>
            <div class="li-sub">${sizeTxt}</div>
          </div>
          ${isVideo ? '<div class="li-ops"><button class="mini-btn" data-op="play">▶ 播放</button></div>' : ''}
        </div>`);
        row.onclick = e => {
          if (e.target.dataset && e.target.dataset.op === 'play') { e.stopPropagation(); playDavFile(drive, it, sub); return; }
          if (it.dir) { driveState.path = it.path.startsWith('/') ? it.path : sub.replace(/\/$/, '') + '/' + it.name + '/'; pageDrive(); }
          else if (isVideo) playDavFile(drive, it, sub);
        };
        rows.appendChild(row);
      });
      if (!items.length) box.appendChild(UI.empty('此目录为空'));
      box.appendChild(rows);
      KeyNav.focusFirst(box);
    } catch (e) {
      box.innerHTML = '';
      box.appendChild(UI.empty('网盘访问失败:' + (e.message || e) + '<br>请检查地址/Token/账号密码', '重试', () => pageDrive()));
    }
  }

  /* 海报墙:视频文件刮削(豆瓣)→ 海报卡片 */
  function renderWall(drive, sub, items, box) {
    const videos = items.filter(function (x) { return !x.dir && VIDEO_EXT.test(x.name); });
    const dirs = items.filter(function (x) { return x.dir; });
    const grid = UI.el('<div class="grid"></div>');
    dirs.forEach(function (d) {
      const c = UI.el('<div class="card" data-f tabindex="-1"><div class="poster"><div class="poster-empty" style="display:flex;align-items:center;justify-content:center;height:100%;font-size:34px">📁</div></div><div class="title">' + d.name + '</div></div>');
      c.onclick = function () { driveState.path = d.path.indexOf('/') === 0 ? d.path : sub.replace(/\/$/, '') + '/' + d.name + '/'; pageDrive(); };
      grid.appendChild(c);
    });
    box.appendChild(grid);
    if (!videos.length) { box.appendChild(UI.empty('此目录没有视频文件')); return; }
    const nodes = [];
    videos.forEach(function (f) {
      const c = UI.el('<div class="card" data-f tabindex="-1"><div class="poster"><div class="poster-empty shimmer" style="height:100%"></div></div><div class="title">' + f.name + '</div></div>');
      c.onclick = function () { playDavFile(drive, f, sub); };
      grid.appendChild(c);
      nodes.push({ node: c, file: f });
    });
    if (!DB.getConfig().scrapeOn) return;
    let idx = 0;
    const worker = async function () {
      while (idx < nodes.length) {
        const cur = nodes[idx++];
        try {
          const meta = await Scraper.scrapeFile(cur.file.name);
          if (!meta || !cur.node.isConnected) continue;
          const poster = meta.poster || window.IMG_FB;
          cur.node.querySelector('.poster').innerHTML = '<img src="' + poster + '" ' + IMG_ERR + '>';
          const badge = document.createElement('div');
          badge.className = 'remark';
          badge.textContent = meta.rating ? '★ ' + meta.rating : (meta.year || '未匹配');
          cur.node.querySelector('.poster').appendChild(badge);
          cur.node.querySelector('.title').textContent = meta.title + (meta.year ? ' (' + meta.year + ')' : '');
          cur.node.title = meta.fileName;
          cur.node.onclick = function () { openLocalDetail(meta, drive, cur.file, sub); };
        } catch (e) { /* 单个失败忽略 */ }
      }
    };
    worker(); worker(); worker();
  }

  /* 刮削详情视图:评分/简介/演员表 + 播放 */
  function openLocalDetail(meta, drive, file, sub) {
    const url = davFileUrl(drive, file, sub);
    const ratingTxt = meta.rating
      ? ('<b style="color:#fff;font-size:20px">' + Number(meta.rating).toFixed(1) + '</b> <span style="color:var(--muted)">' + (meta.ratingCount ? Math.round(meta.ratingCount / 10000 * 10) / 10 + '万人评' : '') + '</span>')
      : '<span style="color:var(--muted)">暂无评分</span>';
    view().innerHTML = '';
    const page = UI.el('<div class="detail">' +
      '<div class="backdrop" style="background-image:url(\'' + (meta.poster || '') + '\')"></div>' +
      '<div class="detail-head">' +
      '<img class="detail-poster" src="' + (meta.poster || window.IMG_FB) + '" ' + IMG_ERR + '>' +
      '<div class="detail-info">' +
      '<h1>' + (meta.title || file.name) + '</h1>' +
      '<div class="meta-lines">' + ratingTxt + '<br>' +
      (meta.cardSubtitle || [meta.year, (meta.countries || []).join(' '), (meta.genres || []).join(' ')].filter(Boolean).join(' · ')) +
      (meta.directors && meta.directors.length ? '<br>导演:' + meta.directors.join(' / ') : '') +
      (meta.cast && meta.cast.length ? '<br>主演:' + meta.cast.join(' / ') : '') +
      '</div>' +
      '<div class="detail-actions">' +
      '<button class="btn primary" id="btn-play" data-f tabindex="-1">播放本文件</button>' +
      '</div>' +
      '<div class="intro">' + (meta.intro || '暂无简介') + '</div>' +
      '</div></div></div>');
    view().appendChild(page);
    page.querySelector('#btn-play').onclick = function () {
      Player.open({
        key: 'local|' + file.name + '|' + (file.size || 0),
        title: (meta.title || file.name) + ' · ' + file.name,
        name: meta.title || file.name,
        pic: meta.poster || '',
        sourceId: 'local', vodId: file.name, fromName: drive.name,
        groups: [{ name: '正片', eps: [{ name: file.name, url: url }] }],
        groupIndex: 0, epIndex: 0,
      });
    };
    KeyNav.focusFirst(page);
  }

  /* 网盘/本地文件的播放地址(按驱动类型) */
  function davFileUrl(drive, item, base) {
    let url;
    const filePath = item.path.indexOf('/') === 0 ? item.path : base.replace(/\/$/, '') + '/' + item.name;
    if (API.IN_APP) {
      if (drive.type === 'alist') url = drive.url + '/d' + filePath;
      else url = drive.url + filePath;
      return url;
    }
    if (drive.type === 'smb') {
      const raw = '/nasfile?p=' + encodeURIComponent(filePath);
      return /\.(m2ts|ts)$/i.test(filePath) ? '/tslist?p=' + encodeURIComponent(filePath) + '&seg=10' : raw;
    }
    if (drive.type === 'alist') {
      const auth = DB.driveAuth(drive) ? '&h=' + encodeURIComponent('Authorization: ' + DB.driveAuth(drive)) : '';
      return DB.getConfig().proxyMode
        ? '/proxy?u=' + encodeURIComponent(drive.url + '/d' + filePath) + auth
        : drive.url + '/d' + filePath;
    }
    const auth = DB.driveAuth(drive) ? ('&a=' + encodeURIComponent(btoa(unescape(encodeURIComponent(DB.driveAuth(drive)))))) : '';
    return DB.getConfig().proxyMode
      ? '/proxy?u=' + encodeURIComponent(drive.url + filePath) + auth
      : drive.url + filePath;
  }

  /* 同名字幕检测:同目录下 basename 相同的 .srt/.vtt/.ass */
  const SUB_EXT = /\.(srt|vtt|ass|ssa)$/i;
  function siblingSubs(drive, item, base, allItems) {
    const base2 = item.name.replace(/\.[^.]+$/, '').toLowerCase();
    const pool = allItems || (driveState.curDriveId === drive.id ? (driveState.curItems || []) : []);
    return pool.filter(function (x) {
      if (x.dir || !SUB_EXT.test(x.name)) return false;
      return x.name.replace(/\.[^.]+$/, '').toLowerCase() === base2;
    }).map(function (x) {
      return { name: x.name.replace(/\.[^.]+$/, ''), url: davFileUrl(drive, x, base) };
    });
  }

  function playDavFile(drive, item, base) {
    let url, key;
    const filePath = item.path.startsWith('/') ? item.path : base.replace(/\/$/, '') + '/' + item.name;
    url = davFileUrl(drive, item, base);
    key = 'drive|' + drive.id + '|' + filePath;
    DB.saveHist({ key, name: item.name, pic: '', from: drive.name, epIndex: 0, epName: '直连', position: 0, duration: 0, sourceId: 'drive', vodId: key });
    Player.open({
      key, title: item.name, name: item.name, pic: '', sourceId: 'drive', vodId: key, fromName: drive.name,
      groups: [{ name: drive.name, eps: [{ name: item.name, url }] }],
      groupIndex: 0, epIndex: 0,
      subtitles: siblingSubs(drive, item, base),
    });
  }

  /* ============ 收藏页 ============ */
  function pageFav() {
    view().innerHTML = `<div class="page-title">我的收藏</div>`;
    const favs = DB.getFavs();
    if (!favs.length) {
      view().appendChild(UI.empty('还没有收藏,去首页看看吧', '去首页', () => go('home')));
      return;
    }
    const box = UI.el('<div class="list-rows"></div>');
    favs.forEach(f => box.appendChild(UI.favRow(f)));
    const clear = UI.el(`<div style="margin-top:18px"><button class="btn" data-f tabindex="-1">清空收藏</button></div>`);
    clear.querySelector('button').onclick = e => {
      if (e.target.dataset.confirm) { DB.clearFavs(); pageFav(); }
      else { e.target.dataset.confirm = '1'; e.target.textContent = '再按一次确认清空'; }
    };
    view().appendChild(box);
    view().appendChild(clear);
  }

  /* ============ 历史页 ============ */
  function pageHist() {
    view().innerHTML = `<div class="page-title">观看历史</div>`;
    const hist = DB.getHistory();
    if (!hist.length) {
      view().appendChild(UI.empty('暂无观看记录', '去首页', () => go('home')));
      return;
    }
    const box = UI.el('<div class="list-rows"></div>');
    hist.forEach(h => box.appendChild(UI.histRow(h)));
    const clear = UI.el(`<div style="margin-top:18px"><button class="btn" data-f tabindex="-1">清空历史</button></div>`);
    clear.querySelector('button').onclick = e => {
      if (e.target.dataset.confirm) { DB.clearHistory(); pageHist(); }
      else { e.target.dataset.confirm = '1'; e.target.textContent = '再按一次确认清空'; }
    };
    view().appendChild(box);
    view().appendChild(clear);
  }

  /* ============ 设置页 ============ */
  function pageSet() {
    const cfg = DB.getConfig();
    const srcs = DB.getSources();
    const repos = DB.getRepos();
    const drives = DB.getDrives();
    const cur = DB.getCurrentSource();
    view().innerHTML = `
      <div class="page-title">设置</div>
      <div class="settings">
        <div class="section">
          <h3>数据源</h3>
          <div class="src-list" id="src-list"></div>
          <div class="form">
            <input id="src-name" data-f tabindex="-1" placeholder="名称(如:我的采集源)">
            <input id="src-api" data-f tabindex="-1" placeholder="接口地址,如 https://xxx.com/api.php/provide/vod/">
            <button class="btn primary" id="src-add" data-f tabindex="-1">添加源</button>
          </div>
          <div class="hint">支持苹果CMS V10 采集接口(参数 ac=detail / videolist 均可自动兼容)。</div>
        </div>
        <div class="section">
          <h3>仓库订阅(单仓 / 多仓)</h3>
          <div class="src-list" id="repo-list"></div>
          <div class="form">
            <input id="repo-name" data-f tabindex="-1" placeholder="备注名(可空)">
            <input id="repo-url" data-f tabindex="-1" placeholder="仓库地址:TVBox 配置 JSON(http:// 或本地 file 导入用下方粘贴)">
            <button class="btn primary" id="repo-add" data-f tabindex="-1">订阅</button>
          </div>
          <div class="form" style="margin-top:10px">
            <textarea id="repo-text" data-f tabindex="-1" placeholder="…或直接粘贴 TVBox 配置 JSON 文本(支持单仓 sites / 多仓 urls / storeHouse)"></textarea>
            <button class="btn" id="repo-parse" data-f tabindex="-1">解析粘贴内容</button>
          </div>
          <button class="btn" id="cfg-push-btn" data-f tabindex="-1" style="margin-top:8px">📱 手机扫码推送配置</button>
          <div class="hint">自动解析配置中的苹果CMS影视站(type 0/1)并加入数据源;爬虫类源(csp_)网页版暂不支持。解析会保留上次结果,删除仓库会一并移除其源。</div>
        </div>
        <div class="section">
          <h3>弹幕接口配置</h3>
          <div class="form">
            <input id="dm-tpl" data-f tabindex="-1" placeholder="自定义弹幕接口模板(含 {fileName} 占位,返回B站XML或dandanplay JSON;留空=用官方)">
            <input id="dm-appid" data-f tabindex="-1" placeholder="弹弹play AppId(官方接口需要,dev.dandanplay.com 申请)" style="flex:1 1 45%">
            <input id="dm-secret" data-f tabindex="-1" type="password" placeholder="弹弹play AppSecret" style="flex:1 1 45%">
            <button class="btn primary" id="dm-save" data-f tabindex="-1">保存弹幕配置</button>
          </div>
          <div class="hint">默认接口:弹弹play 官方(2025 起匿名访问已关闭,需在此填入自己申请的 AppId/AppSecret)。
          自定义接口:填一个含 <b>{fileName}</b> 占位的 URL,播放器点「在线弹幕」时会用当前文件名请求;返回 B站弹幕 XML 或 dandanplay comment JSON 均可自动识别。</div>
        </div>
        <div class="section">
          <h3>云盘 4K 播放(阿里云盘扫码 / 夸克网盘)</h3>
          <div id="cloud-acct-list" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px"></div>
          <div id="cloud-login"></div>
          <div class="hint">登录后在「网盘」页选择对应云盘即可浏览/播放,4K 与蓝光 Remux 原画直连(直链经本机中转,支持拖动)。</div>
        </div>
        <div class="section">
          <h3>网盘挂载(WebDAV / Alist)</h3>
          <div class="src-list" id="drive-list"></div>
          <div class="form">
            <select id="drv-type" data-f tabindex="-1" style="background:var(--panel);border:1px solid var(--line);color:var(--text);border-radius:10px;padding:12px;font-size:15px">
              <option value="alist">Alist(推荐:聚合阿里云盘/夸克/百度/115)</option>
              <option value="webdav">WebDAV(坚果云等)</option>
              <option value="smb">SMB / Windows共享(电脑端可用,填 \NAS\share)</option>
            </select>
            <input id="drv-name" data-f tabindex="-1" placeholder="名称">
          </div>
          <div class="form" style="margin-top:10px">
            <input id="drv-url" data-f tabindex="-1" placeholder="服务地址,如 http://192.168.1.5:5244 (Alist) 或 https://dav.example.com/dav/">
            <input id="drv-token" data-f tabindex="-1" placeholder="Alist Token(设置里复制);WebDAV 则填 账号:密码 或分别填下两项">
            <input id="drv-user" data-f tabindex="-1" placeholder="账号(WebDAV)" style="flex:0 0 150px">
            <input id="drv-pass" data-f tabindex="-1" type="password" placeholder="密码(WebDAV)" style="flex:0 0 150px">
            <button class="btn primary" id="drv-add" data-f tabindex="-1">挂载</button>
          </div>
          <div class="hint">SMB:电脑端填 \NAS\share 形式的共享路径(账号密码留空则用 Windows 当前登录身份;NFS 无法直连,请在 NAS 上同时开启 SMB/WebDAV)。
          蓝光原盘:进入 BDMV/STREAM 目录,按大小选择最大的 .m2ts 正片(应用自动包装为可播列表)。
          Alist 需自建(本机 docker 即可),在其中填入阿里云盘/夸克/百度网盘/115 的账号 Token 后,
          把 Alist 地址+Token 填到这里即可原画直连播放(302 重定向到网盘原始直链,不经转码中转)。
          内置演示:地址 http://localhost:9978 选 Alist 类型(Token 随意),或 http://localhost:9978/dav/ 选 WebDAV。</div>
        </div>
        <div class="section">
          <h3>播放 / 搜索</h3>
          <div class="form" style="align-items:center;flex-direction:column;gap:12px">
            <label style="display:flex;gap:8px;align-items:center;cursor:pointer">
              <input type="checkbox" id="cfg-autoswitch" data-f tabindex="-1" ${cfg.autoSwitch ? 'checked' : ''} style="width:18px;height:18px">
              自动换源(播放失败时自动尝试其他源的同名影片,最多3次)
            </label>
            <label style="display:flex;gap:8px;align-items:center;cursor:pointer">
              <input type="checkbox" id="cfg-proxy" data-f tabindex="-1" ${cfg.proxyMode ? 'checked' : ''} style="width:18px;height:18px">
              代理模式(通过本地服务器转发,解决跨域/防盗链)
            </label>
            <label style="display:flex;gap:8px;align-items:center">
              全网搜索并发数 <input type="number" id="cfg-pool" data-f tabindex="-1" min="1" max="12" value="${cfg.multiSearch}" style="width:70px">
            </label>
            <label style="display:flex;gap:8px;align-items:center;cursor:pointer">
              <input type="checkbox" id="cfg-skipintro" data-f tabindex="-1" ${cfg.skipIntroAuto ? 'checked' : ''} style="width:18px;height:18px">
              自动跳过片头(播放时默认)
            </label>
            <label style="display:flex;gap:8px;align-items:center">
              默认片头时长(秒) <input type="number" id="cfg-intro" data-f tabindex="-1" min="0" max="600" value="${cfg.defaultIntroSec}" style="width:80px">
            </label>
            <label style="display:flex;gap:8px;align-items:center;cursor:pointer">
              <input type="checkbox" id="cfg-adfilter" data-f tabindex="-1" ${cfg.adFilter !== false ? 'checked' : ''} style="width:18px;height:18px">
              M3U8 广告切片过滤(自动剔除贴片/插入广告)
            </label>
            <label style="display:flex;gap:8px;align-items:center;cursor:pointer">
              <input type="checkbox" id="cfg-sniffauto" data-f tabindex="-1" ${cfg.sniffAuto !== false ? 'checked' : ''} style="width:18px;height:18px">
              智能嗅探自动直连(捕获直链后自动播放)
            </label>
            <label style="display:flex;gap:8px;align-items:center;cursor:pointer">
              <input type="checkbox" id="cfg-scrape" data-f tabindex="-1" ${cfg.scrapeOn !== false ? 'checked' : ''} style="width:18px;height:18px">
              网盘海报墙刮削(豆瓣:评分/海报/简介/演员表)
            </label>
            <div class="hint" style="margin-top:4px">按影片精确的片头/片尾:播放页「⚙ 设置 → 片头片尾」里标记,会按影片记忆。</div>
          </div>
        </div>
        <div class="section">
          <h3>设备解码能力(如实检测)</h3>
          <div class="cap-grid" id="cap-grid">检测中…</div>
          <div class="hint">以上为浏览器/WebView 实际支持的解码能力(绿=流畅硬解,白=可解,灰=不支持)。
          杜比视界/HDR10+ 的 HDR 显示效果还需屏幕支持;音频源码透传(TrueHD/Atmos/DTS-HD)浏览器架构不支持,需 MPV 等原生播放器。</div>
        </div>
        <div class="section">
          <h3>关于</h3>
          <div style="display:flex;gap:14px;align-items:flex-start;margin-bottom:10px">
            <img src="icons/favicon.jpg" alt="AMUTV" style="width:76px;height:76px;border-radius:16px;flex:none" onerror="this.onerror=null;this.src=location.protocol==='file:'?'file:///android_asset/www_icons_favicon.jpg':'icons/favicon.jpg';this.onerror=function(){this.style.display='none'}">
            <div class="hint" style="margin-top:0">
              AMUTV · 类 TVBox 影视应用<br>
            本软件只提供聚合展示功能,所有资源均来自互联网公开内容,软件不参与任何资源的制作、上传、储存与下载等内容。本软件仅供个人学习交流参考,请于安装后 24 小时内自行删除。
            </div>
          </div>
          <img src="icons/about.jpg" alt="AMUTV" style="display:block;width:280px;max-width:100%;margin:8px auto 0;border-radius:12px" onerror="this.onerror=null;this.src=location.protocol==='file:'?'file:///android_asset/www_icons_about.jpg':'icons/about.jpg';this.onerror=function(){this.style.display='none'}">
        </div>
      </div>`;

    renderSrcList(srcs, cur);
    renderRepoList(repos);
    renderDriveList(drives);
    bindSettingsActions(cfg);
  }

  function renderSrcList(srcs, cur) {
    const list = view().querySelector('#src-list');
    list.innerHTML = '';
    srcs.forEach(s => {
      const origin = s.originId ? DB.getRepos().find(r => r.id === s.originId) : null;
      const item = UI.el(`<div class="src-item${cur && cur.id === s.id ? ' active-src' : ''}">
        <span class="src-status" data-role="status">${cur && cur.id === s.id ? '✅' : '▫️'}</span>
        <span class="s-name">${s.name}${origin ? ` <span style="color:var(--muted);font-size:11px">[仓:${origin.name}]</span>` : ''}<br><span class="s-api">${s.api || '(内置)'}</span><span class="test-result" data-role="test" style="font-size:11.5px"></span></span>
        <button class="mini-btn" data-op="test" data-f tabindex="-1">测试</button>
        <button class="mini-btn" data-op="use" data-f tabindex="-1">使用</button>
        ${s.builtIn ? '' : '<button class="mini-btn danger" data-op="del" data-f tabindex="-1">删除</button>'}
      </div>`);
      item.querySelector('[data-op="test"]').onclick = async () => {
        const st = item.querySelector('[data-role="test"]');
        const badge = item.querySelector('[data-role="status"]');
        if (!s.api) { st.textContent = '<br>内置演示源无需测试'; return; }
        st.textContent = '<br>测试中…';
        const r = await API.testSource(s);
        if (r.ok) {
          st.innerHTML = `<br><span style="color:#35c07f">✔ 连通 ${r.ms}ms · 返回${r.count}条</span>`;
          badge.textContent = '🟢';
        } else {
          st.innerHTML = `<br><span style="color:var(--danger)">✖ ${r.error}</span>`;
          badge.textContent = '🔴';
        }
      };
      item.querySelector('[data-op="use"]').onclick = () => {
        DB.setCurrentSourceId(s.id);
        homeCache.clear(); catCache.clear();
        renderTabs(); pageSet(); toast('已切换到:' + s.name);
      };
      const del = item.querySelector('[data-op="del"]');
      if (del) del.onclick = () => {
        const r = DB.removeSource(s.id);
        if (!r.ok) { toastErr(r.msg); return; }
        homeCache.clear(); catCache.clear();
        renderTabs(); pageSet(); toast('已删除');
      };
      list.appendChild(item);
    });
  }

  function renderRepoList(repos) {
    const list = view().querySelector('#repo-list');
    list.innerHTML = '';
    if (!repos.length) { list.innerHTML = '<div class="hint">暂未订阅仓库</div>'; return; }
    repos.forEach(r => {
      const cnt = DB.getSources().filter(s => s.originId === r.id).length;
      const warn = cnt === 0 ? `<br><span style="color:var(--danger);font-size:11.5px">⚠️ 未解析出CMS源(可能全是爬虫源,网页版不支持)</span>` : '';
      const item = UI.el(`<div class="src-item">
        <span>🗄️</span>
        <span class="s-name">${r.name}<br><span class="s-api">${r.url}</span>${warn}</span>
        <span style="color:var(--muted);font-size:12px">${cnt}源</span>
        <button class="mini-btn" data-op="refresh" data-f tabindex="-1">刷新</button>
        <button class="mini-btn danger" data-op="del" data-f tabindex="-1">退订</button>
      </div>`);
      item.querySelector('[data-op="refresh"]').onclick = () => importRepoSites(r.url, r.name, r.id, true);
      item.querySelector('[data-op="del"]').onclick = () => { DB.removeRepo(r.id); renderTabs(); pageSet(); toast('已退订并移除其源'); };
      list.appendChild(item);
    });
  }

  function renderDriveList(drives) {
    const list = view().querySelector('#drive-list');
    list.innerHTML = '';
    if (!drives.length) { list.innerHTML = '<div class="hint">暂未挂载网盘</div>'; return; }
    drives.forEach(d => {
      const item = UI.el(`<div class="src-item">
        <span>☁️</span>
        <span class="s-name">${d.name}<br><span class="s-api">${d.url}</span></span>
        <button class="mini-btn danger" data-op="del" data-f tabindex="-1">卸载</button>
      </div>`);
      item.querySelector('[data-op="del"]').onclick = () => { DB.removeDrive(d.id); pageSet(); toast('已卸载'); };
      list.appendChild(item);
    });
  }

  function applyRepoResult(result, repoName, repoUrl, repoId, silent) {
    if (result.type === 'multi') {
      // 多仓:列出子仓供选择,全部一键导入
      const mask = UI.el(`<div class="modal-mask">
        <div class="modal">
          <div class="modal-head">多仓配置(${result.repos.length}个子仓) <button class="x" data-f tabindex="-1">✕</button></div>
          <div class="modal-body">
            <div class="src-list" id="subrepo-list"></div>
            <div style="margin-top:12px"><button class="btn primary" id="subrepo-all" data-f tabindex="-1">全部订阅</button></div>
          </div>
        </div>
      </div>`);
      const lst = mask.querySelector('#subrepo-list');
      result.repos.forEach(rp => {
        const item = UI.el(`<div class="src-item" data-f tabindex="-1"><span>🗂️</span><span class="s-name">${rp.name || '(未命名)'}<br><span class="s-api">${rp.url}</span></span><button class="mini-btn" data-op="add">订阅</button></div>`);
        item.querySelector('[data-op="add"]').onclick = () => importRepoSites(rp.url, rp.name || '子仓', null, false, mask);
        lst.appendChild(item);
      });
      mask.querySelector('#subrepo-all').onclick = async () => {
        for (const rp of result.repos) await importRepoSites(rp.url, rp.name || '子仓', null, true, null);
        toast('多仓全部订阅完成');
        mask.remove(); KeyNav.setModal(false);
      };
      mask.querySelector('.x').onclick = () => { mask.remove(); KeyNav.setModal(false); };
      document.getElementById('overlay-root').appendChild(mask);
      KeyNav.setModal(true);
      KeyNav.focusFirst(mask);
      return;
    }
    if (result.type !== 'sites') {
      if (!silent) toastErr('无法解析:不是有效的 TVBox 配置(未找到 sites/urls/storeHouse)');
      return;
    }
    let rid = repoId;
    if (repoUrl && !rid) {
      const r = DB.addRepo(repoName || '仓库', repoUrl);
      rid = r.ok ? r.id : ((DB.getRepos().find(x => x.url === repoUrl) || {}).id || null);
    }
    let added = 0;
    result.sites.forEach(s => {
      const r = DB.addSource(s.name, s.api, { originId: rid, originName: repoName });
      if (r.ok) added++;
    });
    if (!silent) {
      const skip = result.skipped || 0;
      let msg = `导入完成:新增 ${added} 个源`;
      if (skip) {
        const names = (result.skippedNames || []).slice(0, 3).join('、');
        msg += `;跳过 ${skip} 个爬虫源(需安卓TVBox运行jar,网页版不支持)${names ? ':' + names : ''}`;
      }
      if (!added && skip) toastErr(msg + ' —— 建议订阅含CMS采集站的仓库');
      else toast(msg);
    }
    renderTabs();
    if (document.querySelector('.settings')) pageSet();
  }

  async function importRepoSites(url, name, repoId, silent, keepMask) {
    if (!url) { if (!silent) toastErr('请填写仓库地址'); return; }
    if (!silent) toast('正在拉取仓库…');
    try {
      const result = await API.fetchRepo(url);
      if (keepMask) { keepMask.remove(); KeyNav.setModal(false); }
      applyRepoResult(result, name || '仓库', url, repoId, silent);
    } catch (e) {
      if (!silent) toastErr('仓库拉取失败:' + (e.message || e));
    }
  }

  function bindSettingsActions(cfg) {
    view().querySelector('#src-add').onclick = () => {
      const name = view().querySelector('#src-name').value.trim();
      const api = view().querySelector('#src-api').value.trim();
      if (!api) { toastErr('请填写接口地址'); return; }
      const r = DB.addSource(name, api);
      if (!r.ok) { toastErr(r.msg); return; }
      toast('已添加'); pageSet();
    };

    view().querySelector('#repo-add').onclick = () => {
      const name = view().querySelector('#repo-name').value.trim();
      const url = view().querySelector('#repo-url').value.trim();
      if (!url) { toastErr('请填写仓库地址'); return; }
      importRepoSites(url, name, null, false);
    };
    view().querySelector('#repo-parse').onclick = () => {
      const text = view().querySelector('#repo-text').value.trim();
      if (!text) { toastErr('请粘贴配置 JSON'); return; }
      applyRepoResult(API.parseRepoConfig(text, location.origin), '粘贴导入', null, null, false);
    };

    /* 手机扫码推送配置:弹二维码 → 轮询 /cfg/get → 自动导入 */
    view().querySelector('#cfg-push-btn').onclick = () => {
      const openedAt = Date.now();
      const mask = UI.el(`<div class="modal-mask">
        <div class="modal">
          <div class="modal-head">手机扫码推送配置 <button class="x" data-f tabindex="-1">✕</button></div>
          <div class="modal-body">
            <div style="display:flex;gap:18px;align-items:center;flex-wrap:wrap">
              <img id="push-qr" style="width:170px;height:170px;border-radius:10px;background:#fff;padding:6px">
              <div style="flex:1;min-width:200px">
                <div class="hint" style="margin-bottom:8px">手机微信/浏览器扫码(同一 Wi-Fi),在打开的页面粘贴配置接口链接并推送:</div>
                <div id="push-url" style="font-size:14px;color:var(--acc);word-break:break-all;user-select:all"></div>
                <div class="hint" id="push-st" style="margin-top:10px">等待手机推送…</div>
              </div>
            </div>
          </div>
        </div>
      </div>`);
      mask.querySelector('.x').onclick = () => { clearInterval(poll); mask.remove(); KeyNav.setModal(false); };
      mask.addEventListener('click', e => { if (e.target === mask) { clearInterval(poll); mask.remove(); KeyNav.setModal(false); } });
      document.getElementById('overlay-root').appendChild(mask);
      KeyNav.setModal(true);
      fetch((location.protocol === 'file:' ? 'http://127.0.0.1:9978' : '') + '/rc/info').then(r => r.json()).then(info => {
        const url = (info.url || '').replace('/remote', '/push');
        mask.querySelector('#push-url').textContent = url;
        mask.querySelector('#push-qr').src = 'https://api.qrserver.com/v1/create-qr-code/?size=170x170&data=' + encodeURIComponent(url);
      });
      const poll = setInterval(async () => {
        try {
          const r = await fetch((location.protocol === 'file:' ? 'http://127.0.0.1:9978' : '') + '/cfg/get?ts=' + openedAt).then(x => x.json());
          if (r.url) {
            clearInterval(poll);
            mask.querySelector('#push-st').textContent = '收到配置,正在导入…';
            const before = DB.getSources().map(s => s.id);
            await importRepoSites(r.url, '手机推送', null, false);
            const added = DB.getSources().filter(s => !before.includes(s.id));
            if (added.length) {
              DB.setCurrentSourceId(added[added.length - 1].id);   // 推送即用:切到新导入的源
              homeCache.clear(); catCache.clear();
              renderTabs();
              toast('已推送并切换到:' + added[added.length - 1].name);
            }
            mask.remove(); KeyNav.setModal(false);
          }
        } catch (e) {}
      }, 2000);
    };

    view().querySelector('#drv-add').onclick = () => {
      const type = view().querySelector('#drv-type').value;
      const name = view().querySelector('#drv-name').value.trim();
      const url = view().querySelector('#drv-url').value.trim().replace(/\/+$/, '');
      const token = view().querySelector('#drv-token').value.trim();
      const user = view().querySelector('#drv-user').value.trim();
      const pass = view().querySelector('#drv-pass').value;
      if (!url) { toastErr('请填写服务地址'); return; }
      const r = DB.addDrive(name, url, type === 'alist' ? (token ? 'token:' + token : '') : user, type === 'alist' ? '' : pass, type);
      if (!r.ok) { toastErr(r.msg); return; }
      toast('挂载成功,去「网盘」页浏览'); pageSet();
    };

    view().querySelector('#cfg-proxy').onchange = e => { DB.setConfig({ proxyMode: e.target.checked }); toast(e.target.checked ? '已开启代理模式' : '已关闭代理模式'); };
    view().querySelector('#cfg-autoswitch').onchange = e => { DB.setConfig({ autoSwitch: e.target.checked }); toast(e.target.checked ? '已开启自动换源' : '已关闭自动换源'); };
    view().querySelector('#cfg-pool').onchange = e => { DB.setConfig({ multiSearch: Math.min(12, Math.max(1, Number(e.target.value) || 6)) }); toast('并发数已更新'); };
    view().querySelector('#cfg-skipintro').onchange = e => { DB.setConfig({ skipIntroAuto: e.target.checked }); toast(e.target.checked ? '已开启自动跳过片头' : '已关闭自动跳过片头'); };
    view().querySelector('#cfg-intro').onchange = e => { DB.setConfig({ defaultIntroSec: Math.min(600, Math.max(0, Number(e.target.value) || 0)) }); toast('默认片头时长已更新'); };
    view().querySelector('#cfg-adfilter').onchange = e => { DB.setConfig({ adFilter: e.target.checked }); toast(e.target.checked ? '已开启广告切片过滤' : '已关闭广告切片过滤'); };
    view().querySelector('#cfg-sniffauto').onchange = e => { DB.setConfig({ sniffAuto: e.target.checked }); toast(e.target.checked ? '已开启嗅探自动直连' : '已关闭嗅探自动直连'); };
    view().querySelector('#cfg-scrape').onchange = e => { DB.setConfig({ scrapeOn: e.target.checked }); toast(e.target.checked ? '已开启刮削' : '已关闭刮削'); };

    /* 弹幕接口配置 */
    const dmTpl = view().querySelector('#dm-tpl');
    if (dmTpl) {
      const c = DB.getConfig();
      dmTpl.value = c.dmTpl || '';
      view().querySelector('#dm-appid').value = c.dmAppId || '';
      view().querySelector('#dm-secret').value = c.dmAppSecret || '';
      view().querySelector('#dm-save').onclick = () => {
        DB.setConfig({
          dmTpl: dmTpl.value.trim(),
          dmAppId: view().querySelector('#dm-appid').value.trim(),
          dmAppSecret: view().querySelector('#dm-secret').value.trim(),
        });
        toast('弹幕接口配置已保存');
      };
    }

    /* 云盘账号:已登录列表 + 登录 UI(阿里扫码 / 夸克 Cookie) */
    const renderCloudAccts = () => {
      const box = view().querySelector('#cloud-acct-list');
      if (!box) return;
      box.innerHTML = '';
      Cloud.list().forEach((c, i) => {
        const b = UI.el(`<button class="cat active" data-f tabindex="-1">${c.name}</button>`);
        b.onclick = () => {
          const arr = Cloud.list(); arr.splice(i, 1); Cloud.save(arr);
          toast('已退出 ' + c.name); renderCloudAccts();
        };
        b.title = '点击退出登录';
        box.appendChild(b);
      });
    };
    if (window.Cloud) {
      renderCloudAccts();
      Cloud.loginUI(view().querySelector('#cloud-login'), () => { renderCloudAccts(); });
    }

    // 设备解码能力检测(MediaCapabilities API,如实报告)
    runCapTest().then(function (html) { const g = view().querySelector('#cap-grid'); if (g) g.innerHTML = html; },
      function (e) { console.warn('capTest', e); });
  }

  /* ============ 源切换弹窗 ============ */
  function openSourceModal() {
    const srcs = DB.getSources();
    const cur = DB.getCurrentSource();
    const mask = UI.el(`<div class="modal-mask">
      <div class="modal">
        <div class="modal-head">切换数据源 <button class="x" data-f tabindex="-1">✕</button></div>
        <div class="modal-body"><div class="src-list"></div>
          <div class="hint">前往「设置」页可添加更多采集接口。</div>
        </div>
      </div>
    </div>`);
    const body = mask.querySelector('.src-list');
    srcs.forEach(s => {
      const item = UI.el(`<div class="src-item${cur && cur.id === s.id ? ' active-src' : ''}" data-f tabindex="-1">
        <span>${cur && cur.id === s.id ? '✅' : '▫️'}</span>
        <span class="s-name">${s.name}<br><span class="s-api">${s.api || '(内置)'}</span></span>
      </div>`);
      item.onclick = () => {
        DB.setCurrentSourceId(s.id);
        homeCache.clear(); catCache.clear();
        renderTabs();
        mask.remove(); KeyNav.setModal(false);
        go('home');
        toast('已切换到:' + s.name);
      };
      body.appendChild(item);
    });
    mask.querySelector('.x').onclick = () => { mask.remove(); KeyNav.setModal(false); };
    mask.addEventListener('click', e => { if (e.target === mask) { mask.remove(); KeyNav.setModal(false); } });
    document.getElementById('overlay-root').appendChild(mask);
    KeyNav.setModal(true);
    KeyNav.focusFirst(mask);
  }

  /* ============ 详情页 ============ */
  async function goDetail(item) {
    const src = DB.getCurrentSource();
    view().innerHTML = `<div class="detail"><div class="backdrop" style="background-image:url('${item.pic}')"></div>${UI.spinner()}</div>`;
    KeyNav.focusFirst();

    let d;
    try {
      d = await API.detailOf(src, item.id);
    } catch (e) {
      view().innerHTML = '';
      view().appendChild(UI.empty('详情加载失败:' + (e.message || e), '返回', () => go('home')));
      return;
    }
    if (!d) {
      view().innerHTML = '';
      view().appendChild(UI.empty('未找到该影片详情', '返回', () => go('home')));
      return;
    }

    const groups = API.parsePlay(d.raw);
    const key = src.id + '|' + d.id;
    const hist = DB.getHist(key);
    const favBtn = DB.isFav(key) ? '★ 已收藏' : '♡ 收藏';

    const meta = [];
    if (d.year || d.area || d.cls) meta.push(`<b>${[d.year, d.area, d.cls].filter(Boolean).join(' · ')}</b>`);
    if (d.director) meta.push('导演:' + d.director);
    if (d.actor) meta.push('主演:' + d.actor);
    if (d.remarks) meta.push('备注:' + d.remarks);

    view().innerHTML = '';
    const page = UI.el(`<div class="detail">
      <div class="backdrop" style="background-image:url('${d.pic}')"></div>
      <div class="detail-head">
        <img class="detail-poster" src="${d.pic || window.IMG_FB}" ${IMG_ERR}>
        <div class="detail-info">
          <h1>${d.name}</h1>
          <div class="meta-lines">${meta.join('<br>')}</div>
          <div class="detail-actions">
            <button class="btn primary" id="btn-play" data-f tabindex="-1">立即播放${hist ? '(续播 ' + (hist.epName || '第' + (hist.epIndex + 1) + '集') + ')' : ''}</button>
            <button class="btn" id="btn-fav" data-f tabindex="-1">${favBtn}</button>
            ${hist ? '<button class="btn" id="btn-restart" data-f tabindex="-1">从头看</button>' : ''}
          </div>
          <div class="intro">${d.content || '暂无简介'}</div>
        </div>
      </div>
      <div id="ep-area"></div>
    </div>`);
    view().appendChild(page);

    const btnPlay = page.querySelector('#btn-play');
    btnPlay.onclick = () => playVod(src, d, groups, hist ? hist.epIndex : 0, hist ? hist.position : 0);
    const btnFav = page.querySelector('#btn-fav');
    btnFav.onclick = () => {
      const added = DB.toggleFav({ key, name: d.name, pic: d.pic, sourceId: src.id, vodId: d.id });
      btnFav.textContent = added ? '★ 已收藏' : '♡ 收藏';
      toast(added ? '已加入收藏' : '已取消收藏');
    };
    const btnRestart = page.querySelector('#btn-restart');
    if (btnRestart) btnRestart.onclick = () => playVod(src, d, groups, hist.epIndex, 0);

    renderEpisodeGroups(page, groups, { key, name: d.name, pic: d.pic, sourceId: src.id, vodId: d.id, fromName: d.from ? d.from.name : '', title: d.name }, hist);
    KeyNav.focusFirst(page.querySelector('.detail-actions'));
  }

  function renderEpisodeGroups(page, groups, rec, hist) {
    const area = page.querySelector('#ep-area');
    if (!groups.length) {
      area.innerHTML = '<div class="empty">该片暂无可播放的剧集信息</div>';
      return;
    }
    area.innerHTML = '';
    const sec = UI.el('<div class="ep-section"></div>');
    groups.forEach((g, gi) => {
      const gh = UI.el(`<div class="src-head">${g.name} · ${g.eps.length}集</div>`);
      sec.appendChild(gh);
      const grid = UI.el('<div class="ep-grid"></div>');
      g.eps.forEach((ep, ei) => {
        const b = UI.el(`<button class="ep" data-f tabindex="-1">${ep.name}</button>`);
        if (hist && hist.epIndex === ei && gi === (hist.groupIndex || 0)) b.classList.add('current');
        b.onclick = () => playVod(DB.getCurrentSource(), { id: rec.vodId, name: rec.name, pic: rec.pic, from: { name: rec.fromName } }, groups, gi, 0, ei);
        grid.appendChild(b);
      });
      sec.appendChild(grid);
    });
    area.appendChild(sec);
  }

  /* ============ 播放入口 ============ */
  function playVod(src, d, groups, gi = 0, fromPosition = 0, forceEi = null, tried = []) {
    if (!groups.length) { toastErr('没有可播放的地址'); return; }
    const hist = DB.getHist(src.id + '|' + d.id);
    const ei = forceEi !== null ? forceEi : (hist ? hist.epIndex : 0);
    const g = groups[Math.min(gi, groups.length - 1)];
    const ep = g.eps[Math.min(ei, g.eps.length - 1)];
    DB.saveHist({
      key: src.id + '|' + d.id, name: d.name, pic: d.pic || '', from: d.from ? d.from.name : '',
      epIndex: ei, epName: ep.name, position: fromPosition || (hist && forceEi === null ? hist.position : 0), duration: 0,
      sourceId: src.id, vodId: d.id,
    });
    Player.open({
      key: src.id + '|' + d.id,
      title: d.name,
      name: d.name,
      pic: d.pic || '',
      sourceId: src.id,
      vodId: d.id,
      fromName: d.from ? d.from.name : '',
      groups,
      groupIndex: Math.min(gi, groups.length - 1),
      epIndex: Math.min(ei, g.eps.length - 1),
      tried: tried.slice(),
      onFindSources: () => API.findEverywhere(d.name, src.id),
      onPlayFromSource: (entry, epIdx, prevTried) => switchToSource(entry, d.name, epIdx, prevTried || tried),
      onClose: () => {},
    });
    // 指定续播起点
    if (fromPosition > 0) {
      setTimeout(() => { const v = document.querySelector('#player video'); if (v) { try { v.currentTime = fromPosition; } catch {} } }, 800);
    }
  }

  /* 换源:去别的源找同名片,按相同集数续播 */
  async function switchToSource(entry, title, epIdx, prevTried) {
    toast('切换到 ' + entry.srcName + '…');
    const src = DB.getSources().find(s => s.id === entry.srcId);
    if (!src) { toastErr('目标源不存在'); return; }
    try {
      const d = await API.detailOf(src, entry.vodId);
      if (!d) throw new Error('详情不存在');
      const groups = API.parsePlay(d.raw);
      if (!groups.length) throw new Error('该源无播放地址');
      playVod(src, d, groups, 0, 0, epIdx || 0, (prevTried || []).concat());
    } catch (e) {
      toastErr('换源失败:' + (e.message || e));
    }
  }

  /* 历史记录续播 */
  async function resumeHist(h) {
    const src = DB.getSources().find(s => s.id === h.sourceId) || DB.getCurrentSource();
    view().innerHTML = UI.spinner();
    try {
      const d = await API.detailOf(src, h.vodId);
      if (!d) throw new Error('详情不存在,源可能已失效');
      const groups = API.parsePlay(d.raw);
      if (!groups.length) throw new Error('该片暂无播放地址');
      playVod(src, d, groups, 0, h.position || 0);
    } catch (e) {
      toastErr(e.message || e);
      pageHome();
    }
  }

  /* 收藏/历史记录打开详情 */
  async function openFromRecord(rec) {
    const src = DB.getSources().find(s => s.id === rec.sourceId) || DB.getCurrentSource();
    goDetail({ id: rec.vodId, name: rec.name, pic: rec.pic, from: src });
  }

  /* ============ 全局按键:返回 ============ */
  document.addEventListener('keydown', e => {
    if (Player.isOpen()) return;
    if (e.key === 'Backspace' || e.key === 'Escape') {
      // 输入框里不拦截(输入框自身的退格)
      const ae = document.activeElement;
      if (e.key === 'Backspace' && ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return;
      if (document.querySelector('.modal-mask')) return; // 弹窗自己处理
      if (tab !== 'home') { e.preventDefault(); go('home'); }
    }
  });

  /* ============ 启动 ============ */
  function boot() {
    if (!DB.getCurrentSource()) DB.setCurrentSourceId(DB.getSources()[0].id);
    renderTabs();
    go('home');
    // 演示源提示
    setTimeout(() => toast('提示:方向键导航,Enter 确认;在「设置」可添加自己的采集源'), 800);
  }

  return { boot, go, goDetail, resumeHist, openFromRecord, playVod, renderTabs };
})();

App.boot();
