# -*- coding: utf-8 -*-
import io

p = r'C:\Users\91596\.zcode\workspace\17e4ecba-c7c4-40ce-b117-87a9e9f578b3\tvbox-web\js\app.js'
s = io.open(p, encoding='utf-8').read()

# 1) 网盘页:模式切换 chips(列表/海报墙)
old = """    view().innerHTML = `
      <div class="page-title">网盘 <span class="sub">WebDAV / SMB(Alist 可聚合阿里云盘/夸克/百度/115)· 本地U盘即插即播</span></div>
      <div style="display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap">
        <button class="btn" id="local-pick" data-f tabindex="-1">📁 本地 / U 盘播放</button>
        <input type="file" id="local-file" accept="video/*,.m2ts,.ts,.mkv,.m3u8" style="display:none">
      </div>
      <div id="drive-area"></div>`;"""
new = """    view().innerHTML = `
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
    view().querySelector('#wall-mode').addEventListener('click', e => {
      const b = e.target.closest('[data-mode]');
      if (!b) return;
      driveState.wall = b.dataset.mode === 'wall';
      pageDrive();
    });"""
assert old in s, 'drive header missing'
s = s.replace(old, new)

# 2) browseDav:海报墙模式渲染(视频文件刮削 → 海报卡片)
old2 = """      const items = list.filter(x => x.name);
      items.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, 'zh'));
      const rows = UI.el('<div class="list-rows"></div>');"""
new2 = """      const items = list.filter(x => x.name);
      items.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, 'zh'));
      if (driveState.wall) { renderWall(drive, sub, items, box); return; }
      const rows = UI.el('<div class="list-rows"></div>');"""
assert old2 in s, 'browse render missing'
s = s.replace(old2, new2)

# 3) 海报墙渲染 + 刮削详情视图函数(插在 playDavFile 前)
old3 = "  function playDavFile(drive, item, base) {"
new3 = """  /* 海报墙:视频文件刮削(豆瓣)→ 海报卡片 */
  const wallCache = { busy: 0 };
  function renderWall(drive, sub, items, box) {
    const videos = items.filter(x => !x.dir && VIDEO_EXT.test(x.name));
    const dirs = items.filter(x => x.dir);
    const grid = UI.el('<div class="grid"></div>');
    dirs.forEach(d => {
      const c = UI.el('<div class="card" data-f tabindex="-1"><div class="poster"><div class="poster-empty" style="display:flex;align-items:center;justify-content:center;height:100%;font-size:34px">📁</div></div><div class="title">' + d.name + '</div></div>');
      c.onclick = () => { driveState.path = d.path.startsWith('/') ? d.path : sub.replace(/\\/$/, '') + '/' + d.name + '/'; pageDrive(); };
      grid.appendChild(c);
    });
    box.appendChild(grid);
    if (!videos.length) { box.appendChild(UI.empty('此目录没有视频文件')); return; }
    // 占位卡片(海报加载前)
    const nodes = [];
    videos.forEach(f => {
      const c = UI.el('<div class="card" data-f tabindex="-1"><div class="poster"><div class="poster-empty shimmer" style="height:100%"></div></div><div class="title">' + f.name + '</div></div>');
      c.onclick = () => { playDavFile(drive, f, sub); };
      grid.appendChild(c);
      nodes.push({ node: c, file: f });
    });
    if (!DB.getConfig().scrapeOn) return;
    // 并发刮削(最多3路),完成一张渲染一张
    let idx = 0;
    const worker = async function () {
      while (idx < nodes.length) {
        const cur = nodes[idx++];
        try {
          const meta = await Scraper.scrapeFile(cur.file.name);
          if (!meta || !cur.node.isConnected) continue;
          const poster = meta.poster || window.IMG_FB;
          const img = cur.node.querySelector('.poster').querySelector('.poster-empty, img');
          cur.node.querySelector('.poster').innerHTML = '<img src="' + poster + '" ' + IMG_ERR + '>';
          const badge = document.createElement('div');
          badge.className = 'remark';
          badge.textContent = meta.rating ? '★ ' + meta.rating : (meta.year || '未匹配');
          cur.node.querySelector('.poster').appendChild(badge);
          cur.node.querySelector('.title').textContent = meta.title + (meta.year ? ' (' + meta.year + ')' : '');
          cur.node.title = meta.fileName;
          cur.node.onclick = () => openLocalDetail(meta, drive, cur.file, sub);
        } catch (e) { /* 单个失败忽略 */ }
      }
    };
    worker(); worker(); worker();
  }

  /* 刮削详情视图:评分/简介/演员表 + 播放 */
  function openLocalDetail(meta, drive, file, sub) {
    const url = davFileUrl(drive, file, sub);
    const stars = meta.rating ? '★★★★★☆☆☆☆☆'.slice(5 - Math.round(meta.rating), 10 - Math.round(meta.rating)) : '';
    const ratingTxt = meta.rating ? ('<b style="color:#fff;font-size:20px">' + meta.rating.toFixed(1) + '</b> <span style="color:var(--muted)">' + (meta.ratingCount ? Math.round(meta.ratingCount / 10000 * 10) / 10 + '万人评' : '') + '</span>') : '<span style="color:var(--muted)">暂无评分</span>';
    view().innerHTML = '';
    const page = UI.el(`<div class="detail">
      <div class="backdrop" style="background-image:url('${meta.poster || ''}')"></div>
      <div class="detail-head">
        <img class="detail-poster" src="${meta.poster || window.IMG_FB}" ${IMG_ERR}>
        <div class="detail-info">
          <h1>${meta.title}</h1>
          <div class="meta-lines">${ratingTxt}<br>
            ${meta.cardSubtitle || [meta.year, (meta.countries || []).join(' '), (meta.genres || []).join(' ')].filter(Boolean).join(' · ')}
            ${meta.directors && meta.directors.length ? '<br>导演:' + meta.directors.join(' / ') : ''}
            ${meta.cast && meta.cast.length ? '<br>主演:' + meta.cast.join(' / ') : ''}
          </div>
          <div class="detail-actions">
            <button class="btn primary" id="btn-play" data-f tabindex="-1">播放本文件</button>
            <button class="btn" data-f tabindex="-1" onclick="history.length">返回</button>
          </div>
          <div class="intro">${meta.intro || '暂无简介'}${meta.doubanUrl ? '<br><a href="' + meta.doubanUrl + '" target="_blank" style="color:var(--muted)">豆瓣页面</a>' : ''}</div>
        </div>
      </div>
    </div>`);
    view().appendChild(page);
    page.querySelector('#btn-play').onclick = () => {
      Player.open({
        key: 'local|' + file.name + '|' + (file.size || 0), title: meta.title + ' · ' + file.name, name: meta.title,
        pic: meta.poster || '', sourceId: 'local', vodId: file.name, fromName: drive.name,
        groups: [{ name: '正片', eps: [{ name: file.name, url: url }] }],
        groupIndex: 0, epIndex: 0,
      });
    };
    KeyNav.focusFirst(page);
  }

  function playDavFile(drive, item, base) {"""
assert old3 in s, 'playDavFile anchor missing'
s = s.replace(old3, new3, 1)

# 4) davFileUrl:从 playDavFile 提取 URL 逻辑供详情使用
old4 = """  function playDavFile(drive, item, base) {
    let url, key;
    const filePath = item.path.startsWith('/') ? item.path : base.replace(/\\/$/, '') + '/' + item.name;"""
new4 = """  function davFileUrl(drive, item, base) {
    let url;
    const filePath = item.path.startsWith('/') ? item.path : base.replace(/\\/$/, '') + '/' + item.name;
    if (API.IN_APP) {
      if (drive.type === 'alist') url = drive.url + '/d' + filePath;
      else url = drive.url + filePath;
      return url;
    }
    if (drive.type === 'smb') {
      const raw = '/nasfile?p=' + encodeURIComponent(filePath);
      return /\\.(m2ts|ts)$/i.test(filePath) ? '/tslist?p=' + encodeURIComponent(filePath) + '&seg=10' : raw;
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

  function playDavFile(drive, item, base) {
    let url, key;
    const filePath = item.path.startsWith('/') ? item.path : base.replace(/\\/$/, '') + '/' + item.name;
    url = davFileUrl(drive, item, base);"""
assert old4 in s, 'playDavFile head missing'
s = s.replace(old4, new4)

io.open(p, 'w', encoding='utf-8').write(s)
print('wall + detail integrated')
