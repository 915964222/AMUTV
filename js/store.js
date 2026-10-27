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

  /* 全应用**唯一内置源**:爱奇艺资源。builtIn=true 的源在列表里不显示删除按钮,
     老安装升级会自动补齐(用户删过则记 tvw_iqiyi_removed,不再加回)。 */

  /* 预设 1080P 源(仅「保留」,不算内置——可删、可不用,删了也不会自动加回)
     2026-10-27 实测:接口连通 + 拉到 m3u8 + 解析 H.264 SPS 校验真实分辨率
     + 逐切片扫描确认无广告插入)
     四个都是**独立后端**,不是同一家的镜像线路(此前 from/hash、from/other 属 ffzy 同源,已弃用)。
       ffzy  非凡资源   SPS 1920x1088  广告 0
       dytt  电影天堂   SPS 1920x1088  广告 0(抽检 3 部)
       tyys  天涯资源   SPS 1920x1080  广告 0(抽检 3 部)
       hhzy  豪华资源   播放实测 1080P   广告 0(抽检 3 部)
     ⚠ 已剔除暴风(bfzyapi):分辨率达标但正片混插 9 个 /video/adjump/time/ 广告切片,
       按「有广告的资源不加」原则不进内置(播放时过滤器仍会剪,但源本身不再内置)。
     其他已剔除:红牛(1080 未证实且 20~75s 超时)、旺旺/卧龙/速播(超时或非标准 JSON)、
               优质(502)、闪电(486 高)、lzi(清单标 1080x608,实测 916x466=伪 1080)。 */
  const PRESET_1080 = [
    { id: 'ffzy', name: '非凡资源(1080P)', api: 'https://api.ffzyapi.com/api.php/provide/vod/' },
    { id: 'dytt', name: '电影天堂(1080P)', api: 'http://caiji.dyttzyapi.com/api.php/provide/vod/' },
    { id: 'tyys', name: '天涯资源(1080P)', api: 'https://tyyszy.com/api.php/provide/vod/' },
    { id: 'hhzy', name: '豪华资源(1080P)', api: 'https://hhzyapi.com/api.php/provide/vod/' },
  ];
  const PRESET_API = PRESET_1080.map(x => x.api);
  /* 首次启动的源列表:爱奇艺(内置不可删) + 4 个 1080P 预设(普通源,可删) */
  const DEFAULT_SOURCES = [
    { id: 'iqiyi', name: '爱奇艺资源(内置)', api: IQIYI_API, builtIn: true },
    ...PRESET_1080.map(x => ({ ...x, builtIn: false, tag: '1080P' })),
  ];

  /* 用户手动删过的预设 1080P 源,不再自动加回(可在设置页一键恢复)
     兼容旧键 tvw_builtin1080_removed(上一版把这批源当内置时记录的删除) */
  const removedSet = () => {
    try {
      const now = JSON.parse(localStorage.getItem('tvw_preset1080_removed') || '[]');
      const old = JSON.parse(localStorage.getItem('tvw_builtin1080_removed') || '[]');
      return Array.from(new Set([].concat(now, old)));
    } catch { return []; }
  };
  const markRemoved = (api) => {
    try {
      const a = removedSet();
      if (!a.includes(api)) { a.push(api); localStorage.setItem('tvw_preset1080_removed', JSON.stringify(a)); }
    } catch {}
  };

  /* 明确带广告、不允许出现在源库里的采集站(按接口匹配)。
     命中即从源列表移除并记入「已移除」,避免升级后被旧数据/恢复操作带回来。
     2026-10-27:暴风 bfzyapi 正片混插 /video/adjump/time/ 广告切片(9 条/部) */
  const AD_SOURCE_BLOCK = ['https://bfzyapi.com/api.php/provide/vod/'];

  /* 预设 1080P 源同步:
     ① 清掉带广告的源;② 缺失的补上(用户删过的不补);③ 早期版本误标成内置的降级为普通源 */
  function ensurePreset1080(list) {
    let dirty = false;
    const rm = removedSet();
    /* 先清掉带广告的源(含早前被标成内置的) */
    for (let i = list.length - 1; i >= 0; i--) {
      if (AD_SOURCE_BLOCK.includes(list[i].api)) {
        const bad = list[i].api;
        list.splice(i, 1); dirty = true; markRemoved(bad);
      }
    }
    AD_SOURCE_BLOCK.forEach(api => { if (!rm.includes(api)) markRemoved(api); });
    PRESET_1080.forEach(b => {
      const same = list.find(x => x.api === b.api);
      if (same) {
        /* 以前把这批源做成了「内置」(不给删除按钮),现在只做保留 → 降级为普通源 */
        if (same.builtIn || same.tag !== '1080P') {
          same.builtIn = false; same.tag = '1080P';
          if (!same.name) same.name = b.name;
          dirty = true;
        }
      } else if (!rm.includes(b.api)) {
        list.push({ ...b, builtIn: false, tag: '1080P' });
        dirty = true;
      }
    });
    if (dirty) write(KEY.srcs, list);
    return list;
  }

  function getSources() {
    const s = read(KEY.srcs, null);
    if (!s) {
      const def = DEFAULT_SOURCES.map(x => ({ ...x }));
      write(KEY.srcs, def);
      return def;
    }
    /* 老安装清理:移除已下线的内置演示源,当前源若是演示源则切到爱奇艺 */
    try {
      if (s.some(x => x.id === 'demo')) {
        const next = s.filter(x => x.id !== 'demo');
        write(KEY.srcs, next);
        if (getCurrentSourceId() === 'demo') setCurrentSourceId(next[0] ? next[0].id : '');
        return ensurePreset1080(next);
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
    return ensurePreset1080(s);
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
    /* 用户手动删掉预设 1080P 源 → 记一笔,以后不再自动加回 */
    if (t && PRESET_API.includes(t.api)) markRemoved(t.api);
    if (getCurrentSourceId() === id) setCurrentSourceId(next[0] ? next[0].id : '');
    return { ok: true };
  }
  /* 恢复预设 1080P 源(用户删过也能一键补回);返回 {added, total} */
  function restorePreset1080() {
    /* 先量一次(app 此时删除记录还在,不会自动补) */
    const before = getSources().length;
    try {
      localStorage.removeItem('tvw_preset1080_removed');
      localStorage.removeItem('tvw_builtin1080_removed');
    } catch (e) {}
    const after = getSources();          // 清掉记录后由 ensurePreset1080 补齐
    return { added: Math.max(0, after.length - before), total: PRESET_1080.length };
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
    restorePreset1080, PRESET_1080,
    getCurrentSource, getCurrentSourceId, setCurrentSourceId,
    getRepos, addRepo, removeRepo,
    getDrives, addDrive, removeDrive, driveAuth,
    getMarks, getMark, setMark, clearMark,
    getFavs, isFav, toggleFav, removeFav, clearFavs,
    getHistory, getHist, saveHist, updateProgress, removeHist, clearHistory,
    getConfig, setConfig,
  };
})();
