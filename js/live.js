/* ============ IPTV 直播:m3u/txt 解析 + EPG 节目单(51zmt) ============ */
(function () {
  const CK = 'tvw_live_playlists';
  const CUR = 'tvw_live_current';
  const EPG_CK = 'tvw_live_epg';

  function read(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function write(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  /* ---------- 解析 m3u(#EXTINF 分组) 与 txt(分组,#genre# 格式) ---------- */
  function parsePlaylist(text) {
    const groups = [];
    let cur = null;
    const text2 = String(text || '');
    if (/#EXTM3U|#EXTINF/i.test(text2)) {
      // m3u
      const re = /#EXTINF:-?[\d.]*\s*,([^\n]*?)\n([^\n#][^\n]*)/g;
      // 先抓 group-title
      const lines = text2.split(/\r?\n/);
      let pending = null;
      lines.forEach(function (line) {
        if (/^#EXTINF/i.test(line)) {
          const gm = line.match(/group-title="([^"]*)"/i);
          const nm = line.match(/,(.*)$/);
          pending = { name: (nm ? nm[1] : '').trim(), group: gm ? gm[1].trim() : '' };
        } else if (pending && line.trim() && !line.startsWith('#')) {
          const g = pending.group || '未分组';
          if (!cur || cur.name !== g) { cur = groups.find(function (x) { return x.name === g; }) || null; if (!cur) { cur = { name: g, channels: [] }; groups.push(cur); } }
          let u1 = line.trim(); const d1 = u1.indexOf('$'); if (d1 > 0) u1 = u1.slice(0, d1).trim();
          cur.channels.push({ name: pending.name || u1.slice(0, 30), url: u1 });
          pending = null;
        }
      });
    } else {
      // txt: 组名,#genre# / 频道名,地址
      const lines = text2.split(/\r?\n/);
      lines.forEach(function (line) {
        line = line.trim();
        if (!line || line.startsWith('#')) return;
        if (/#genre#/i.test(line)) {
          const gname = line.split(',')[0].trim();
          cur = groups.find(function (x) { return x.name === gname; });
          if (!cur) { cur = { name: gname, channels: [] }; groups.push(cur); }
          return;
        }
        const ci = line.indexOf(',');
        if (ci < 1) return;
        const nm = line.slice(0, ci).trim();
        let url = line.slice(ci + 1).trim();
        const di = url.indexOf('$');           // 剥 $画质/线路 装饰后缀
        if (di > 0) url = url.slice(0, di).trim();
        if (!/^https?:/i.test(url)) return;
        if (!cur) { cur = { name: '未分组', channels: [] }; groups.push(cur); }
        const exist = cur.channels.find(function (c) { return c.name === nm; });
        if (exist) { exist.urls.push(url); return; }   // 同名频道=多线路,合并
        cur.channels.push({ name: nm, url: url, urls: [url] });
      });
    }
    groups.forEach(function (g) {
      /* 同名频道合并多线路(m3u/txt 通用) */
      const map = {}; const merged = [];
      g.channels.forEach(function (c) {
        if (map[c.name]) { map[c.name].urls.push(c.url); return; }
        c.urls = [c.url]; map[c.name] = c; merged.push(c);
      });
      g.channels = merged;
      g.channels.forEach(function (c) { c.url = c.urls[0]; });
    });
    /* 过滤占位台:名称为更新时间戳的"频道" */
    groups.forEach(function (g) {
      g.channels = g.channels.filter(function (c) {
        return !/^20\d{2}[-/年.]/.test(c.name) && !/列表更新时间/.test(c.name);
      });
    });
    return groups.filter(function (g) { return g.channels.length; });
  }

  /* ---------- 播放列表存取 ---------- */
  function getPlaylists() { return read(CK, []); }
  /* 一次性清理:历史导入的内置演示直播源已下线,自动移除 */
  try {
    const _old = read(CK, []);
    if (_old.some(function (x) { return x.url === '/live-demo.txt'; })) {
      write(CK, _old.filter(function (x) { return x.url !== '/live-demo.txt'; }));
    }
  } catch (e) {}
  function addPlaylist(name, url, text) {
    const list = getPlaylists();
    if (url && list.some(function (x) { return x.url === url; })) return { ok: false, msg: '该直播源已存在' };
    const id = 'live_' + Date.now().toString(36);
    list.push({ id: id, name: name || ('直播源' + (list.length + 1)), url: url || '', text: text || '' });
    write(CK, list);
    return { ok: true, id: id };
  }
  function removePlaylist(id) { write(CK, getPlaylists().filter(function (x) { return x.id !== id; })); }
  function currentPl() { return read(CUR, null); }
  function setCurrentPl(id) { write(CUR, id); }

  /* 预置直播源(已验证存活;jsdelivr 镜像在国内网络快且稳) */
  const PRESETS = [
    { name: '肥羊直播·央视卫视', url: 'https://cdn.jsdelivr.net/gh/fanmingming/live@main/tv/m3u/index.m3u' },
    { name: 'IPTV·全球台', url: 'https://iptv-org.github.io/iptv/index.m3u' },
  ];

  /* ---------- EPG(51zmt diyp 接口,当天节目单) ---------- */
  function todayStr() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  async function fetchEpg(chName) {
    if (!chName) return null;
    const key = chName + '|' + todayStr();
    const m = read(EPG_CK, {});
    if (m[key]) return m[key];
    const clean = chName.replace(/\s+/g, '');
    const url = (API.IN_APP && window.YSTV) || !API.IN_APP
      ? null : null;
    let reqUrl = 'http://epg.51zmt.top:8000/api/diyp/?ch=' + encodeURIComponent(clean) + '&date=' + todayStr();
    let text = '';
    if (location.protocol === 'file:' && window.YSTV && window.YSTV.fetchText) {
      text = window.YSTV.fetchText(reqUrl, '');
    } else {
      const r = await fetch('/proxy/' + reqUrl);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      text = await r.text();
    }
    let data = null;
    try {
      const j = JSON.parse(text);
      data = { name: j.channel_name, items: (j.epg_data || []).map(function (e) { return { start: e.start, end: e.end, title: String(e.title || '').replace(/--免费使用/g, '').trim() }; }) };
    } catch (e) { data = null; }
    m[key] = data;
    write(EPG_CK, m);
    return data;
  }
  /* 当前正在播 + 下一个 */
  function nowNext(epg) {
    if (!epg || !epg.items.length) return null;
    const now = new Date();
    const curMin = now.getHours() * 60 + now.getMinutes();
    const toMin = function (t) { const p = t.split(':'); return (+p[0]) * 60 + (+p[1]); };
    let cur = null, next = null;
    epg.items.forEach(function (it) {
      const s = toMin(it.start), e = toMin(it.end);
      if (curMin >= s && curMin < e) cur = it;
      else if (!next && s > curMin) next = it;
    });
    return { now: cur, next: next };
  }

  window.Live = {
    parsePlaylist: parsePlaylist,
    getPlaylists: getPlaylists, addPlaylist: addPlaylist, removePlaylist: removePlaylist,
    currentPl: currentPl, setCurrentPl: setCurrentPl,
    PRESETS: PRESETS,
    fetchEpg: fetchEpg, nowNext: nowNext,
  };
})();
