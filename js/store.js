/* ================= 本地数据层:收藏 / 历史 / 源配置 ================= */
const DB = (() => {
  const KEY = {
    fav: 'tvw_favs',
    hist: 'tvw_history',
    srcs: 'tvw_sources',
    cur: 'tvw_current_source',
    cfg: 'tvw_config',
    repos: 'tvw_repos',
    drives: 'tvw_drives',
    marks: 'tvw_marks',
  };

  const read = (k, def) => {
    try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; }
    catch { return def; }
  };
  const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

  /* ---------- 源列表 ---------- */
  const IQIYI_API = 'https://iqiyizyapi.com/api.php/provide/vod';
  const DEFAULT_SOURCES = [
    { id: 'iqiyi', name: '爱奇艺资源(内置)', api: IQIYI_API, builtIn: true },
  ];

  function getSources() {
    const s = read(KEY.srcs, null);
    if (!s) { write(KEY.srcs, DEFAULT_SOURCES); return [...DEFAULT_SOURCES]; }
    /* 老安装清理:移除已下线的内置演示源,当前源若是演示源则切到爱奇艺 */
    try {
      if (s.some(x => x.id === 'demo')) {
        const next = s.filter(x => x.id !== 'demo');
        write(KEY.srcs, next);
        if (getCurrentSourceId() === 'demo') setCurrentSourceId(next[0] ? next[0].id : '');
        return next;
      }
    } catch (e) {}
    /* 已有存量的老安装:补上内置爱奇艺源(用户手动删过则不再加回) */
    try {
      if (s.some(x => x.api === IQIYI_API)) {
        if (!s.some(x => x.id === 'iqiyi' && x.builtIn)) {
          // 老版本添加的普通源升级为内置源
          const t = s.find(x => x.api === IQIYI_API);
          t.builtIn = true; t.name = '爱奇艺资源(内置)'; write(KEY.srcs, s);
        }
      } else if (!localStorage.getItem('tvw_iqiyi_removed')) {
        s.push({ id: 'iqiyi', name: '爱奇艺资源(内置)', api: IQIYI_API, builtIn: true });
        write(KEY.srcs, s);
      }
    } catch (e) {}
    return s;
  }
  function saveSources(list) { write(KEY.srcs, list); }
  function addSource(name, api, meta) {
    const list = getSources();
    const same = list.find(x => x.api === api);
    if (same) return { ok: false, msg: '该接口已存在:' + same.name };
    const id = 'src_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    list.push({ id, name: name || ('源' + (list.length)), api, builtIn: false, ...(meta || {}) });
    saveSources(list);
    return { ok: true, id };
  }
  function removeSource(id) {
    const list = getSources();
    const t = list.find(x => x.id === id);
    const next = list.filter(x => x.id !== id);
    saveSources(next);
    if (t && t.api === IQIYI_API) { try { localStorage.setItem('tvw_iqiyi_removed', '1'); } catch (e) {} }
    if (getCurrentSourceId() === id) setCurrentSourceId(next[0] ? next[0].id : '');
    return { ok: true };
  }
  function removeSourcesByOrigin(originId) {
    const list = getSources().filter(x => x.originId !== originId || x.builtIn);
    saveSources(list);
    if (!list.find(x => x.id === getCurrentSourceId())) setCurrentSourceId(list[0] ? list[0].id : '');
  }

  /* ---------- 仓库订阅(单仓/多仓配置) ---------- */
  function getRepos() { return read(KEY.repos, []); }
  function addRepo(name, url) {
    const list = getRepos();
    const same = list.find(x => x.url === url);
    if (same) return { ok: false, msg: '该仓库已订阅:' + same.name };
    const id = 'repo_' + Date.now().toString(36);
    list.push({ id, name: name || ('仓' + (list.length + 1)), url, ts: Date.now() });
    write(KEY.repos, list);
    return { ok: true, id };
  }
  function removeRepo(id) {
    write(KEY.repos, getRepos().filter(x => x.id !== id));
    removeSourcesByOrigin(id);
  }

  /* ---------- 网盘挂载 ---------- */
  function getDrives() { return read(KEY.drives, []); }
  function addDrive(name, url, user, pass, type) {
    const list = getDrives();
    const same = list.find(x => x.url === url);
    if (same) return { ok: false, msg: '该网盘已挂载:' + same.name };
    const id = 'drv_' + Date.now().toString(36);
    list.push({ id, name: name || ((type === 'alist' ? 'Alist' : 'WebDAV') + (list.length + 1)), url, user: user || '', pass: pass || '', type: type || 'webdav' });
    write(KEY.drives, list);
    return { ok: true, id };
  }
  function removeDrive(id) {
    write(KEY.drives, getDrives().filter(x => x.id !== id));
  }
  function driveAuth(drive) {
    if (!drive) return '';
    if (drive.type === 'alist') return (drive.user || '').replace(/^token:/, '');
    return drive.user ? drive.user + ':' + (drive.pass || '') : '';
  }
  function getCurrentSource() {
    const id = read(KEY.cur, '');
    const list = getSources();
    return list.find(x => x.id === id) || list[0] || null;
  }
  function getCurrentSourceId() { return read(KEY.cur, ''); }
  function setCurrentSourceId(id) { write(KEY.cur, id); }

  /* ---------- 收藏 ---------- */
  function getFavs() { return read(KEY.fav, []); }
  function isFav(key) { return getFavs().some(x => x.key === key); }
  function toggleFav(item) {
    let list = getFavs();
    if (list.some(x => x.key === item.key)) {
      list = list.filter(x => x.key !== item.key);
      write(KEY.fav, list);
      return false;
    }
    list.unshift({ ...item, ts: Date.now() });
    write(KEY.fav, list);
    return true;
  }
  function removeFav(key) {
    write(KEY.fav, getFavs().filter(x => x.key !== key));
  }
  function clearFavs() { write(KEY.fav, []); }

  /* ---------- 历史(断点续播) ---------- */
  function getHistory() { return read(KEY.hist, []); }
  function getHist(key) { return getHistory().find(x => x.key === key) || null; }
  function saveHist(entry) {
    let list = getHistory().filter(x => x.key !== entry.key);
    list.unshift({ ...entry, ts: Date.now() });
    if (list.length > 100) list.length = 100;
    write(KEY.hist, list);
  }
  function updateProgress(key, epIndex, position, duration) {
    const h = getHist(key);
    if (!h) return;
    h.epIndex = epIndex;
    h.position = position;
    h.duration = duration;
    h.ts = Date.now();
    saveHist(h);
  }
  function removeHist(key) { write(KEY.hist, getHistory().filter(x => x.key !== key)); }
  function clearHistory() { write(KEY.hist, []); }

  /* ---------- 设置 ---------- */
  function getConfig() {
    return read(KEY.cfg, { proxyMode: true, multiSearch: 6, displayCache: false, autoSwitch: true, skipIntroAuto: true, defaultIntroSec: 90, adFilter: true, sniffAuto: true, scrapeOn: true, kernel: 'auto', decodeMode: 'hw', autoKeyboard: true, preferQuality: '1080' });
  }

  /* ---------- 片头/片尾标记(按影片) ---------- */
  function getMarks() { return read(KEY.marks, {}); }
  function getMark(key) { return getMarks()[key] || null; }
  function setMark(key, patch) {
    const m = getMarks();
    m[key] = Object.assign({}, m[key] || {}, patch);
    write(KEY.marks, m);
    return m[key];
  }
  function clearMark(key, which) {
    const m = getMarks();
    if (m[key]) { delete m[key][which]; if (!Object.keys(m[key]).length) delete m[key]; }
    write(KEY.marks, m);
  }
  function setConfig(patch) {
    const c = { ...getConfig(), ...patch };
    write(KEY.cfg, c);
    return c;
  }

  return {
    getSources, saveSources, addSource, removeSource, removeSourcesByOrigin,
    getCurrentSource, getCurrentSourceId, setCurrentSourceId,
    getRepos, addRepo, removeRepo,
    getDrives, addDrive, removeDrive, driveAuth,
    getMarks, getMark, setMark, clearMark,
    getFavs, isFav, toggleFav, removeFav, clearFavs,
    getHistory, getHist, saveHist, updateProgress, removeHist, clearHistory,
    getConfig, setConfig,
  };
})();
