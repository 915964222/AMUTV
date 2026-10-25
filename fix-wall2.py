# -*- coding: utf-8 -*-
import io

p = r'C:\Users\91596\.zcode\workspace\17e4ecba-c7c4-40ce-b117-87a9e9f578b3\tvbox-web\js\app.js'
s = io.open(p, encoding='utf-8').read()

if 'function renderWall' in s:
    print('already patched')
else:
    old3 = "  function playDavFile(drive, item, base) {"
    new3 = """  /* 海报墙:视频文件刮削(豆瓣)→ 海报卡片 */
  function renderWall(drive, sub, items, box) {
    const videos = items.filter(function (x) { return !x.dir && VIDEO_EXT.test(x.name); });
    const dirs = items.filter(function (x) { return x.dir; });
    const grid = UI.el('<div class="grid"></div>');
    dirs.forEach(function (d) {
      const c = UI.el('<div class="card" data-f tabindex="-1"><div class="poster"><div class="poster-empty" style="display:flex;align-items:center;justify-content:center;height:100%;font-size:34px">📁</div></div><div class="title">' + d.name + '</div></div>');
      c.onclick = function () { driveState.path = d.path.indexOf('/') === 0 ? d.path : sub.replace(/\\/$/, '') + '/' + d.name + '/'; pageDrive(); };
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
      '<div class="backdrop" style="background-image:url(\\'' + (meta.poster || '') + '\\')"></div>' +
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
    const filePath = item.path.indexOf('/') === 0 ? item.path : base.replace(/\\/$/, '') + '/' + item.name;
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

  function playDavFile(drive, item, base) {"""
    s = s.replace(old3, new3, 1)

    # playDavFile 内部 URL 计算改用 davFileUrl
    old4 = """    let url, key;
    const filePath = item.path.startsWith('/') ? item.path : base.replace(/\\/$/, '') + '/' + item.name;
    if (API.IN_APP) {
      // App:JS 直连(Alist 302 直链 / WebDAV 原文件),WebView 通用访问无跨域
      if (drive.type === 'alist') url = drive.url + '/d' + filePath;
      else url = drive.url + filePath;
    } else if (drive.type === 'smb') {
      // SMB:服务器 fs 直读(支持 Range,4K 可拖动);TS/M2TS 由 hls.js 解包播放
      const raw = '/nasfile?p=' + encodeURIComponent(filePath);
      url = /\\.(m2ts|ts)$/i.test(filePath) ? '/tslist?p=' + encodeURIComponent(filePath) + '&seg=10' : raw;
    } else if (drive.type === 'alist') {
      // Alist 直链:/d<路径>,302 重定向到网盘原始直链(代理自动跟随)
      const auth = DB.driveAuth(drive) ? '&h=' + encodeURIComponent('Authorization: ' + DB.driveAuth(drive)) : '';
      url = DB.getConfig().proxyMode
        ? '/proxy?u=' + encodeURIComponent(drive.url + '/d' + filePath) + auth
        : drive.url + '/d' + filePath;
    } else {
      const auth = DB.driveAuth(drive) ? ('&a=' + encodeURIComponent(btoa(unescape(encodeURIComponent(DB.driveAuth(drive)))))) : '';
      url = DB.getConfig().proxyMode
        ? '/proxy?u=' + encodeURIComponent(drive.url + filePath) + auth
        : drive.url + filePath;
    }"""
    new4 = """    let url, key;
    const filePath = item.path.startsWith('/') ? item.path : base.replace(/\\/$/, '') + '/' + item.name;
    url = davFileUrl(drive, item, base);"""
    assert old4 in s, 'playDavFile head missing'
    s = s.replace(old4, new4)

    io.open(p, 'w', encoding='utf-8').write(s)
    print('wall functions integrated')
