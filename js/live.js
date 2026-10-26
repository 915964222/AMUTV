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
  function addPlaylist(name, url, text, urls) {
    const list = getPlaylists();
    if (url && list.some(function (x) { return x.url === url; })) return { ok: false, msg: '该直播源已存在' };
    const id = 'live_' + Date.now().toString(36);
    const item = { id: id, name: name || ('直播源' + (list.length + 1)), url: url || '', text: text || '', urls: (urls && urls.length ? urls : undefined) };
    const next = list.concat([item]);
    try {
      localStorage.setItem(CK, JSON.stringify(next));   // 大源(数 MB)可能超配额,显式报错而非静默丢失
    } catch (e) {
      return { ok: false, msg: '本地存储空间不足(直播源过大),请换用较小的源' };
    }
    return { ok: true, id: id };
  }
  function removePlaylist(id) { write(CK, getPlaylists().filter(function (x) { return x.id !== id; })); }
  function currentPl() { return read(CUR, null); }
  function setCurrentPl(id) { write(CUR, id); }

  /* 预置直播源:多镜像候选(按国内可达性排序,逐个自动回退)
     全部镜像源都带 CORS 头(ACAO:*),故浏览器/App 直连兜底也可用 */
  const PRESETS = [
    { name: '肥羊直播·央视卫视', urls: [
      'https://cdn.jsdelivr.net/gh/fanmingming/live@main/tv/m3u/index.m3u',
      'https://fastly.jsdelivr.net/gh/fanmingming/live@main/tv/m3u/index.m3u',
      'https://gcore.jsdelivr.net/gh/fanmingming/live@main/tv/m3u/index.m3u',
      'https://ghproxy.net/https://raw.githubusercontent.com/fanmingming/live/main/tv/m3u/index.m3u',
      'https://gh-proxy.com/https://raw.githubusercontent.com/fanmingming/live/main/tv/m3u/index.m3u',
      'https://raw.githubusercontent.com/fanmingming/live/main/tv/m3u/index.m3u',
    ]},
    { name: 'IPTV·全球台', urls: [
      'https://iptv-org.github.io/iptv/index.m3u',
      'https://cdn.jsdelivr.net/gh/iptv-org/iptv@gh-pages/index.m3u',
      'https://ghproxy.net/https://raw.githubusercontent.com/iptv-org/iptv/gh-pages/index.m3u',
      'https://gh-proxy.com/https://raw.githubusercontent.com/iptv-org/iptv/gh-pages/index.m3u',
    ]},
  ];

  /* ---------- EPG(51zmt diyp 接口,当天节目单) ---------- */
  function todayStr() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  /* 与直播源同一套通道策略:App(file://) 用 Java 桥/本机代理,浏览器用本地 /proxy */
  async function fetchRawText(url) {
    const IN_APP = location.protocol === 'file:';
    const APP_SRV = 'http://127.0.0.1:9978';
    const viaHttp = async u => {
      const r = await fetch(u);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    };
    const tries = [];
    if (IN_APP) {
      if (window.YSTV && window.YSTV.fetchText) tries.push(async () => window.YSTV.fetchText(url, ''));
      tries.push(() => viaHttp(APP_SRV + '/proxy/' + url));
    } else {
      tries.push(() => viaHttp('/proxy/' + url));
    }
    for (const fn of tries) {
      try { const t = await fn(); if (t && String(t).trim()) return String(t); } catch (e) {}
    }
    return '';
  }

  /* ---------- XMLTV 全量节目单(e.xml,老张EPG聚合) ---------- */
  const EPGX_URL = 'http://epg.51zmt.top:8000/e.xml';
  let epgXmlIdx = null;      // {date:'YYYY-MM-DD', map:{规范频道名:[{start,end,title}]}}
  let epgXmlPending = null;  // 并发请求共享同一个 Promise
  /* 规范化:去空白/符号(直播源常写 CCTV-1,XMLTV 写 CCTV1) */
  function normCh(n) { return String(n || '').replace(/[^0-9a-zA-Z\u4e00-\u9fa5]/g, '').toUpperCase(); }
  /* 频道名候选键:全名 → 剥中文尾缀(CCTV-1 综合 → CCTV1),最长优先 */
  function chKeys(n) {
    const full = normCh(n);
    const keys = [full];
    let cur = full;
    while (/[\u4e00-\u9fa5]$/.test(cur)) {
      cur = cur.replace(/[\u4e00-\u9fa5]+$/, '');
      if (cur && keys.indexOf(cur) < 0) keys.push(cur);
    }
    return keys;
  }
  function xmlTime(v) {   // 20261026200000 +0800 → 'HH:MM'
    const m = String(v || '').match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/);
    return m ? m[4] + ':' + m[5] : '';
  }
  function ensureXmlEpg() {
    const date = todayStr();
    if (epgXmlIdx && epgXmlIdx.date === date) return Promise.resolve(epgXmlIdx);
    if (epgXmlPending) return epgXmlPending;
    epgXmlPending = (async function () {
      /* 上游偶发 502,重试 3 次 */
      let text = '';
      for (let i = 0; i < 3 && !text; i++) {
        text = await fetchRawText(EPGX_URL);
        if (!text) await new Promise(function (rs) { setTimeout(rs, 1200); });
      }
      if (!text) return null;
      const doc = new DOMParser().parseFromString(text, 'text/xml');
      if (!doc || !doc.querySelector('programme')) return null;
      const today = date.replace(/-/g, '');
      const nameById = {};
      Array.prototype.forEach.call(doc.querySelectorAll('channel'), function (ch) {
        const id = ch.getAttribute('id');
        const dn = ch.querySelector('display-name');
        if (id && dn) nameById[id] = dn.textContent.trim();
      });
      const map = {};
      const put = function (k, it) { if (k) (map[k] = map[k] || []).push(it); };
      Array.prototype.forEach.call(doc.querySelectorAll('programme'), function (p) {
        const st = String(p.getAttribute('start') || '');
        if (st.slice(0, 8) !== today) return;              // 只留当天,避免跨天污染分钟比较
        const nm = nameById[p.getAttribute('channel')];
        if (!nm) return;
        const tEl = p.querySelector('title');
        const it = {
          start: xmlTime(st), end: xmlTime(p.getAttribute('stop')),
          title: String(tEl ? tEl.textContent : '').replace(/--免费使用/g, '').trim(),
        };
        const ks = chKeys(nm);
        put(ks[0], it);                                    // 全名与剥尾缀键都索引,双向可命中
        if (ks[1]) put(ks[1], it);
      });
      epgXmlIdx = { date: date, map: map };
      return epgXmlIdx;
    })().catch(function () { return null; }).then(function (r) { epgXmlPending = null; return r; });
    return epgXmlPending;
  }

  async function fetchEpg(chName) {
    if (!chName) return null;
    const key = chName + '|' + todayStr();
    const m = read(EPG_CK, {});
    if (m[key] !== undefined) return m[key];
    let data = null;
    try {
      const idx = await ensureXmlEpg();
      if (idx && idx.map) {
        let items = null;
        const ks = chKeys(chName);
        for (const k of ks) { if (idx.map[k]) { items = idx.map[k]; break; } }
        if (items && items.length) data = { name: chName, items: items };
      }
    } catch (e) {}
    if (!data) {
      const clean = chName.replace(/\s+/g, '');
      const reqUrl = 'http://epg.51zmt.top:8000/api/diyp/?ch=' + encodeURIComponent(clean) + '&date=' + todayStr();
      const text = await fetchRawText(reqUrl);
      try {
      const j = JSON.parse(text);
      data = { name: j.channel_name, items: (j.epg_data || []).map(function (e) { return { start: e.start, end: e.end, title: String(e.title || '').replace(/--免费使用/g, '').trim() }; }) };
      } catch (e) { data = null; }
    }
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

  /* ---------- 回看(catchup):按各源模板把起止时间拼进播放地址 ---------- */
  function ts(t, date) {   // 'HH:MM' + 当天 → YYYYMMDDHHMMSS
    const d = date || new Date();
    const p = String(t).split(':');
    const pad = n => String(n).padStart(2, '0');
    return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + pad(+p[0]) + pad(+p[1]) + '00';
  }
  function catchupUrl(base, startHM, endHM) {
    const s = ts(startHM), e = ts(endHM);
    const u = String(base || '');
    const join = u.indexOf('?') >= 0 ? '&' : '?';
    /* 覆盖常见 IPTV catchup 参数风格 */
    return u + join + 'playseek=' + s + '-' + e;
  }

  /* ---------- 预约提醒:持久化存储 + 打开直播页时轮询触发 ---------- */
  const RM_CK = 'tvw_live_reminders';
  function getReminders() { return read(RM_CK, []); }
  function addReminder(item) {   // {chName, groupName, title, start, fireAt(ms)}
    const list = getReminders().filter(x => !(x.chName === item.chName && x.start === item.start));
    list.push(item);
    write(RM_CK, list);
    return true;
  }
  function removeReminder(chName, start) { write(RM_CK, getReminders().filter(x => !(x.chName === chName && x.start === start))); }
  function hasReminder(chName, start) { return getReminders().some(x => x.chName === chName && x.start === start); }
  let rmTimer = null;
  function startReminderLoop(onFire) {
    clearInterval(rmTimer);
    rmTimer = setInterval(function () {
      const now = Date.now();
      let list = getReminders();
      const due = list.filter(x => now >= x.fireAt && now - x.fireAt < 30 * 60000);  // 错过超30分钟不再提示
      if (!due.length) return;
      list = list.filter(x => !(now >= x.fireAt && now - x.fireAt < 30 * 60000));
      write(RM_CK, list);
      due.forEach(x => { try { onFire && onFire(x); } catch (e) {} });
    }, 20000);
  }

  window.Live = {
    parsePlaylist: parsePlaylist,
    getPlaylists: getPlaylists, addPlaylist: addPlaylist, removePlaylist: removePlaylist,
    currentPl: currentPl, setCurrentPl: setCurrentPl,
    PRESETS: PRESETS,
    fetchEpg: fetchEpg, nowNext: nowNext,
    catchupUrl: catchupUrl,
    getReminders: getReminders, addReminder: addReminder, removeReminder: removeReminder, hasReminder: hasReminder,
    startReminderLoop: startReminderLoop,
  };
})();
